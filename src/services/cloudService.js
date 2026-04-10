/**
 * @file cloudService.js
 * @description Capa de comunicación con Supabase — Fase 5: Delta Sync Engine.
 * @version 1.5.0
 *
 * ── Cambios v1.5.0 ────────────────────────────────────────────────────────────
 *
 *  [CLOUD-01] Operaciones atómicas vía RPC batch_sync_workspace:
 *    El sync ya no envía un JSON blob completo del workspace. Envía una
 *    mutación procesada en una transacción PostgreSQL única. Si falla un INSERT
 *    de task, hace rollback completo — nunca quedan FK violations parciales.
 *
 *  [CLOUD-02] Delta fetch vía RPC fetch_workspace_delta:
 *    Reemplaza la query SELECT sobre la tabla `workspaces` con el snapshot JSON.
 *    La RPC devuelve entidades normalizadas en { workspaces, sheets, tasks, expenses }.
 *
 *  [CLOUD-03] Exponential backoff con full jitter (AWS recommendation):
 *    Reemplaza el withRetry() que no tenía jitter y causaba thundering herd.
 *    Cap: 30s. Factor: 2x. Jitter: random(0, min(cap, delay)).
 *
 *  [CLOUD-04] processOutboxBatch:
 *    Agrupa las mutaciones del outbox por lotes y los envía en orden topológico
 *    al RPC. Si el RPC falla, el lote completo queda en el outbox para retry.
 *
 *  ── INTACTO ────────────────────────────────────────────────────────────────────
 *  ✓ getSupabaseClient / isCloudConfigured (singleton pattern)
 *  ✓ syncSupabaseAuth / bridgeGoogleAuth / signOut
 */

import { createClient } from '@supabase/supabase-js';
import { MutationType }  from './db';

// ─── Configuración ─────────────────────────────────────────────────────────────

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** Número máximo de reintentos por entrada del outbox antes de descartarla. */
export const MAX_OUTBOX_RETRIES = 5;

export const isCloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let _client = null;

export function getSupabaseClient() {
  if (!isCloudConfigured()) throw new Error('SUPABASE_NOT_CONFIGURED');
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ─── Helpers de resiliencia ───────────────────────────────────────────────────

/**
 * Exponential backoff con full jitter para evitar thundering herd.
 * Algoritmo: delay = random(0, min(cap, baseDelay * 2^attempt))
 *
 * @param {() => Promise<T>} fn        - Función a reintentar
 * @param {number}           maxRetries - Número máximo de reintentos
 * @param {number}           baseDelay  - Delay base en ms (default 800ms)
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 800) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const cap   = baseDelay * Math.pow(2, attempt);        // techo exponencial
      const delay = Math.random() * Math.min(cap, 30_000);   // full jitter
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Extrae data o lanza el error de una respuesta Supabase. */
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ─── Auth Bridge ──────────────────────────────────────────────────────────────
// INTACTO — restricción absoluta

export const CloudService = {

  /** Sincroniza credenciales manuales con Supabase Auth (sign-in o sign-up). */
  async syncSupabaseAuth({ email, password }) {
    const client = getSupabaseClient();
    const { data: signInData, error: signInError } =
      await client.auth.signInWithPassword({ email, password });
    if (!signInError && signInData?.user) return signInData.user.id;

    if (signInError?.message?.includes('Invalid login credentials')) {
      const { data: signUpData, error: signUpError } =
        await client.auth.signUp({ email, password });
      if (signUpError) throw signUpError;
      return signUpData.user?.id;
    }
    throw signInError;
  },

  /** Bridge de Google ID Token hacia Supabase Auth. */
  async bridgeGoogleAuth(idToken) {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithIdToken({
      provider: 'google',
      token:    idToken,
    });
    if (error) throw error;
    return data.user?.id;
  },

  async signOut() {
    const client = getSupabaseClient();
    await client.auth.signOut();
  },

  // ─── Sync Engine — operaciones de escritura ─────────────────────────────────

  /**
   * Envía un lote de mutaciones del outbox a Supabase mediante el RPC
   * batch_sync_workspace. Las mutaciones ya llegan ordenadas topológicamente
   * por OutboxService.getAll() (padres antes que hijos).
   *
   * El RPC ejecuta todo en una transacción PostgreSQL:
   *   - Si falla un step intermedio → rollback completo → el outbox mantiene las entradas.
   *   - Si tiene éxito → el caller elimina las entradas del outbox.
   *
   * @param {OutboxEntry[]} mutations - Mutaciones ya ordenadas topológicamente
   * @param {string}        supabaseUid
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async processOutboxBatch(mutations, supabaseUid) {
    if (!mutations.length) return { success: true };

    // Agrupar mutaciones por tabla para construir el payload del RPC
    const wsMap      = new Map();   // id → workspace payload
    const sheetsMap  = new Map();   // id → sheet payload
    const tasksMap   = new Map();   // id → task payload
    const expensesMap = new Map();  // id → expense payload
    const deleted = { sheet_ids: [], task_ids: [], expense_ids: [] };

    for (const m of mutations) {
      const p = m.payload;
      switch (m.type) {
        case MutationType.UPSERT_WORKSPACE:
          wsMap.set(p.id, { id: p.id, name: p.name });
          break;

        case MutationType.UPSERT_SHEET:
          sheetsMap.set(p.id, {
            id:           p.id,
            workspace_id: p.workspace_id,
            name:         p.name,
            capital:      p.capital,
            position:     p.position ?? 0,
          });
          break;

        case MutationType.UPSERT_TASK:
          tasksMap.set(p.id, {
            id:        p.id,
            sheet_id:  p.sheet_id,
            text:      p.text,
            completed: p.completed,
          });
          break;

        case MutationType.UPSERT_EXPENSE:
          expensesMap.set(p.id, {
            id:          p.id,
            sheet_id:    p.sheet_id,
            description: p.description,
            amount:      p.amount,
          });
          break;

        case MutationType.DELETE_EXPENSE:
          deleted.expense_ids.push(p.id);
          expensesMap.delete(p.id); // No upsertear lo que vamos a borrar
          break;

        case MutationType.DELETE_TASK:
          deleted.task_ids.push(p.id);
          tasksMap.delete(p.id);
          break;

        case MutationType.DELETE_SHEET:
          deleted.sheet_ids.push(p.id);
          sheetsMap.delete(p.id);
          // Los tasks/expenses de esta sheet se borran por CASCADE en Supabase
          break;

        default:
          console.warn('[CloudService] Tipo de mutación desconocido:', m.type);
      }
    }

    // Si solo hay un workspace en el batch (caso más común),
    // lo enviamos todo como un único RPC
    const workspacePayloads = [...wsMap.values()];
    if (workspacePayloads.length === 0 && deleted.sheet_ids.length === 0
      && sheetsMap.size === 0 && tasksMap.size === 0 && expensesMap.size === 0) {
      return { success: true }; // Nada que hacer
    }

    // El RPC espera un único workspace por llamada (arquitectura single-workspace)
    // Para multi-workspace en Fase 6, agrupar por workspace_id y llamar en paralelo
    const wsPayload = workspacePayloads[0] ?? { id: mutations[0]?.payload?.workspace_id };

    return withRetry(async () => {
      const client = getSupabaseClient();
      const { error } = await client.rpc('batch_sync_workspace', {
        p_workspace:  wsPayload ?? {},
        p_sheets:     [...sheetsMap.values()],
        p_tasks:      [...tasksMap.values()],
        p_expenses:   [...expensesMap.values()],
        p_deleted:    deleted,
      });
      if (error) throw error;
      return { success: true };
    });
  },

  // ─── Sync Engine — operaciones de lectura ───────────────────────────────────

  /**
   * Fetch delta desde Supabase vía RPC fetch_workspace_delta.
   * Si since es null, devuelve el snapshot completo (initial hydration).
   *
   * La RPC devuelve datos normalizados:
   *   { workspaces: [...], sheets: [...], tasks: [...], expenses: [...] }
   *
   * @param {string}      supabaseUid
   * @param {string|null} since - ISO timestamp del último sync exitoso
   * @returns {Promise<DeltaPayload>}
   */
  async fetchDelta(supabaseUid, since = null) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      const { data, error } = await client.rpc('fetch_workspace_delta', {
        p_since: since,
      });
      if (error) throw error;
      return data ?? { workspaces: [], sheets: [], tasks: [], expenses: [] };
    });
  },

  // ─── Operaciones individuales (fallback / uso directo) ─────────────────────

  /**
   * Upsert directo de workspace (sin RPC batch).
   * Usado para actualizaciones de metadatos simples (ej. renombrar workspace).
   */
  async upsertWorkspace(workspace, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('workspaces').upsert(
        { id: workspace.id, owner_id: supabaseUid, name: workspace.name },
        { onConflict: 'id' },
      ));
    });
  },

  /**
   * Upsert directo de sheet.
   * @param {object} sheet
   * @param {string} supabaseUid
   */
  async upsertSheet(sheet, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('sheets').upsert(
        {
          id:           sheet.id,
          workspace_id: sheet.workspace_id,
          owner_id:     supabaseUid,
          name:         sheet.name,
          capital:      sheet.capital,
          position:     sheet.position ?? 0,
        },
        { onConflict: 'id' },
      ));
    });
  },

  /**
   * Upsert directo de task.
   */
  async upsertTask(task, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('tasks').upsert(
        {
          id:        task.id,
          sheet_id:  task.sheet_id,
          owner_id:  supabaseUid,
          text:      task.text,
          completed: task.completed,
        },
        { onConflict: 'id' },
      ));
    });
  },

  /**
   * Upsert directo de expense.
   */
  async upsertExpense(expense, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('expenses').upsert(
        {
          id:          expense.id,
          sheet_id:    expense.sheet_id,
          owner_id:    supabaseUid,
          description: expense.description,
          amount:      expense.amount,
        },
        { onConflict: 'id' },
      ));
    });
  },

  /**
   * DELETE directo de una task en Supabase.
   * Solo elimina registros del owner autenticado (RLS garantiza esto).
   */
  async deleteTask(taskId, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(
        await client.from('tasks').delete()
          .eq('id',       taskId)
          .eq('owner_id', supabaseUid),
      );
    });
  },

  /**
   * DELETE directo de un expense en Supabase.
   */
  async deleteExpense(expenseId, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(
        await client.from('expenses').delete()
          .eq('id',       expenseId)
          .eq('owner_id', supabaseUid),
      );
    });
  },

  /**
   * DELETE directo de una sheet en Supabase.
   * ON DELETE CASCADE en tasks y expenses garantiza limpieza de hijos.
   */
  async deleteSheet(sheetId, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(
        await client.from('sheets').delete()
          .eq('id',       sheetId)
          .eq('owner_id', supabaseUid),
      );
    });
  },

  /** Actualiza el perfil del usuario en Supabase (tabla profiles). */
  async upsertProfile(profile, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('profiles').upsert({
        id:           supabaseUid,
        display_name: profile.displayName,
        photo_url:    profile.photoURL,
      }));
    });
  },
};