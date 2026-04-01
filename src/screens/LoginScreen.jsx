/**
 * @file LoginScreen.jsx
 * @description Pantalla de autenticación para TaskFlow Enterprise.
 *
 * Cambios Fase 3:
 *  - Botón Google Mock reemplazado por <GoogleLogin /> oficial de @react-oauth/google
 *  - Campos del formulario envueltos en <form> para eliminar warnings del DOM
 *    ("A component is changing an uncontrolled input..." y password autocomplete)
 *  - handleGoogleError muestra el error de Google vía el estado global de AuthContext
 *
 * Toda la lógica de negocio permanece en useAuth() — este componente es puro UI.
 */

import { memo, useCallback, useEffect, useReducer, useRef } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  TrendingUp,
  User,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// ─── Estado local del formulario ──────────────────────────────────────────────

const FORM_INITIAL = {
  tab:          'login',   // 'login' | 'register'
  email:        '',
  password:     '',
  displayName:  '',
  showPassword: false,
  fieldErrors:  {},
};

function formReducer(state, action) {
  switch (action.type) {
    case 'SET_TAB':
      return { ...FORM_INITIAL, tab: action.payload };
    case 'SET_FIELD':
      return {
        ...state,
        [action.field]: action.value,
        fieldErrors: { ...state.fieldErrors, [action.field]: undefined },
      };
    case 'TOGGLE_PASSWORD':
      return { ...state, showPassword: !state.showPassword };
    case 'SET_FIELD_ERRORS':
      return { ...state, fieldErrors: action.payload };
    default:
      return state;
  }
}

// ─── Validación cliente ───────────────────────────────────────────────────────

function validateForm(tab, { email, password, displayName }) {
  const errors = {};
  if (tab === 'register' && (!displayName || displayName.trim().length < 2))
    errors.displayName = 'Mínimo 2 caracteres.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = 'Email inválido.';
  if (!password || password.length < 8)
    errors.password = 'Mínimo 8 caracteres.';
  return errors;
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

/**
 * Input con ícono, label flotante y mensaje de error.
 * NO incluye <form> — el form lo gestiona el componente padre para agrupar
 * correctamente email + password y activar el autocompletado del navegador.
 */
const FormField = memo(function FormField({
  id, label, type = 'text', value, onChange, error, icon: Icon, rightSlot, autoComplete,
}) {
  return (
    <div className="relative">
      <div
        className={`
          flex items-center gap-3 bg-[#161b22] border rounded-md px-3 py-2.5
          transition-colors duration-150
          ${error
            ? 'border-red-500/70 focus-within:border-red-400'
            : 'border-white/10 focus-within:border-emerald-500/60'
          }
        `}
      >
        <Icon size={15} className={`shrink-0 ${error ? 'text-red-400' : 'text-white/30'}`} />
        <div className="flex-1 relative">
          <label
            htmlFor={id}
            className={`
              absolute left-0 transition-all duration-200 pointer-events-none font-mono
              ${value
                ? 'top-0 text-[10px] text-white/40'
                : 'top-1/2 -translate-y-1/2 text-xs text-white/40'
              }
            `}
          >
            {label}
          </label>
          <input
            id={id}
            name={id}
            type={type}
            value={value}
            onChange={onChange}
            autoComplete={autoComplete ?? id}
            className={`
              w-full bg-transparent text-sm text-white outline-none
              font-mono tracking-wide
              ${value ? 'pt-3.5 pb-0.5' : 'py-1'}
            `}
          />
        </div>
        {rightSlot}
      </div>
      {error && (
        <p className="mt-1 text-[11px] text-red-400 font-mono pl-1">{error}</p>
      )}
    </div>
  );
});

const PrimaryButton = memo(function PrimaryButton({ loading, children }) {
  return (
    /**
     * type="submit" — activa el <form> padre.
     * Esto también elimina el warning: "Consider adding an explicit type to the button".
     */
    <button
      type="submit"
      disabled={loading}
      className={`
        w-full relative flex items-center justify-center gap-2
        bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600
        text-[#0d1117] font-mono font-bold text-sm
        py-3 rounded-md
        transition-all duration-150
        disabled:opacity-50 disabled:cursor-not-allowed
        overflow-hidden group
      `}
    >
      {loading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <>
          <span>{children}</span>
          <ArrowRight size={14} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </>
      )}
      <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-500 ease-in-out" />
    </button>
  );
});

const Divider = memo(function Divider() {
  return (
    <div className="flex items-center gap-3 my-1">
      <div className="flex-1 h-px bg-white/10" />
      <span className="text-[10px] font-mono text-white/20 uppercase tracking-widest">o</span>
      <div className="flex-1 h-px bg-white/10" />
    </div>
  );
});

// ─── Componente principal ─────────────────────────────────────────────────────

function LoginScreen() {
  const { login, register, loginWithGoogle, isLoading, error, clearError, status } =
    useAuth();
  const [form, dispatchForm] = useReducer(formReducer, FORM_INITIAL);
  const emailRef = useRef(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, [form.tab]);

  const setField = useCallback(
    (field) => (e) => dispatchForm({ type: 'SET_FIELD', field, value: e.target.value }),
    [],
  );

  const setTab = useCallback(
    (tab) => { clearError(); dispatchForm({ type: 'SET_TAB', payload: tab }); },
    [clearError],
  );

  /**
   * onSubmit del <form> — previene recarga de página y valida antes de llamar al servicio.
   */
  const handleFormSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      const errors = validateForm(form.tab, form);
      if (Object.keys(errors).length > 0) {
        dispatchForm({ type: 'SET_FIELD_ERRORS', payload: errors });
        return;
      }
      if (form.tab === 'login') {
        await login({ email: form.email, password: form.password });
      } else {
        await register({ email: form.email, password: form.password, displayName: form.displayName });
      }
    },
    [form, login, register],
  );

  /**
   * Callback de éxito de <GoogleLogin />.
   * Recibe el CredentialResponse con el ID Token JWT — se pasa directamente a
   * loginWithGoogle que lo decodifica internamente con jwtDecode.
   */
  const handleGoogleSuccess = useCallback(
    async (credentialResponse) => {
      await loginWithGoogle(credentialResponse);
    },
    [loginWithGoogle],
  );

  /**
   * Callback de error de <GoogleLogin />.
   * El componente de Google no devuelve un mensaje de error detallado en el callback;
   * disparamos un dispatch manual para mostrar un mensaje genérico.
   */
  const handleGoogleError = useCallback(() => {
    // loginWithGoogle maneja el dispatch de error internamente si hay excepción.
    // Este callback cubre el caso de cancelación o error en el popup de Google.
    loginWithGoogle(null).catch(() => {});
  }, [loginWithGoogle]);

  return (
    <div
      className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4"
      style={{
        backgroundImage: `
          linear-gradient(rgba(16,185,129,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(16,185,129,0.03) 1px, transparent 1px)
        `,
        backgroundSize: '40px 40px',
      }}
    >
      {/* Glow ambient */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full bg-emerald-500/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* ── Logo ──────────────────────────────────────────────────────── */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 mb-4">
            <TrendingUp size={22} className="text-emerald-400" />
          </div>
          <h1 className="text-white font-mono font-bold text-xl tracking-tight">
            TaskFlow<span className="text-emerald-400">.</span>
          </h1>
          <p className="text-white/30 text-xs font-mono mt-1 tracking-widest uppercase">
            Enterprise · v1.0
          </p>
        </div>

        {/* ── Card ──────────────────────────────────────────────────────── */}
        <div className="bg-[#0d1117] border border-white/[0.08] rounded-xl p-6 shadow-2xl shadow-black/50 backdrop-blur-sm">

          {/* Tabs */}
          <div className="flex bg-[#161b22] rounded-lg p-1 mb-6 border border-white/[0.06]">
            {['login', 'register'].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setTab(tab)}
                className={`
                  flex-1 py-1.5 text-xs font-mono font-medium rounded-md
                  transition-all duration-200 capitalize tracking-wide
                  ${form.tab === tab
                    ? 'bg-emerald-500 text-[#0d1117] shadow-sm'
                    : 'text-white/40 hover:text-white/70'
                  }
                `}
              >
                {tab === 'login' ? 'Iniciar sesión' : 'Registrarse'}
              </button>
            ))}
          </div>

          {/*
           * ── <form> — envuelve TODOS los inputs de contraseña ──────────
           * Resuelve los warnings del navegador/React:
           *  1. "Input elements should have autocomplete attributes"
           *  2. "Password inputs must be contained in a form"
           *  3. El botón type="submit" activa el autocompletado del gestor de contraseñas
           */}
          <form onSubmit={handleFormSubmit} noValidate>
            <div className="space-y-3">
              {form.tab === 'register' && (
                <FormField
                  id="displayName"
                  label="Nombre completo"
                  value={form.displayName}
                  onChange={setField('displayName')}
                  error={form.fieldErrors.displayName}
                  icon={User}
                  autoComplete="name"
                />
              )}

              <FormField
                id="email"
                label="Email"
                type="email"
                value={form.email}
                onChange={setField('email')}
                error={form.fieldErrors.email}
                icon={Mail}
                autoComplete="email"
              />

              <FormField
                id="password"
                label="Contraseña"
                type={form.showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={setField('password')}
                error={form.fieldErrors.password}
                icon={Lock}
                autoComplete={form.tab === 'login' ? 'current-password' : 'new-password'}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => dispatchForm({ type: 'TOGGLE_PASSWORD' })}
                    className="text-white/20 hover:text-white/50 transition-colors p-0.5"
                    tabIndex={-1}
                    aria-label="Mostrar/ocultar contraseña"
                  >
                    {form.showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
            </div>

            {/* Error global */}
            {error && (
              <div className="mt-3 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2.5">
                <p className="flex-1 text-xs text-red-400 font-mono leading-relaxed">{error}</p>
                <button
                  type="button"
                  onClick={clearError}
                  className="text-red-400/60 hover:text-red-400 mt-0.5"
                >
                  <X size={12} />
                </button>
              </div>
            )}

            {/* CTA principal */}
            <div className="mt-5">
              <PrimaryButton loading={isLoading}>
                {form.tab === 'login' ? 'Acceder' : 'Crear cuenta'}
              </PrimaryButton>
            </div>
          </form>

          <Divider />

          {/*
           * ── <GoogleLogin /> oficial ────────────────────────────────────
           *
           * El componente renderiza el botón de Google en un iframe firmado
           * por Google (no podemos cambiar su CSS interno). Usamos un wrapper
           * para centrarlo y que ocupe el ancho disponible.
           *
           * Props clave:
           *  - onSuccess: recibe CredentialResponse con el ID Token JWT
           *  - onError:   cubre cancelación / errores del popup
           *  - theme:     'filled_black' — mejor visibilidad en dark mode
           *  - size:      'large'
           *  - width:     '100%' — hace que el botón ocupe todo el ancho
           *  - text:      'continue_with' — texto estándar de Google
           *  - locale:    'es' — idioma del botón
           *
           * NOTA: GoogleOAuthProvider debe estar en el árbol superior (App.jsx).
           */}
          <div className="flex justify-center">
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={handleGoogleError}
              theme="filled_black"
              size="large"
              width="368"
              text="continue_with"
              locale="es"
              shape="rectangular"
              logo_alignment="left"
            />
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-[10px] font-mono text-white/15 mt-6 tracking-wider">
          MULTITENANT · OFFLINE-READY · ENCRYPTED
        </p>
      </div>
    </div>
  );
}

export default memo(LoginScreen);