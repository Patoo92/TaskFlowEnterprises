/**
 * @file AuthContext.jsx
 * @description Contexto global de autenticación para TaskFlow Enterprise.
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
 *  → UserService.findOrCreateGoogle crea o recupera el usuario en IndexedDB
 *  → Cookie de sesión renovada (7 días)
 *
 * Flujo de rehidratación:
 *  Cookie "tf_session" → revalidar uid en IDB → AUTH_SUCCESS | limpiar cookie
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import Cookies from 'js-cookie';
import { jwtDecode } from 'jwt-decode';
import { UserService } from '../services/db';

// ─── Configuración de cookies ─────────────────────────────────────────────────

const SESSION_COOKIE = 'tf_session';

/**
 * secure: true en producción (HTTPS).
 * En desarrollo local HTTP con Vite: import.meta.env.PROD evalúa a false,
 * por lo que las cookies funcionan sin HTTPS.
 */
const COOKIE_OPTIONS = {
  expires: 7,
  secure: import.meta.env.PROD,
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
    EMAIL_ALREADY_EXISTS:  'Este email ya está registrado.',
    INVALID_CREDENTIALS:   'Email o contraseña incorrectos.',
    USER_NOT_FOUND:        'Sesión expirada. Por favor inicia sesión de nuevo.',
    VALIDATION_ERROR:      'Datos inválidos. Revisa los campos.',
    GOOGLE_DECODE_ERROR:   'No se pudo leer el token de Google. Inténtalo de nuevo.',
    GOOGLE_MISSING_FIELDS: 'Google no devolvió los datos necesarios (email o ID).',
  };
  return messages[code] ?? 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

function validateRegistration({ email, password, displayName }) {
  if (!displayName || displayName.trim().length < 2) throw new Error('VALIDATION_ERROR');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('VALIDATION_ERROR');
  if (!password || password.length < 8) throw new Error('VALIDATION_ERROR');
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
 *
 * @param {string} credential — ID Token JWT de Google
 * @returns {{ googleId: string, email: string, displayName: string, photoURL: string|null }}
 */
function decodeGoogleCredential(credential) {
  const payload = jwtDecode(credential);

  const googleId    = payload.sub;
  const email       = payload.email;
  const displayName = payload.name ?? payload.email?.split('@')[0] ?? 'Usuario Google';
  const photoURL    = payload.picture ?? null;

  if (!googleId || !email) throw new Error('GOOGLE_MISSING_FIELDS');

  return { googleId, email, displayName, photoURL };
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function setSessionCookie(user) {
  Cookies.set(
    SESSION_COOKIE,
    JSON.stringify({
      uid:         user.uid,
      email:       user.email,
      displayName: user.displayName,
      photoURL:    user.photoURL,
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

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

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
        // Revalida uid en IDB — defensa ante cookies con datos stale
        const user = await UserService.getById(session.uid);
        setSessionCookie(user); // renueva expiración en cada visita
        dispatch({ type: 'AUTH_SUCCESS', payload: user });
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
      setSessionCookie(user);
      dispatch({ type: 'AUTH_SUCCESS', payload: user });
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
      setSessionCookie(user);
      dispatch({ type: 'AUTH_SUCCESS', payload: user });
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
   * @param {import('@react-oauth/google').CredentialResponse} credentialResponse
   */
  const loginWithGoogle = useCallback(async (credentialResponse) => {
    dispatch({ type: 'LOADING' });
    try {
      if (!credentialResponse?.credential) throw new Error('GOOGLE_DECODE_ERROR');

      const profile = decodeGoogleCredential(credentialResponse.credential);
      const user    = await UserService.findOrCreateGoogle(profile);

      setSessionCookie(user);
      dispatch({ type: 'AUTH_SUCCESS', payload: user });
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
  }, []);

  // ── Actualización de perfil ─────────────────────────────────────────────────
  const updateProfile = useCallback(async (updates) => {
    if (!state.user?.uid) return { success: false, error: 'No autenticado.' };
    try {
      const updatedUser = await UserService.updateProfile(state.user.uid, updates);
      setSessionCookie(updatedUser);
      dispatch({ type: 'PROFILE_UPDATED', payload: updates });
      return { success: true };
    } catch (err) {
      return { success: false, error: mapErrorMessage(err.message) };
    }
  }, [state.user?.uid]);

  const clearError = useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), []);

  // ── Valor del contexto memoizado ────────────────────────────────────────────
  const contextValue = useMemo(() => ({
    user:            state.user,
    status:          state.status,
    error:           state.error,
    isAuthenticated: state.status === 'authenticated',
    isLoading:       state.status === 'loading' || state.status === 'idle',
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