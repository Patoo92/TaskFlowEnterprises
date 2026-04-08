/**
 * @file cloudService.js
 * @description Cloud Service Layer para TaskFlow Enterprise — Fase 4.
 *
 * Responsabilidades:
 *  - Supabase client singleton (inicialización diferida)
 *  - upsertWorkspace: escritura idempotente via ON CONFLICT (owner_id, idb_id)
 *  - fetchRemoteWorkspaces: Delta Sync (solo filas newer than last_synced_at)
 *  - upsertProfile: sincronización del perfil de usuario
 *  - withRetry: Exponential Backoff para errores 5xx y de red
 *
 * Principios de diseño:
 *  - NUNCA bloquea la UI — todas las operaciones son async y se llaman en background
 *  - NUNCA lanza errores al caller sin que este los atrape
 *  - El singleton gestiona la sesión JWT automáticamente (supabase-js lo refresca)
 *
 * Variables de entorno requeridas (.env.local):
 *   VITE_SUPABASE_URL=https://xxxx.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJ...
 */

import { createClient } from '@supabase/supabase-js';

// ─── Configuración ─────────────────────────────────────────────────────────────

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** @returns {boolean} true si las variables de entorno están configuradas */
export const isCloudConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// ─── Supabase Client Singleton ────────────────────────────────────────────────

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let _client = null;

/**
 * Devuelve el cliente Supabase singleton.
 * Lazy-initialized — no conecta hasta la primera llamada.
 * Lanza si las variables de entorno no están configuradas.
 */
export function getSupabaseClient() {
  if (!isCloudConfigured()) {
    throw new Error('SUPABASE_NOT_CONFIGURED');
  }
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession:   true,    // Persiste el JWT en localStorage
        autoRefreshToken: true,    // Refresca el JWT antes de que expire
        detectSessionInUrl: true,  // Para OAuth redirect flows
      },
    });
  }
  return _client;
}

// ─── Retry con Exponential Backoff ────────────────────────────────────────────

const RETRY_BASE_MS  = 500;   // Delay inicial
const RETRY_MAX      = 4;     // Máximo de intentos (500ms → 1s → 2s → 4s)

/**
 * Determina si un error es recuperable con retry.
 * Solo hace retry en errores de red (sin respuesta) — los errores de API
 * de Supabase (auth, RLS, constraint) no son recuperables con retry.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryable(error) {
  // TypeError = fallo de red (sin respuesta del servidor)
  if (error instanceof TypeError) return true;
  // Supabase error con status HTTP 5xx
  if (error?.status >= 500) return true;
  return false;
}

/**
 * Ejecuta una función async con retry exponencial para errores de red/servidor.
 *
 * @template T
 * @param {() => Promise<T>}  fn           - Función a ejecutar
 * @param {number}            [maxAttempts=RETRY_MAX]
 * @param {number}            [baseDelayMs=RETRY_BASE_MS]
 * @returns {Promise<T>}
 * @throws Relanza el último error si se agotan los intentos
 */
export async function withRetry(fn, maxAttempts = RETRY_MAX, baseDelayMs = RETRY_BASE_MS) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const shouldRetry = isRetryable(err) && attempt < maxAttempts - 1;
      if (!shouldRetry) throw err;

      // Espera exponencial: 500ms, 1000ms, 2000ms, 4000ms
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Extrae el error de una respuesta de Supabase y lanza si hay error.
 * @param {{ data: unknown, error: import('@supabase/supabase-js').PostgrestError | null }} result
 * @returns {unknown} data
 */
function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message);
    // Preservar el code para que el caller pueda distinguir constraint errors
    err.code    = error.code;
    err.details = error.details;
    throw err;
  }
  return data;
}

// ─── CloudService ─────────────────────────────────────────────────────────────

export const CloudService = {

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Establece la sesión de Supabase con credenciales manuales.
   * Si el usuario no existe en Supabase Auth, lo crea (signUp).
   * La sesión JWT resultante es usada por el cliente para las políticas RLS.
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<string>} supabaseUid
   */
  async bridgeManualAuth({ email, password }) {
    const client = getSupabaseClient();

    // Intentar login primero
    const { data: signInData, error: signInError } =
      await client.auth.signInWithPassword({ email, password });

    if (!signInError && signInData?.user) {
      return signInData.user.id;
    }

    // Si el error es "Invalid login credentials", el usuario no existe → signUp
    if (signInError?.message?.includes('Invalid login credentials')) {
      const { data: signUpData, error: signUpError } =
        await client.auth.signUp({ email, password });

      if (signUpError) throw new Error(`SUPABASE_SIGNUP_ERROR: ${signUpError.message}`);
      if (!signUpData?.user) throw new Error('SUPABASE_SIGNUP_NO_USER');

      return signUpData.user.id;
    }

    throw new Error(`SUPABASE_AUTH_ERROR: ${signInError?.message}`);
  },

  /**
   * Establece la sesión de Supabase con el ID Token JWT de Google.
   * El token proviene del callback de <GoogleLogin />.
   *
   * @param {string} idToken - JWT de Google (credentialResponse.credential)
   * @returns {Promise<string>} supabaseUid
   */
  async bridgeGoogleAuth(idToken) {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithIdToken({
      provider: 'google',
      token:    idToken,
    });
    if (error) throw new Error(`SUPABASE_GOOGLE_ERROR: ${error.message}`);
    if (!data?.user) throw new Error('SUPABASE_GOOGLE_NO_USER');
    return data.user.id;
  },

  /**
   * Cierra la sesión de Supabase Auth.
   * Llamar siempre desde AuthContext.logout para limpiar el JWT.
   */
  async signOut() {
    try {
      const client = getSupabaseClient();
      await client.auth.signOut();
    } catch {
      // signOut falla silenciosamente (puede que ya no haya sesión)
    }
  },

  // ── Profile ──────────────────────────────────────────────────────────────

  /**
   * Sincroniza el perfil del usuario en la tabla `profiles` de Supabase.
   * Idempotente: upsert por `id` (Supabase auth UID).
   *
   * @param {{ uid: string, displayName: string, photoURL: string | null }} profile
   * @param {string} supabaseUid
   * @returns {Promise<void>}
   */
  async upsertProfile(profile, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      unwrap(await client.from('profiles').upsert({
        id:           supabaseUid,
        idb_uid:      profile.uid,
        display_name: profile.displayName,
        photo_url:    profile.photoURL ?? null,
      }, { onConflict: 'id' }));
    });
  },

  // ── Workspaces ────────────────────────────────────────────────────────────

  /**
   * Escribe o actualiza un workspace en Supabase de forma idempotente.
   * Usa ON CONFLICT (owner_id, idb_id) para garantizar exactamente un
   * registro por workspace local por usuario.
   *
   * @param {{ id: string, name: string, sheets: Sheet[], updatedAt?: string }} workspace
   * @param {string} supabaseUid
   * @returns {Promise<void>}
   */
  async upsertWorkspace(workspace, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      unwrap(await client.from('workspaces').upsert({
        idb_id:   workspace.id,
        owner_id: supabaseUid,
        name:     workspace.name,
        sheets:   workspace.sheets,
        // updated_at se establece en el servidor via trigger (fuente de verdad)
      }, { onConflict: 'owner_id,idb_id' }));
    });
  },

  /**
   * Delta Sync: obtiene workspaces actualizados DESDE `since`.
   * Si `since` es null, devuelve todos los workspaces del usuario.
   *
   * La comparación usa `updated_at` del servidor (trigger garantiza precisión).
   * Solo carga workspaces cuyo `updated_at > since` — minimiza transferencia.
   *
   * @param {string}       supabaseUid
   * @param {string | null} since - ISO timestamp del último sync exitoso
   * @returns {Promise<RemoteWorkspace[]>}
   */
  async fetchRemoteWorkspaces(supabaseUid, since = null) {
    return withRetry(async () => {
      const client = getSupabaseClient();

      let query = client
        .from('workspaces')
        .select('idb_id, name, sheets, updated_at, created_at')
        .eq('owner_id', supabaseUid)
        .order('updated_at', { ascending: false });

      if (since) {
        // Traer solo filas modificadas después del último sync
        query = query.gt('updated_at', since);
      }

      return unwrap(await query) ?? [];
    });
  },
};