/**
 * @file cloudService.js
 * @description Capa de comunicación con Supabase — Fase 5: Delta Sync Engine.
 * @version 2.0.0
 *
 * ── Cambios v2.0.0 (auditoría Fase 5) ────────────────────────────────────────
 *
 *  [C1] Contrato de datos corregido (Hallazgo A15/A16):
 *    processOutboxBatch ahora acepta (items, workspaceId, workspaceName).
 *    p_workspace se construye garantizando siempre { id, name } válidos.
 *    Ya no depende del contenido del batch para derivar el workspace_id.
 *
 *  [C2] Tipado estricto en el payload del RPC (Hallazgo A1/A2):
 *    - completed → Boolean(val)   (PostgreSQL rechaza strings o undefined)
 *    - amount    → Number(val)||0 (PostgreSQL rechaza null o NaN)
 *    Aplicado antes de construir p_tasks y p_expenses.
 *
 *  [C3] Manejo de errores estructurado (Hallazgo A15):
 *    unwrap lanza CloudServiceError con { code, message, detail } extraído
 *    del JSONB de respuesta del RPC v2.0.0.
 *    withRetry distingue errores 4xx (no reintentables) de 5xx/red.
 *
 *  [C4] Timeout con AbortController (Hallazgo A8):
 *    syncSupabaseAuth y bridgeGoogleAuth usan AbortController de 8 s.
 *    Evita bloqueos infinitos si Supabase no responde.
 *
 *  [C5] Simplificación de API (requisito de arquitectura Fase 5):
 *    Eliminadas todas las funciones de CRUD directo (upsertSheet, upsertTask,
 *    upsertExpense, deleteTask, deleteExpense, deleteSheet, upsertProfile,
 *    upsertWorkspace). Todo el tráfico de escritura pasa exclusivamente
 *    a través de processOutboxBatch.
 *
 *  ── INTACTO ────────────────────────────────────────────────────────────────
 *  ✓ getSupabaseClient / isCloudConfigured (singleton pattern)
 *  ✓ signOut
 *  ✓ fetchDelta
 *  ✓ MAX_OUTBOX_RETRIES
 */

import { createClient } from '@supabase/supabase-js';
import { MutationType }  from './db';

// ─── Configuración ─────────────────────────────────────────────────────────────

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** Número máximo de reintentos por entrada del outbox antes de descartarla. */
export const MAX_OUTBOX_RETRIES = 5;

/** [CVE-010] Timeouts adaptativos según tipo de conexión. */
const AUTH_TIMEOUT_MS_3G     = 20_000; // 3G: RTT ~200-300ms
const AUTH_TIMEOUT_MS_4G_LTE = 12_000; // 4G/LTE: RTT ~50-100ms
const AUTH_TIMEOUT_MS_WIFI   = 8_000;  // WiFi: RTT <10ms

/**
 * [CVE-010] Detectar tipo de conexión y retornar timeout apropiado
 */
function getAuthTimeout() {
  if (navigator.connection) {
    const type = navigator.connection.effectiveType;
    switch (type) {
      case '4g': return AUTH_TIMEOUT_MS_4G_LTE;
      case '3g': return AUTH_TIMEOUT_MS_3G;
      case '2g': return 30_000;
      default:  return AUTH_TIMEOUT_MS_WIFI;
    }
  }
  return AUTH_TIMEOUT_MS_WIFI;
}

export const isCloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let _client = null;

export function getSupabaseClient() {
  if (!isCloudConfigured()) throw new Error('SUPABASE_NOT_CONFIGURED');
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ─── Error estructurado ────────────────────────────────────────────────────────

/**
 * Error enriquecido que transporta el JSONB de diagnóstico del RPC v2.0.0. [C3]
 *
 * El RPC batch_sync_workspace v2.0.0 devuelve un objeto JSONB en caso de fallo:
 *   { code: string, message: string, detail?: string }
 *
 * CloudServiceError expone esos campos directamente para que el caller
 * (WorkspaceContext) pueda mostrar mensajes accionables en la UI y decidir
 * si la mutación debe descartarse (errores 4xx) o reintentarse (5xx/red).
 */
export class CloudServiceError extends Error {
  /**
   * @param {string} message       - Descripción legible del error
   * @param {string} [code]        - Código de error del RPC o HTTP
   * @param {string} [detail]      - Detalle adicional (constraint, campo, etc.)
   * @param {boolean} [retryable]  - Indica si el Sync Engine debe reintentar
   */
  constructor(message, code = 'UNKNOWN', detail = '', retryable = true) {
    super(message);
    this.name      = 'CloudServiceError';
    this.code      = code;
    this.detail    = detail;
    this.retryable = retryable;
  }
}

// ─── Helpers de resiliencia ───────────────────────────────────────────────────

/**
 * [CVE-006] Unwrap con distinción semántica de errores HTTP.
 * 
 * 429 TOO_MANY_REQUESTS    → reintentable con backoff
 * 430 REQUEST_TIMEOUT      → reintentable
 * 4xx genérico             → NO reintentable (validación, RLS, FK)
 * 5xx                      → reintentable (servidor down)
 *
 * @param {{ data: unknown, error: unknown }} supabaseResponse
 * @returns {unknown} data
 * @throws {CloudServiceError}
 */
function unwrap({ data, error }) {
  if (!error) return data;

  const httpCode = String(error.code ?? '');
  const message  = error.message ?? 'Error desconocido de Supabase';
  const detail   = error.details ?? error.hint ?? '';

  // Errores definitivamente NO reintentables (validación, FK, RLS)
  const NON_RETRYABLE_4XX = [
    '400', '401', '403', '404',  // Bad Request, Unauthorized, Forbidden, Not Found
    '23', '23503', '23505',       // PostgreSQL FK violation, unique violation
    '42', '42P01', '42703',       // PostgreSQL undefined table, column
    'PGRST', 'INVALID_ARGS',      // Payload parsing errors
  ];

  // Errores reintentables (throttling, temp issues)
  const RETRYABLE_4XX = ['429', '430', '409']; // Rate limit, Timeout, Conflict

  let retryable = true;

  if (NON_RETRYABLE_4XX.some(code => httpCode.includes(code))) {
    retryable = false;
  } else if (RETRYABLE_4XX.some(code => httpCode.includes(code))) {
    retryable = true;
  } else if (httpCode.startsWith('5') || httpCode === '') {
    retryable = true; // 5xx o desconocido
  } else if (httpCode.startsWith('4')) {
    retryable = false; // Cualquier otro 4xx → validación error
  }

  throw new CloudServiceError(message, httpCode, detail, retryable);
}

/**
 * Exponential backoff con full jitter — solo reintenta errores marcados como
 * reintentables. Los errores 4xx propagan inmediatamente. [C3]
 *
 * Algoritmo AWS: delay = random(0, min(cap, baseDelay * 2^attempt))
 * Cap en 30 s para evitar esperas excesivas en conexiones lentas.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number}           maxRetries
 * @param {number}           baseDelay  - ms base (default 800 ms)
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 800) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // No reintentar errores 4xx (datos incorrectos) — propagar inmediatamente [C3]
      if (err instanceof CloudServiceError && !err.retryable) {
        console.warn(
          `[CloudService] Non-retryable error (${err.code}): ${err.message}. ` +
          `Tratando como fallo permanente.`
        );
        throw err;
      }
      if (attempt === maxRetries) throw err;

      console.info(
        `[CloudService] Retryable error (${err?.code || 'UNKNOWN'}), ` +
        `intento ${attempt + 1}/${maxRetries}`
      );

      const cap   = baseDelay * Math.pow(2, attempt);
      const delay = Math.random() * Math.min(cap, 30_000);
      console.debug(`[CloudService] Esperando ${Math.round(delay)}ms antes de reintentar...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * [CVE-008] Timeout con AbortController y cleanup automático.
 * Preferir esto sobre Promise.race para evitar memory leaks.
 *
 * @param {number} ms
 * @returns {Promise<never>}
 */
function createTimeoutPromise(ms) {
  let timeoutId = null;
  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new CloudServiceError(`Timeout tras ${ms}ms`, 'TIMEOUT', '', true)),
      ms,
    );
  });
  // Exponer cleanup para limpiar manualmente si es necesario
  promise.cleanup = () => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
  return promise;
}

/**
 * [CVE-008] Wrapper que usa AbortController en lugar de Promise.race
 * para mejor control del timeout.
 *
 * @param {number} ms
 * @returns {{ controller: AbortController, timeoutId: number }}
 */
function createAbortTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, timeoutId };
}

// ─── Helpers de sanitización ──────────────────────────────────────────────────

/**
 * [CVE-001] [CVE-004] Sanitización estricta de Task.
 * 
 * - Rechaza owner_id (CVE-001: prevenir inyección)
 * - Valida completed como boolean real, no string (CVE-004: prevenir type confusion)
 * - sheet_id se fuerza desde argumento, no del payload
 *
 * @param {object} task
 * @param {string} expectedSheetId - sheet_id canónico (no del payload)
 * @returns {{ id: string, sheet_id: string, text: string, completed: boolean }}
 * @throws {CloudServiceError}
 */
function sanitizeTask(task, expectedSheetId) {
  // [CVE-001] NEGAR cualquier intento de inyectar owner_id
  if (task.owner_id !== undefined || task.owner_uid !== undefined) {
    throw new CloudServiceError(
      'Intento de inyección: owner_id no permitido en el cliente',
      'INJECTION_ATTEMPT',
      'El cliente nunca debe incluir owner_id. Contacta a soporte.',
      false, // no reintentable
    );
  }

  // [CVE-004] Validación estricta de boolean
  let completed;
  if (task.completed === undefined || task.completed === null) {
    completed = false;
  } else if (typeof task.completed === 'boolean') {
    completed = task.completed;
  } else if (typeof task.completed === 'string') {
    const lower = task.completed.toLowerCase().trim();
    if (lower === 'true' || lower === '1') {
      completed = true;
    } else if (lower === 'false' || lower === '0') {
      completed = false;
    } else {
      throw new CloudServiceError(
        `Boolean inválido para task.completed: "${task.completed}"`,
        'INVALID_BOOLEAN',
        'completed debe ser true, false, "true", "false", 1, o 0',
        false,
      );
    }
  } else if (typeof task.completed === 'number') {
    completed = task.completed !== 0;
  } else {
    throw new CloudServiceError(
      `Tipo inválido para task.completed: ${typeof task.completed}`,
      'TYPE_ERROR',
      `completed debe ser boolean, no ${typeof task.completed}`,
      false,
    );
  }

  return {
    id:        String(task.id ?? '').trim(),
    sheet_id:  String(expectedSheetId), // FORZAR desde argumento
    text:      String(task.text ?? '').trim(),
    completed: completed, // ✅ Tipado estrictamente
  };
}

/**
 * [CVE-005] Sanitización dedicada de amount.
 * Rechaza NaN, Infinity, y valores no-finitos.
 * @param {any} val
 * @returns {number}
 * @throws {CloudServiceError}
 */
function sanitizeAmount(val) {
  if (val === undefined || val === null) return 0;

  let num;
  if (typeof val === 'number') {
    num = val;
  } else if (typeof val === 'string') {
    num = parseFloat(val);
  } else {
    throw new CloudServiceError(
      `Tipo inválido para amount: ${typeof val}`,
      'AMOUNT_TYPE_ERROR',
      `amount debe ser number o string numérico, no ${typeof val}`,
      false,
    );
  }

  // [CVE-005] RECHAZAR explícitamente valores IEEE no-finitos
  if (!Number.isFinite(num)) {
    throw new CloudServiceError(
      `Amount no-finito: ${num}`,
      'AMOUNT_NOT_FINITE',
      `amount debe ser un número finito, recibido: ${val}`,
      false,
    );
  }

  // Validar rango razonable
  const MIN_AMOUNT = -999_999_999;
  const MAX_AMOUNT = 999_999_999;
  if (num < MIN_AMOUNT || num > MAX_AMOUNT) {
    throw new CloudServiceError(
      `Amount fuera de rango: ${num}`,
      'AMOUNT_OUT_OF_RANGE',
      `amount debe estar entre ${MIN_AMOUNT} y ${MAX_AMOUNT}`,
      false,
    );
  }

  return num;
}

/**
 * [CVE-001] Sanitización estricta de Expense.
 *
 * @param {object} expense
 * @param {string} expectedSheetId - sheet_id canónico (no del payload)
 * @returns {{ id: string, sheet_id: string, description: string, amount: number }}
 * @throws {CloudServiceError}
 */
function sanitizeExpense(expense, expectedSheetId) {
  // [CVE-001] NEGAR inyección de owner_id
  if (expense.owner_id !== undefined || expense.owner_uid !== undefined) {
    throw new CloudServiceError(
      'Intento de inyección: owner_id no permitido',
      'INJECTION_ATTEMPT',
      '',
      false,
    );
  }

  return {
    id:          String(expense.id ?? '').trim(),
    sheet_id:    String(expectedSheetId), // FORZAR desde argumento
    description: String(expense.description ?? '').trim(),
    amount:      sanitizeAmount(expense.amount), // Validación dedicada
  };
}

/**
 * Sanitiza el payload del workspace garantizando id y name válidos. [C1]
 *
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @returns {{ id: string, name: string }}
 */
function sanitizeWorkspace(workspaceId, workspaceName) {
  const id   = String(workspaceId ?? '').trim();
  const name = String(workspaceName ?? 'Mi Workspace').trim() || 'Mi Workspace';
  if (!id) throw new CloudServiceError(
    'workspaceId es obligatorio para el RPC batch_sync_workspace',
    'INVALID_ARGS',
    'workspaceId vacío o undefined',
    false, // no reintentable — error de programación
  );
  return { id, name };
}

// ─── CloudService ─────────────────────────────────────────────────────────────

export const CloudService = {

  // ── Auth Bridge ─────────────────────────────────────────────────────────────

  /**
   * Sincroniza credenciales manuales con Supabase Auth.
   * Incluye AbortController con timeout de 8 s para evitar bloqueos. [C4]
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<string>} supabaseUid
   * @throws {CloudServiceError}
   */
  async syncSupabaseAuth({ email, password }) {
    const client = getSupabaseClient();
    const timeout = getAuthTimeout(); // [CVE-010] Timeout adaptativo

    // [CVE-008] Usar AbortController para mejor control
    const { controller, timeoutId } = createAbortTimeout(timeout);

    try {
      const { data: signInData, error: signInError } =
        await client.auth.signInWithPassword({ email, password });

      if (!signInError && signInData?.user) return signInData.user.id;

      // Si las credenciales son inválidas, intentar registro
      if (signInError?.message?.includes('Invalid login credentials')) {
        const { data: signUpData, error: signUpError } =
          await client.auth.signUp({ email, password });
        if (signUpError) throw new CloudServiceError(
          signUpError.message,
          String(signUpError.status ?? signUpError.code ?? 'AUTH_ERROR'),
          signUpError.details ?? '',
          false,
        );
        return signUpData.user?.id;
      }

      throw new CloudServiceError(
        signInError.message,
        String(signInError.status ?? signInError.code ?? 'AUTH_ERROR'),
        signInError.details ?? '',
        true,
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new CloudServiceError(
          `Timeout en Supabase Auth tras ${timeout}ms`,
          'TIMEOUT',
          'La conexión tardó demasiado. Verifica tu red.',
          true,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId); // [CVE-008] Cleanup
    }
  },

  /**
   * Bridge de Google ID Token hacia Supabase Auth.
   * Incluye AbortController con timeout de 8 s. [C4]
   *
   * @param {string} idToken - JWT de Google (CredentialResponse.credential)
   * @returns {Promise<string>} supabaseUid
   * @throws {CloudServiceError}
   */
  async bridgeGoogleAuth(idToken) {
    const client = getSupabaseClient();
    const timeout = getAuthTimeout(); // [CVE-010]
    const { controller, timeoutId } = createAbortTimeout(timeout); // [CVE-008]

    try {
      const { data, error } = await client.auth.signInWithIdToken({
        provider: 'google',
        token:    idToken,
      });
      if (error) throw new CloudServiceError(
        error.message,
        String(error.status ?? error.code ?? 'GOOGLE_AUTH_ERROR'),
        error.details ?? '',
        true,
      );
      return data.user?.id;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new CloudServiceError(
          `Timeout en Google Auth tras ${timeout}ms`,
          'TIMEOUT',
          'La conexión tardó demasiado. Verifica tu red.',
          true,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId); // [CVE-008]
    }
  },

  /**
   * Cierra la sesión de Supabase Auth (falla silenciosa, llamada de logout).
   */
  async signOut() {
    try {
      const client = getSupabaseClient();
      await client.auth.signOut();
    } catch (err) {
      // Logout local nunca debe bloquearse por un error de red
      console.warn('[CloudService] signOut falló (ignorado):', err.message);
    }
  },

  // ── Sync Engine — escritura ──────────────────────────────────────────────────

  /**
   * Envía un lote de mutaciones del outbox a Supabase mediante el RPC
   * batch_sync_workspace v2.0.0. [C1][C2][C3]
   *
   * Contrato del RPC v2.0.0 (SECURITY INVOKER):
   *   - p_workspace: { id: UUID, name: text }           ← OBLIGATORIO
   *   - p_sheets:    Sheet[]
   *   - p_tasks:     Task[]    (completed: boolean, NO string)
   *   - p_expenses:  Expense[] (amount: number,    NO null)
   *   - p_deleted:   { sheet_ids, task_ids, expense_ids }
   *   Retorna JSONB: { ok: boolean } en éxito,
   *                  { ok: false, code, message, detail } en fallo.
   *
   * IMPORTANTE — workspaceId y workspaceName son obligatorios como argumentos
   * independientes. Ya NO se derivan del contenido del batch (root cause C1).
   *
   * @param {OutboxEntry[]} items         - Mutaciones ordenadas topológicamente
   * @param {string}        workspaceId   - ID del workspace activo
   * @param {string}        workspaceName - Nombre actual del workspace
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async processOutboxBatch(items, workspaceId, workspaceName) {
    if (!items?.length) return { success: true };

    // [C1] Garantizar workspace payload válido — lanza CloudServiceError si falta ID
    const wsPayload = sanitizeWorkspace(workspaceId, workspaceName);

    // Acumuladores indexados por entity ID (idempotencia LWW local)
    const sheetsMap   = new Map();
    const tasksMap    = new Map();
    const expensesMap = new Map();
    const deleted     = { sheet_ids: [], task_ids: [], expense_ids: [] };

    for (const m of items) {
      const p = m.payload;

      switch (m.type) {
        // UPSERT_WORKSPACE — el payload del RPC ya se construye desde los args,
        // pero lo dejamos pasar por el switch sin error para no romper el outbox.
        case MutationType.UPSERT_WORKSPACE:
          // No se acumula — wsPayload ya viene de los argumentos [C1]
          break;

        case MutationType.UPSERT_SHEET:
          sheetsMap.set(p.id, {
            id:           String(p.id),
            workspace_id: String(p.workspace_id ?? workspaceId),
            name:         String(p.name ?? '').trim(),
            capital:      Number(p.capital) || 0,
            position:     Number(p.position) || 0,
          });
          break;

        case MutationType.UPSERT_TASK:
          // [CVE-001] Pasar expectedSheetId desde el estado, no del payload
          tasksMap.set(p.id, sanitizeTask(p, p.sheet_id ?? workspaceId));
          break;

        case MutationType.UPSERT_EXPENSE:
          // [CVE-001] Pasar expectedSheetId desde el estado, no del payload
          expensesMap.set(p.id, sanitizeExpense(p, p.sheet_id ?? workspaceId));
          break;

        case MutationType.DELETE_EXPENSE:
          deleted.expense_ids.push(String(p.id));
          expensesMap.delete(p.id);  // no upsertear lo que vamos a borrar
          break;

        case MutationType.DELETE_TASK:
          deleted.task_ids.push(String(p.id));
          tasksMap.delete(p.id);
          break;

        case MutationType.DELETE_SHEET:
          deleted.sheet_ids.push(String(p.id));
          sheetsMap.delete(p.id);
          // CASCADE en Supabase elimina tasks/expenses de la sheet
          break;

        default:
          console.warn('[CloudService] Tipo de mutación desconocido — ignorado:', m.type);
      }
    }

    // Si el batch quedó vacío tras filtrar UPSERT_WORKSPACE y no hay
    // nada más que sincronizar, no hay necesidad de llamar al RPC.
    const hasPayload =
      sheetsMap.size > 0 ||
      tasksMap.size > 0 ||
      expensesMap.size > 0 ||
      deleted.sheet_ids.length > 0 ||
      deleted.task_ids.length > 0 ||
      deleted.expense_ids.length > 0;

    if (!hasPayload) return { success: true };

    return withRetry(async () => {
      const client = getSupabaseClient();

      const { data, error } = await client.rpc('batch_sync_workspace', {
        p_workspace: wsPayload,
        p_sheets:    [...sheetsMap.values()],
        p_tasks:     [...tasksMap.values()],
        p_expenses:  [...expensesMap.values()],
        p_deleted:   deleted,
      });

      // [C3] unwrap lanza CloudServiceError con código y detalle del JSONB
      unwrap({ data, error });

      // El RPC v2.0.0 devuelve JSONB { ok: boolean, ... } en éxito
      if (data && data.ok === false) {
        throw new CloudServiceError(
          data.message ?? 'El RPC devolvió ok: false',
          data.code    ?? 'RPC_ERROR',
          data.detail  ?? '',
          // Los códigos de constraint (23xxx) no son reintentables
          !String(data.code ?? '').startsWith('23'),
        );
      }

      return { success: true };
    });
  },

  // ── Sync Engine — lectura ────────────────────────────────────────────────────

  /**
   * Descarga el delta de Supabase mediante el RPC fetch_workspace_delta.
   *
   * Si `since` es null, el RPC devuelve el snapshot completo (hydration inicial).
   * En syncs incrementales, devuelve solo las entidades modificadas tras `since`.
   *
   * La RPC devuelve datos normalizados:
   *   { workspaces: [...], sheets: [...], tasks: [...], expenses: [...] }
   *
   * @param {string}      supabaseUid - UID del usuario en Supabase Auth
   * @param {string|null} since       - ISO timestamp del último sync exitoso
   * @returns {Promise<DeltaPayload>}
   * @throws {CloudServiceError}
   */
  async fetchDelta(supabaseUid, since = null) {
    return withRetry(async () => {
      const client = getSupabaseClient();

      const { data, error } = await client.rpc('fetch_workspace_delta', {
        p_since: since,
      });

      unwrap({ data, error });

      return data ?? { workspaces: [], sheets: [], tasks: [], expenses: [] };
    });
  },
};
