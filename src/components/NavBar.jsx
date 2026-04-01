/**
 * @file NavBar.jsx
 * @description Barra de navegación principal de TaskFlow Enterprise.
 * Muestra avatar (Base64 o iniciales), nombre de usuario y menú de logout.
 * Componente puro — sin estado local más allá del toggle del dropdown.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  LogOut,
  Settings,
  TrendingUp,
  User,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// ─── Subcomponentes ───────────────────────────────────────────────────────────

/** Avatar: photo Base64 con fallback a iniciales generadas */
const UserAvatar = memo(function UserAvatar({ user, size = 'md' }) {
  const sizeClasses = {
    sm: 'w-7 h-7 text-[10px]',
    md: 'w-8 h-8 text-xs',
  };

  const initials = user?.displayName
    ? user.displayName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '??';

  if (user?.photoURL) {
    return (
      <img
        src={user.photoURL}
        alt={user.displayName}
        className={`${sizeClasses[size]} rounded-full object-cover border border-white/10`}
      />
    );
  }

  return (
    <div
      className={`
        ${sizeClasses[size]} rounded-full flex items-center justify-center
        bg-emerald-500/20 border border-emerald-500/30
        text-emerald-400 font-mono font-bold select-none
      `}
    >
      {initials}
    </div>
  );
});

/** Ítem del dropdown menu */
const DropdownItem = memo(function DropdownItem({ icon: Icon, label, onClick, variant = 'default' }) {
  const variants = {
    default: 'text-white/60 hover:text-white hover:bg-white/[0.05]',
    danger: 'text-red-400/80 hover:text-red-400 hover:bg-red-500/10',
  };

  return (
    <button
      onClick={onClick}
      className={`
        w-full flex items-center gap-2.5 px-3 py-2 text-xs font-mono
        rounded-md transition-colors duration-150
        ${variants[variant]}
      `}
    >
      <Icon size={13} />
      <span>{label}</span>
    </button>
  );
});

// ─── NavBar principal ─────────────────────────────────────────────────────────

function NavBar({ onOpenSettings }) {
  const { user, logout } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Cerrar dropdown al click fuera
  useEffect(() => {
    function handleOutsideClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [dropdownOpen]);

  const toggleDropdown = useCallback(() => setDropdownOpen((v) => !v), []);

  const handleLogout = useCallback(() => {
    setDropdownOpen(false);
    logout();
  }, [logout]);

  const handleSettings = useCallback(() => {
    setDropdownOpen(false);
    onOpenSettings?.();
  }, [onOpenSettings]);

  return (
    <header className="
      h-14 border-b border-white/[0.06] bg-[#0d1117]/95 backdrop-blur-md
      flex items-center justify-between px-5
      sticky top-0 z-50
    ">
      {/* ── Logo ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <TrendingUp size={14} className="text-emerald-400" />
        </div>
        <span className="font-mono font-bold text-white text-sm tracking-tight">
          TaskFlow<span className="text-emerald-400">.</span>
        </span>
        <span className="hidden sm:block text-[10px] font-mono text-white/20 border border-white/[0.08] rounded px-1.5 py-0.5 tracking-widest uppercase">
          Enterprise
        </span>
      </div>

      {/* ── User Dropdown ───────────────────────────────────────────────── */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={toggleDropdown}
          className="
            flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-lg
            border border-transparent hover:border-white/[0.08]
            hover:bg-white/[0.03]
            transition-all duration-150 group
          "
          aria-expanded={dropdownOpen}
          aria-haspopup="true"
        >
          <UserAvatar user={user} size="sm" />
          <div className="hidden sm:block text-left">
            <p className="text-xs font-mono text-white/80 leading-none">
              {user?.displayName ?? '—'}
            </p>
            <p className="text-[10px] font-mono text-white/30 mt-0.5 leading-none truncate max-w-[130px]">
              {user?.email ?? ''}
            </p>
          </div>
          <ChevronDown
            size={12}
            className={`
              text-white/30 transition-transform duration-200
              ${dropdownOpen ? 'rotate-180' : ''}
            `}
          />
        </button>

        {/* Dropdown panel */}
        {dropdownOpen && (
          <div className="
            absolute right-0 top-full mt-2 w-52
            bg-[#161b22] border border-white/[0.08] rounded-xl
            shadow-2xl shadow-black/50 overflow-hidden
            animate-in fade-in slide-in-from-top-1 duration-150
          ">
            {/* User info header */}
            <div className="px-3 pt-3 pb-2.5 border-b border-white/[0.06]">
              <div className="flex items-center gap-2.5">
                <UserAvatar user={user} size="md" />
                <div className="min-w-0">
                  <p className="text-xs font-mono text-white font-medium truncate">
                    {user?.displayName}
                  </p>
                  <p className="text-[10px] font-mono text-white/30 truncate">
                    {user?.email}
                  </p>
                </div>
              </div>
            </div>

            {/* Acciones */}
            <div className="p-1.5 space-y-0.5">
              <DropdownItem
                icon={User}
                label="Mi perfil"
                onClick={handleSettings}
              />
              <DropdownItem
                icon={Settings}
                label="Configuración"
                onClick={handleSettings}
              />
              <div className="h-px bg-white/[0.06] my-1" />
              <DropdownItem
                icon={LogOut}
                label="Cerrar sesión"
                onClick={handleLogout}
                variant="danger"
              />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

export default memo(NavBar);
