/**
 * @file AuthContext.jsx
 * @description Contexto global de autenticación para TaskFlow Enterprise.
 * @version 1.0.1 — Parches de seguridad y estabilidad
 *
 * Responsabilidades:
 *  - Registro/Login manual (validado contra IndexedDB via UserService)
 *  - Google OAuth real via @react-oauth/google + decodificación JWT (jwt-decode)
 *  - Persistencia de sesión en Cookie (7 días, SameSite Strict)
 *  - Gestión de perfil: displayName y photoURL (Base64)
 *  - Hook `useAuth` como única interfaz de acceso al estado
 *
 * Flujo Google OAuth (sin backend):
 *  <GoogleLogin onSuccess> recibe credentialResponse.credential (ID Token JWT)
 *  → jwtDecode(jwt) extrae { sub, email, name, picture }
 *  → Se valida la expiración del token (campo `exp`)
 *  → UserService.findOrCreateGoogle crea o recupera el usuario en IndexedDB
 *  → Cookie de sesión renovada (7 días, sin photoURL para evitar límite 4KB)
 *
 * Flujo de rehidratación:
 *  Cookie "tf_session" → revalidar uid en IDB → AUTH_SUCCESS | limpiar cookie
 *
 * ── Cambios v1.0.1 ────────────────────────────────────────────────────────────
 *  [FIX-01] ReferenceError: `supabaseUid` undefined en updateProfile.
 *           Ahora se lee de `persistedUser.supabaseUid` (devuelto por IDB).
 *  [FIX-02] Cookie de sesión ya NO incluye `photoURL` (Base64 puede exceder 4KB).
 *           La foto se lee desde IDB en la rehidratación.
 *  [FIX-03] decodeGoogleCredential valida el campo `exp` del JWT para rechazar
 *           tokens expirados antes de crear la sesión.
 *  [OPT-01] updateProfile usa `userRef` para acceder al user más reciente sin
 *           recrear la función en cada cambio de state.user (stable reference).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import Cookies from 'js-cookie';
import { jwtDecode } from 'jwt-decode';
import { UserService, SyncMetaService } from '../services/db';
import { CloudService, isCloudConfigured } from '../services/cloudService';


// ─── Configuración de cookies ─────────────────────────────────────────────────

const SESSION_COOKIE = 'tf_session';

/**
 * secure: true en producción (HTTPS).
 * En desarrollo local HTTP con Vite: import.meta.env.PROD evalúa a false,
 * por lo que las cookies funcionan sin HTTPS.
 */
const COOKIE_OPTIONS = {
  expires:  7,
  secure:   import.meta.env.PROD,
  sameSite: 'Strict',
};

// ─── Estado inicial y Reducer ─────────────────────────────────────────────────

const initialState = {
  status: 'idle',  // 'idle' | 'loading' | 'authenticated' | 'unauthenticated'
  user:   null,
  error:  null,
};

function authReducer(state, action) {
  switch (action.type) {
    case 'LOADING':
      return { ...state, status: 'loading', error: null };
    case 'AUTH_SUCCESS':
      return { status: 'authenticated', user: action.payload, error: null };
    case 'AUTH_FAILURE':
      return { status: 'unauthenticated', user: null, error: action.payload };
    case 'LOGOUT':
      return { status: 'unauthenticated', user: null, error: null };

    // Optimistic: payload = { displayName?, photoURL? } — aplica inmediatamente en UI
    case 'UPDATE_PROFILE':
      return { ...state, user: { ...state.user, ...action.payload } };

    // Rollback: restaura el user completo si la escritura en IDB falla
    case 'ROLLBACK_PROFILE':
      return { ...state, user: action.payload };

    // Legacy alias — mantener compatibilidad
    case 'PROFILE_UPDATED':
      return { ...state, user: { ...state.user, ...action.payload } };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    default:
      return state;
  }
}

// ─── Contexto ─────────────────────────────────────────────────────────────────

const AuthContext = createContext(null);

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Mapea códigos de error internos → mensajes UI en español.
 * Punto único de traducción: nunca exponer códigos internos al usuario.
 */
function mapErrorMessage(code) {
  const messages = {
    EMAIL_ALREADY_EXISTS:    'Este email ya está registrado.',
    INVALID_CREDENTIALS:     'Email o contraseña incorrectos.',
    USER_NOT_FOUND:          'Sesión expirada. Por favor inicia sesión de nuevo.',
    VALIDATION_ERROR:        'Datos inválidos. Revisa los campos.',
    GOOGLE_DECODE_ERROR:     'No se pudo leer el token de Google. Inténtalo de nuevo.',
    GOOGLE_TOKEN_EXPIRED:    'El token de Google ha expirado. Inicia sesión de nuevo.',
    GOOGLE_MISSING_FIELDS:   'Google no devolvió los datos necesarios (email o ID).',
    SUPABASE_NOT_CONFIGURED: 'Sincronización cloud no configurada (local-only mode).',
  };
  return messages[code] ?? 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

function validateRegistration({ email, password, displayName }) {
  if (!displayName || displayName.trim().length < 2) throw new Error('VALIDATION_ERROR');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))  throw new Error('VALIDATION_ERROR');
  if (!password || password.length < 8)                      throw new Error('VALIDATION_ERROR');
}

function validateLogin({ email, password }) {
  if (!email || !password) throw new Error('VALIDATION_ERROR');
}

/**
 * Decodifica el ID Token (JWT) que Google entrega via credentialResponse.credential.
 * jwt-decode v4 NO verifica la firma — apropiado para client-only apps.
 * En arquitecturas con backend: verificar el JWT server-side con Google Public Keys.
 *
 * Campos del payload estándar de Google Identity Services:
 *   sub     → Google User ID (estable, único por cuenta)
 *   email   → email del usuario
 *   name    → nombre completo
 *   picture → URL pública del avatar
 *   exp     → Unix timestamp de expiración (validado aquí — [FIX-03])
 *
 * @param {string} credential — ID Token JWT de Google
 * @returns {{ googleId: string, email: string, displayName: string, photoURL: string|null }}
 * @throws {Error} GOOGLE_TOKEN_EXPIRED si el token ya expiró
 * @throws {Error} GOOGLE_MISSING_FIELDS si faltan sub o email
 */
function decodeGoogleCredential(credential) {
  const payload = jwtDecode(credential);

  // [FIX-03] Validar expiración antes de crear la sesión.
  // jwtDecode v4 no verifica `exp` automáticamente — lo hacemos manualmente.
  // Math.floor(Date.now() / 1000) → Unix timestamp en segundos (igual que `exp`)
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) {
    throw new Error('GOOGLE_TOKEN_EXPIRED');
  }

  const googleId    = payload.sub;
  const email       = payload.email;
  const displayName = payload.name ?? payload.email?.split('@')[0] ?? 'Usuario Google';
  const photoURL    = payload.picture ?? null;

  if (!googleId || !email) throw new Error('GOOGLE_MISSING_FIELDS');

  return { googleId, email, displayName, photoURL };
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

/**
 * Serializa solo los metadatos esenciales de sesión en la cookie.
 *
 * [FIX-02] `photoURL` eliminado intencionalmente:
 *   - Un avatar Base64 comprimido puede superar fácilmente los 4KB de límite de cookie.
 *   - Las cookies viajan en cada request HTTP, encareciendo la transferencia.
 *   - La foto se recupera desde IndexedDB durante la rehidratación (fuente de verdad).
 *
 * @param {Object} user - Objeto usuario completo (con o sin photoURL)
 */
function setSessionCookie(user) {
  Cookies.set(
    SESSION_COOKIE,
    JSON.stringify({
      uid:         user.uid,
      email:       user.email,
      displayName: user.displayName,
      // photoURL omitido — se lee desde IDB en rehidratación [FIX-02]
      supabaseUid: user.supabaseUid ?? null,
    }),
    COOKIE_OPTIONS,
  );
}

function getSessionCookie() {
  try {
    const raw = Cookies.get(SESSION_COOKIE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSessionCookie() {
  Cookies.remove(SESSION_COOKIE);
}

// ─── Auth Bridge helpers ──────────────────────────────────────────────────────

/**
 * Intenta sincronizar la sesión con Supabase Auth en background.
 * Falla silenciosamente si cloud no está configurado o hay error de red.
 * Nunca bloquea el login local — el usuario accede aunque Supabase falle.
 *
 * @param {'manual'|'google'} method
 * @param {{ email?: string, password?: string, idToken?: string }} credentials
 * @param {string} localUid - UID de IDB del usuario
 * @returns {Promise<string|null>} supabaseUid o null si falla
 */
async function syncSupabaseAuth(method, credentials, localUid) {
  if (!isCloudConfigured()) return null;
  try {
    let supabaseUid;
    if (method === 'google' && credentials.idToken) {
      supabaseUid = await CloudService.bridgeGoogleAuth(credentials.idToken);
    } else if (method === 'manual' && credentials.email && credentials.password) {
      supabaseUid = await CloudService.syncSupabaseAuth({
        email:    credentials.email,
        password: credentials.password,
      });
    }
    if (supabaseUid) {
      // Persistir el vínculo en IDB para rehidratación futura
      await SyncMetaService.upsert(localUid, { supabaseUid });
      return supabaseUid;
    }
  } catch (err) {
    // Falla silenciosa — el usuario continúa en local-only mode
    console.warn('[AuthContext] Supabase bridge failed (local-only mode):', err.message);
  }
  return null;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  // [OPT-01] Ref que siempre apunta al user más reciente.
  // Permite que updateProfile acceda al user actual sin cerrarse sobre
  // state.user ni recrearse en cada cambio (stable callback reference).
  const userRef = useRef(state.user);
  useEffect(() => { userRef.current = state.user; }, [state.user]);

  // ── Rehidratación al montar ─────────────────────────────────────────────────
  useEffect(() => {
    async function rehydrate() {
      dispatch({ type: 'LOADING' });
      const session = getSessionCookie();

      if (!session?.uid) {
        dispatch({ type: 'AUTH_FAILURE', payload: null });
        return;
      }

      try {
        // IDB es la fuente de verdad: incluye photoURL completo que la cookie no lleva
        const idbUser = await UserService.getById(session.uid);

        // Rescate crítico del UID de Supabase ("F5 de la Muerte"):
        // IDB tiene el supabaseUid si fue persistido por linkSupabase;
        // la cookie lo tiene como fallback si IDB no lo guardó todavía.
        const finalUser = {
          ...idbUser,
          supabaseUid: idbUser.supabaseUid || session.supabaseUid || null,
        };

        // Refrescar cookie (renueva los 7 días de expiración)
        setSessionCookie(finalUser);
        dispatch({ type: 'AUTH_SUCCESS', payload: finalUser });
      } catch (err) {
        clearSessionCookie();
        dispatch({ type: 'AUTH_FAILURE', payload: mapErrorMessage(err.message) });
      }
    }

    rehydrate();
  }, []);

  // ── Registro manual ─────────────────────────────────────────────────────────
  const register = useCallback(async ({ email, password, displayName }) => {
    dispatch({ type: 'LOADING' });
    try {
      validateRegistration({ email, password, displayName });
      const user = await UserService.create({ email, password, displayName });

      // Auth bridge: background, falla silenciosa
      const supabaseUid = await syncSupabaseAuth('manual', { email, password }, user.uid);
      const finalUser   = supabaseUid
        ? await UserService.linkSupabase(user.uid, supabaseUid)
        : user;

      setSessionCookie(finalUser);
      dispatch({ type: 'AUTH_SUCCESS', payload: finalUser });
      return { success: true };
    } catch (err) {
      const message = mapErrorMessage(err.message);
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      return { success: false, error: message };
    }
  }, []);

  // ── Login manual ────────────────────────────────────────────────────────────
  const login = useCallback(async ({ email, password }) => {
    dispatch({ type: 'LOADING' });
    try {
      validateLogin({ email, password });
      const user = await UserService.authenticate({ email, password });

      // Auth bridge + restore supabaseUid from sync_meta if already linked
      let finalUser = user;
      const meta    = await SyncMetaService.get(user.uid);
      if (meta?.supabaseUid) {
        // Usuario ya vinculado — solo refrescar la sesión de Supabase
        finalUser = { ...user, supabaseUid: meta.supabaseUid };
        syncSupabaseAuth('manual', { email, password }, user.uid).catch(() => {});
      } else {
        // Primera vez — bridge en background
        const supabaseUid = await syncSupabaseAuth('manual', { email, password }, user.uid);
        if (supabaseUid) {
          finalUser = await UserService.linkSupabase(user.uid, supabaseUid);
        }
      }

      setSessionCookie(finalUser);
      dispatch({ type: 'AUTH_SUCCESS', payload: finalUser });
      return { success: true };
    } catch (err) {
      const message = mapErrorMessage(err.message);
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      return { success: false, error: message };
    }
  }, []);

  /**
   * Login con Google OAuth real.
   *
   * Acepta el `credentialResponse` del callback `onSuccess` de <GoogleLogin />.
   * Internamente decodifica el ID Token JWT para extraer el perfil
   * y delega la persistencia a UserService.findOrCreateGoogle.
   *
   * El conflicto de IDB del mock desaparece porque ahora cada usuario de Google
   * tiene un `googleId` real y estable (campo `sub` del JWT), no un timestamp.
   *
   * [FIX-03] decodeGoogleCredential valida `exp` antes de proceder.
   *
   * @param {import('@react-oauth/google').CredentialResponse} credentialResponse
   */
  const loginWithGoogle = useCallback(async (credentialResponse) => {
    dispatch({ type: 'LOADING' });
    try {
      if (!credentialResponse?.credential) throw new Error('GOOGLE_DECODE_ERROR');

      // Decodifica y valida exp, sub, email
      const profile = decodeGoogleCredential(credentialResponse.credential);
      const user    = await UserService.findOrCreateGoogle(profile);

      // Google bridge: usar el mismo idToken para signInWithIdToken en Supabase
      const supabaseUid = await syncSupabaseAuth(
        'google',
        { idToken: credentialResponse.credential },
        user.uid,
      );
      const finalUser = supabaseUid
        ? await UserService.linkSupabase(user.uid, supabaseUid)
        : user;

      setSessionCookie(finalUser);
      dispatch({ type: 'AUTH_SUCCESS', payload: finalUser });
      return { success: true };
    } catch (err) {
      const message = mapErrorMessage(err.message);
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      return { success: false, error: message };
    }
  }, []);

  // ── Logout ──────────────────────────────────────────────────────────────────
  const logout = useCallback(() => {
    clearSessionCookie();
    dispatch({ type: 'LOGOUT' });
    // Limpiar sesión de Supabase en background (falla silenciosa)
    if (isCloudConfigured()) {
      CloudService.signOut().catch(() => {});
    }
  }, []);

  // ── Actualización de perfil (Optimistic Update + Rollback) ──────────────────
  //
  // Flujo:
  //  1. Guarda snapshot del user actual via userRef (evita stale closures)
  //  2. Aplica UPDATE_PROFILE en React inmediatamente (UI no espera a IDB)
  //  3. Intenta persistir en IndexedDB (compresión de imagen incluida en db.js)
  //  4a. Éxito → refresca cookie y sincroniza React con el Base64 comprimido real
  //  4b. Fallo  → ROLLBACK_PROFILE restaura el snapshot y devuelve el error
  //
  // [FIX-01] Eliminada la línea `persistedUser.supabaseUid = supabaseUid` que
  //          causaba ReferenceError. El supabaseUid ya viene incluido en el objeto
  //          devuelto por UserService.updateProfile (IDB preserva todos los campos).
  //
  // [OPT-01] useCallback ya no depende de state.user — usa userRef para leer
  //          el valor actual. La función es estable durante toda la vida del Provider,
  //          eliminando re-renders innecesarios en todos sus consumers.
  //
  const updateProfile = useCallback(async (updates) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return { success: false, error: 'No autenticado.' };

    // Snapshot para rollback (leído desde ref — siempre el más reciente)
    const previousUser = currentUser;

    // ── Optimistic update — React UI es inmediata ─────────────────────────────
    dispatch({ type: 'UPDATE_PROFILE', payload: updates });

    try {
      // db.js comprimirá el photoURL si está presente antes de escribir en IDB.
      // El objeto devuelto incluye todos los campos del usuario (supabaseUid incluido).
      const persistedUser = await UserService.updateProfile(currentUser.uid, updates);

      // Actualizar cookie con metadatos frescos (sin photoURL — [FIX-02])
      setSessionCookie(persistedUser);

      // Sincronizar estado React con los datos persistidos (el photoURL puede diferir
      // del optimistic si la compresión redujo el tamaño o calidad del Base64)
      dispatch({
        type:    'UPDATE_PROFILE',
        payload: {
          displayName: persistedUser.displayName,
          photoURL:    persistedUser.photoURL,
        },
      });

      return { success: true };
    } catch (err) {
      // ── Rollback — restaurar snapshot anterior ────────────────────────────────
      dispatch({ type: 'ROLLBACK_PROFILE', payload: previousUser });
      return { success: false, error: mapErrorMessage(err.message) };
    }
  }, []); // Stable: no depende de state.user gracias a userRef [OPT-01]

  const clearError = useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), []);

  // ── Valor del contexto memoizado ────────────────────────────────────────────
  const contextValue = useMemo(() => ({
    user:            state.user,
    status:          state.status,
    error:           state.error,
    isAuthenticated: state.status === 'authenticated',
    isLoading:       state.status === 'loading' || state.status === 'idle',
    // supabaseUid — disponible para WorkspaceContext (owner_id en RLS)
    supabaseUid:     state.user?.supabaseUid ?? null,
    register,
    login,
    loginWithGoogle,
    logout,
    updateProfile,
    clearError,
  }), [state, register, login, loginWithGoogle, logout, updateProfile, clearError]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook público ─────────────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>.');
  return ctx;
}
