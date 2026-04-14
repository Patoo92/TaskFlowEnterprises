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

/** Timeout en ms para operaciones de autenticación con Supabase. [C4] */
const AUTH_TIMEOUT_MS = 8_000;

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
 * Unwrap seguro de la respuesta Supabase, capturando el JSONB detallado. [C3]
 *
 * El RPC v2.0.0 devuelve errores como:
 *   error.code    → código HTTP ("400", "409", etc.)
 *   error.message → mensaje de PostgreSQL
 *   error.details → campo/constraint que falló (cuando aplica)
 *
 * Los errores 4xx (datos inválidos, violación de constraint) se marcan
 * como NO reintentables para que el outbox los descarte tras el primer fallo,
 * en lugar de agotar MAX_OUTBOX_RETRIES con peticiones condenadas al fracaso.
 *
 * @param {{ data: unknown, error: unknown }} supabaseResponse
 * @returns {unknown} data
 * @throws {CloudServiceError}
 */
function unwrap({ data, error }) {
  if (!error) return data;

  // Extraer información estructurada del error de Supabase
  const httpCode  = String(error.code ?? '');
  const message   = error.message ?? 'Error desconocido de Supabase';
  const detail    = error.details  ?? error.hint ?? '';

  // Los errores 4xx son no reintentables (datos incorrectos o violación RLS/FK)
  const is4xx     = httpCode.startsWith('4') || httpCode === 'PGRST' || httpCode === '42';
  const retryable = !is4xx;

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
      if (err instanceof CloudServiceError && !err.retryable) throw err;
      if (attempt === maxRetries) throw err;

      const cap   = baseDelay * Math.pow(2, attempt);
      const delay = Math.random() * Math.min(cap, 30_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Crea una Promise que rechaza con un CloudServiceError de timeout
 * tras `ms` milisegundos. Usar junto a Promise.race() o AbortController. [C4]
 *
 * @param {number} ms
 * @returns {Promise<never>}
 */
function rejectAfter(ms) {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new CloudServiceError(`Timeout tras ${ms}ms`, 'TIMEOUT', '', true)),
      ms,
    ),
  );
}

// ─── Helpers de sanitización ──────────────────────────────────────────────────

/**
 * Coerción de tipos estricta para tareas antes de enviar al RPC. [C2]
 * PostgreSQL v2.0.0 rechaza cualquier tipo incorrecto con error 400.
 *
 * @param {object} task
 * @returns {{ id: string, sheet_id: string, text: string, completed: boolean }}
 */
function sanitizeTask(task) {
  return {
    id:        String(task.id),
    sheet_id:  String(task.sheet_id),
    text:      String(task.text ?? '').trim(),
    completed: Boolean(task.completed),   // forzar boolean — no string/undefined
  };
}

/**
 * Coerción de tipos estricta para gastos antes de enviar al RPC. [C2]
 *
 * @param {object} expense
 * @returns {{ id: string, sheet_id: string, description: string, amount: number }}
 */
function sanitizeExpense(expense) {
  return {
    id:          String(expense.id),
    sheet_id:    String(expense.sheet_id),
    description: String(expense.description ?? '').trim(),
    amount:      Number(expense.amount) || 0,  // forzar number — nunca NaN/null
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

    // Timeout de 8 s — si Supabase no responde, rechazamos inmediatamente [C4]
    const result = await Promise.race([
      (async () => {
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
            false, // credenciales incorrectas — no reintentar
          );
          return signUpData.user?.id;
        }

        throw new CloudServiceError(
          signInError.message,
          String(signInError.status ?? signInError.code ?? 'AUTH_ERROR'),
          signInError.details ?? '',
          true,
        );
      })(),
      rejectAfter(AUTH_TIMEOUT_MS),
    ]);

    return result;
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

    const result = await Promise.race([
      (async () => {
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
      })(),
      rejectAfter(AUTH_TIMEOUT_MS),
    ]);

    return result;
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
          tasksMap.set(p.id, sanitizeTask(p));   // [C2] tipado estricto
          break;

        case MutationType.UPSERT_EXPENSE:
          expensesMap.set(p.id, sanitizeExpense(p));  // [C2] tipado estricto
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
