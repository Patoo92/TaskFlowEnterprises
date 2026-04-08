/**
 * @file ProfileScreen.jsx
 * @description Pantalla de gestión de identidad para TaskFlow Enterprise.
 *
 * Layout de dos columnas:
 *  ┌─ Avatar Editor ──────────────┐  ┌─ Account Details ───────────────┐
 *  │  Preview circular 120px      │  │  displayName (editable)         │
 *  │  Hover: overlay cian + ícono │  │  email (readonly)               │
 *  │  Input file oculto           │  │  uid (readonly, monoespaciado)  │
 *  │  Validación MIME estricta    │  │  Proveedor (Manual / Google)    │
 *  └──────────────────────────────┘  └─────────────────────────────────┘
 *
 * Toast de feedback: aparece 2.5s tras guardar (éxito o error).
 * Sin dependencias de animación — transición CSS con Tailwind.
 *
 * Patrón de estado: formulario controlado local (useReducer) +
 * delegación total a useAuth().updateProfile (optimistic update incluido).
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  Camera,
  Check,
  Loader2,
  Lock,
  Mail,
  Save,
  Shield,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// ─── Constantes ───────────────────────────────────────────────────────────────

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_MB   = 5;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// ─── Toast ────────────────────────────────────────────────────────────────────

/**
 * Toast sin dependencias externas.
 * Entra con transición CSS (opacity + translateY), se auto-destruye a los 2.5s.
 */
const Toast = memo(function Toast({ message, type = 'success', onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 2500);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const styles = {
    success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    error:   'bg-red-500/15    border-red-500/30    text-red-400',
  };

  const Icon = type === 'success' ? Check : X;

  return (
    <div
      className={`
        fixed bottom-6 right-6 z-50
        flex items-center gap-3
        px-4 py-3 rounded-xl border
        shadow-2xl shadow-black/50
        backdrop-blur-md
        font-mono text-xs tracking-wide
        animate-in fade-in slide-in-from-bottom-2 duration-200
        ${styles[type]}
      `}
    >
      <Icon size={13} />
      <span>{message}</span>
      <button onClick={onDismiss} className="opacity-50 hover:opacity-100 ml-1">
        <X size={11} />
      </button>
    </div>
  );
});

// ─── Estado local del formulario ──────────────────────────────────────────────

function buildInitialForm(user) {
  return {
    displayName:  user?.displayName ?? '',
    photoPreview: user?.photoURL    ?? null,  // preview local (puede ser Base64 o URL)
    photoFile:    null,                        // File object crudo — solo para validación
    isDirty:      false,
    errors:       {},
  };
}

function formReducer(state, action) {
  switch (action.type) {
    case 'SET_NAME':
      return {
        ...state,
        displayName: action.value,
        isDirty: true,
        errors: { ...state.errors, displayName: undefined },
      };

    case 'SET_PHOTO': {
      return {
        ...state,
        photoPreview: action.preview,  // Data URL leído con FileReader
        photoFile:    action.file,
        isDirty:      true,
        errors:       { ...state.errors, photo: undefined },
      };
    }

    case 'REMOVE_PHOTO':
      return {
        ...state,
        photoPreview: null,
        photoFile:    null,
        isDirty:      true,
      };

    case 'SET_ERROR':
      return { ...state, errors: { ...state.errors, ...action.errors } };

    case 'MARK_CLEAN':
      return { ...state, isDirty: false };

    case 'RESET':
      return buildInitialForm(action.user);

    default:
      return state;
  }
}

// ─── Validación ───────────────────────────────────────────────────────────────

function validateForm({ displayName, photoFile }) {
  const errors = {};

  if (!displayName || displayName.trim().length < 2)
    errors.displayName = 'Mínimo 2 caracteres.';

  if (photoFile) {
    if (!ACCEPTED_MIME.includes(photoFile.type))
      errors.photo = 'Formato no válido. Usa JPG, PNG, WebP o GIF.';
    else if (photoFile.size > MAX_FILE_BYTES)
      errors.photo = `Máximo ${MAX_FILE_MB}MB por imagen.`;
  }

  return errors;
}

// ─── ReadFile helper ──────────────────────────────────────────────────────────

/**
 * Lee un File y devuelve su Data URL.
 * Separado para poder llamarlo con await sin callbacks anidados.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = ()  => reject(new Error('FILE_READ_ERROR'));
    reader.readAsDataURL(file);
  });
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

// ── AvatarEditor ──────────────────────────────────────────────────────────────

const AvatarEditor = memo(function AvatarEditor({ preview, displayName, onFileSelect, onRemove, error }) {
  const inputRef = useRef(null);

  // Iniciales de fallback
  const initials = useMemo(() =>
    displayName
      ? displayName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
      : '??',
    [displayName],
  );

  const handleInputChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validación MIME estricta antes de leer el archivo
    if (!ACCEPTED_MIME.includes(file.type)) {
      onFileSelect(null, null, 'Formato no válido. Usa JPG, PNG, WebP o GIF.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onFileSelect(null, null, `Máximo ${MAX_FILE_MB}MB.`);
      e.target.value = '';
      return;
    }

    try {
      const dataURL = await readFileAsDataURL(file);
      onFileSelect(file, dataURL, null);
    } catch {
      onFileSelect(null, null, 'Error al leer el archivo.');
    }
    // Limpiar input para permitir reselección del mismo archivo
    e.target.value = '';
  }, [onFileSelect]);

  return (
    <div className="flex flex-col items-center gap-5">
      {/* ── Preview circular ──────────────────────────────────────────── */}
      <div className="relative group">
        {/* Zona clickable — 120×120 */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="
            relative w-[120px] h-[120px] rounded-full overflow-hidden
            border-2 border-slate-700 hover:border-cyan-400/60
            transition-all duration-200 focus:outline-none
            focus-visible:ring-2 focus-visible:ring-cyan-400/40
          "
          aria-label="Cambiar avatar"
        >
          {/* Imagen o iniciales */}
          {preview ? (
            <img
              src={preview}
              alt="Avatar preview"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-emerald-500/10 flex items-center justify-center">
              <span className="text-3xl font-mono font-bold text-emerald-400 select-none">
                {initials}
              </span>
            </div>
          )}

          {/* Overlay hover — cian semitransparente */}
          <div className="
            absolute inset-0 bg-cyan-500/0 group-hover:bg-cyan-500/20
            flex items-center justify-center
            transition-all duration-200
          ">
            <Camera
              size={24}
              className="text-white opacity-0 group-hover:opacity-90 transition-opacity duration-200 drop-shadow-lg"
            />
          </div>
        </button>

        {/* Botón eliminar foto — solo si hay preview */}
        {preview && (
          <button
            type="button"
            onClick={onRemove}
            className="
              absolute -bottom-1 -right-1
              w-7 h-7 rounded-full
              bg-[#0d1117] border border-slate-700
              hover:border-red-500/50 hover:bg-red-500/10
              flex items-center justify-center
              text-white/40 hover:text-red-400
              transition-all duration-150
            "
            aria-label="Eliminar avatar"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Input file oculto — solo acepta imágenes */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MIME.join(',')}
        onChange={handleInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Instrucción */}
      <div className="text-center space-y-1">
        <p className="text-xs font-mono text-white/40">
          Haz clic para cambiar el avatar
        </p>
        <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest">
          JPG · PNG · WebP · GIF · Max {MAX_FILE_MB}MB
        </p>
        <p className="text-[10px] font-mono text-cyan-400/50">
          Se comprimirá a 400×400 / JPEG 0.7
        </p>
      </div>

      {/* Error de foto */}
      {error && (
        <p className="text-[11px] font-mono text-red-400 text-center px-2">{error}</p>
      )}
    </div>
  );
});

// ── ReadonlyField ─────────────────────────────────────────────────────────────

const ReadonlyField = memo(function ReadonlyField({ label, value, icon: Icon, mono = false }) {
  return (
    <div>
      <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest mb-1.5">
        {label}
      </label>
      <div className="
        flex items-center gap-3 bg-[#0d1117] border border-slate-800
        rounded-lg px-3 py-2.5 opacity-60 cursor-not-allowed
      ">
        <Icon size={13} className="text-white/20 shrink-0" />
        <span className={`text-sm text-white/50 truncate ${mono ? 'font-mono text-xs' : ''}`}>
          {value || '—'}
        </span>
        <Lock size={11} className="text-white/15 ml-auto shrink-0" />
      </div>
    </div>
  );
});

// ── EditableField ─────────────────────────────────────────────────────────────

const EditableField = memo(function EditableField({ label, value, onChange, error, icon: Icon, placeholder }) {
  return (
    <div>
      <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest mb-1.5">
        {label}
      </label>
      <div className={`
        flex items-center gap-3 bg-[#161b22] border rounded-lg px-3 py-2.5
        transition-colors duration-150
        ${error
          ? 'border-red-500/50 focus-within:border-red-400'
          : 'border-slate-800 focus-within:border-cyan-400/50'
        }
      `}>
        <Icon size={13} className={`shrink-0 ${error ? 'text-red-400' : 'text-white/25'}`} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/20"
          autoComplete="off"
        />
      </div>
      {error && (
        <p className="mt-1 text-[11px] font-mono text-red-400">{error}</p>
      )}
    </div>
  );
});

// ── ProviderBadge ─────────────────────────────────────────────────────────────

const ProviderBadge = memo(function ProviderBadge({ googleId }) {
  const isGoogle = Boolean(googleId);
  return (
    <div className={`
      inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
      border text-[10px] font-mono uppercase tracking-widest
      ${isGoogle
        ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
        : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
      }
    `}>
      <Shield size={10} />
      {isGoogle ? 'Google OAuth' : 'Cuenta Local'}
    </div>
  );
});

// ─── ProfileScreen ────────────────────────────────────────────────────────────

function ProfileScreen({ onBack }) {
  const { user, updateProfile, isLoading } = useAuth();
  const [form, dispatchForm] = useReducer(formReducer, null, () => buildInitialForm(user));
  const [saving, setSaving]   = useState(false);
  const [toast,  setToast]    = useState(null); // { message, type }

  // Sincronizar si el user del contexto cambia (ej. otro tab)
  useEffect(() => {
    dispatchForm({ type: 'RESET', user });
  }, [user?.uid]); // solo al cambiar de usuario, no en cada update

  const dismissToast = useCallback(() => setToast(null), []);

  // ── Handlers del formulario ───────────────────────────────────────────────

  const handleNameChange = useCallback((value) => {
    dispatchForm({ type: 'SET_NAME', value });
  }, []);

  const handleFileSelect = useCallback((file, preview, errorMsg) => {
    if (errorMsg) {
      dispatchForm({ type: 'SET_ERROR', errors: { photo: errorMsg } });
      return;
    }
    dispatchForm({ type: 'SET_PHOTO', file, preview });
  }, []);

  const handleRemovePhoto = useCallback(() => {
    dispatchForm({ type: 'REMOVE_PHOTO' });
  }, []);

  // ── Guardar ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    // Validar antes de tocar el contexto
    const errors = validateForm({ displayName: form.displayName, photoFile: form.photoFile });
    if (Object.keys(errors).length > 0) {
      dispatchForm({ type: 'SET_ERROR', errors });
      return;
    }

    setSaving(true);

    /**
     * Construir el payload de updates.
     * photoPreview puede ser:
     *  - null     → el usuario eliminó su foto (guardar null en DB)
     *  - Data URL → nuevo archivo seleccionado (db.js lo comprimirá)
     *  - string que coincide con user.photoURL → sin cambios (no enviar)
     */
    const updates = {};

    if (form.displayName.trim() !== user?.displayName) {
      updates.displayName = form.displayName.trim();
    }

    // Solo actualizar photoURL si cambió respecto al estado guardado
    const photoChanged = form.photoPreview !== user?.photoURL;
    if (photoChanged) {
      updates.photoURL = form.photoPreview; // null o nuevo Base64
    }

    // Si no hay cambios reales, no llamar al servicio
    if (Object.keys(updates).length === 0) {
      setToast({ message: 'No hay cambios que guardar.', type: 'success' });
      setSaving(false);
      dispatchForm({ type: 'MARK_CLEAN' });
      return;
    }

    const { success, error } = await updateProfile(updates);

    setSaving(false);
    dispatchForm({ type: 'MARK_CLEAN' });

    setToast(
      success
        ? { message: 'Perfil actualizado correctamente.', type: 'success' }
        : { message: error ?? 'Error al guardar.', type: 'error' },
    );
  }, [form, user, updateProfile]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <button
          onClick={onBack}
          className="
            flex items-center gap-2 text-xs font-mono text-white/40
            hover:text-white/80 transition-colors duration-150 group
          "
        >
          <ArrowLeft
            size={14}
            className="transition-transform duration-150 group-hover:-translate-x-0.5"
          />
          Volver al dashboard
        </button>

        <div className="h-4 w-px bg-slate-800" />

        <div>
          <h1 className="text-sm font-mono font-bold text-white">Perfil de Usuario</h1>
          <p className="text-[10px] font-mono text-white/25 mt-0.5 uppercase tracking-widest">
            Identidad · Cuenta · Seguridad
          </p>
        </div>
      </div>

      {/* ── Contenido principal ───────────────────────────────────────────── */}
      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* Grid dos columnas */}
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8">

          {/* ── Columna izquierda: Avatar Editor ──────────────────────────── */}
          <div className="flex flex-col gap-6">
            <div className="bg-[#161b22] border border-slate-800 rounded-xl p-6">
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest mb-5">
                Foto de perfil
              </p>
              <AvatarEditor
                preview={form.photoPreview}
                displayName={form.displayName || user?.displayName}
                onFileSelect={handleFileSelect}
                onRemove={handleRemovePhoto}
                error={form.errors.photo}
              />
            </div>

            {/* Provider badge */}
            <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 space-y-2">
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
                Proveedor de acceso
              </p>
              <ProviderBadge googleId={user?.googleId} />
            </div>
          </div>

          {/* ── Columna derecha: Account Details ──────────────────────────── */}
          <div className="bg-[#161b22] border border-slate-800 rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
                Detalles de la cuenta
              </p>
              {form.isDirty && (
                <span className="text-[10px] font-mono text-cyan-400/60 animate-pulse">
                  · Cambios sin guardar
                </span>
              )}
            </div>

            {/* Nombre editable */}
            <EditableField
              label="Nombre de usuario"
              value={form.displayName}
              onChange={handleNameChange}
              error={form.errors.displayName}
              icon={User}
              placeholder="Tu nombre completo"
            />

            {/* Email — readonly */}
            <ReadonlyField
              label="Email"
              value={user?.email}
              icon={Mail}
            />

            {/* UID — readonly, monoespaciado */}
            <ReadonlyField
              label="User ID"
              value={user?.uid}
              icon={Shield}
              mono
            />

            {/* Separador */}
            <div className="h-px bg-slate-800" />

            {/* Botón guardar */}
            <button
              onClick={handleSave}
              disabled={saving || !form.isDirty}
              className={`
                w-full flex items-center justify-center gap-2.5
                py-2.5 rounded-lg
                font-mono text-xs font-bold
                transition-all duration-150
                ${saving
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400/60 cursor-not-allowed'
                  : form.isDirty
                    ? 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-[#0d1117]'
                    : 'bg-white/[0.03] border border-slate-800 text-white/20 cursor-not-allowed'
                }
              `}
            >
              {saving ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Guardando...</span>
                </>
              ) : (
                <>
                  <Save size={13} />
                  <span>Guardar cambios</span>
                </>
              )}
            </button>

            {/* Hint de compresión */}
            {form.photoFile && !form.errors.photo && (
              <p className="text-[10px] font-mono text-cyan-400/40 text-center">
                La imagen se comprimirá automáticamente al guardar
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Toast de feedback ─────────────────────────────────────────────── */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={dismissToast}
        />
      )}
    </div>
  );
}

export default memo(ProfileScreen);