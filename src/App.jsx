/**
 * @file App.jsx
 * @description Entry point de TaskFlow Enterprise (Fase 3.2).
 *
 * Router ligero sin react-router-dom — gestiona vistas con useState.
 * Evita añadir una dependencia pesada para dos rutas simples.
 *
 * Vistas disponibles (estado autenticado):
 *   'dashboard' → <Dashboard />  (default)
 *   'profile'   → <ProfileScreen />
 *
 * Árbol de providers:
 *   GoogleOAuthProvider
 *     AuthProvider
 *       AuthRouter
 *         AppShell (autenticado)
 *           WorkspaceProvider
 *             NavBar  ← recibe onNavigate
 *             <vista activa>
 */

import { memo, useCallback, useState } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WorkspaceProvider } from './context/WorkspaceContext';
import LoginScreen    from './screens/LoginScreen';
import Dashboard      from './screens/Dashboard';
import ProfileScreen  from './screens/ProfileScreen';
import NavBar         from './components/NavBar';

// ─── Constante del Client ID ──────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

// ─── Vista válidas ────────────────────────────────────────────────────────────

const VIEWS = /** @type {const} */ (['dashboard', 'profile']);

// ─── App Shell ────────────────────────────────────────────────────────────────

const AppShell = memo(function AppShell() {
  const [view, setView] = useState('dashboard');

  /**
   * Cambia la vista activa. Solo acepta vistas registradas en VIEWS.
   * @param {string} target
   */
  const navigate = useCallback((target) => {
    if (VIEWS.includes(target)) setView(target);
  }, []);

  const goBack = useCallback(() => navigate('dashboard'), [navigate]);

  return (
    <WorkspaceProvider>
      <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
        {/* NavBar solo visible en dashboard — en profile tiene su propio header */}
        {view === 'dashboard' && (
          <NavBar onNavigate={navigate} />
        )}

        <main className="flex-1 flex flex-col min-h-0">
          {view === 'dashboard' && <Dashboard />}
          {view === 'profile'   && <ProfileScreen onBack={goBack} />}
        </main>
      </div>
    </WorkspaceProvider>
  );
});

// ─── Router de autenticación ──────────────────────────────────────────────────

function AuthRouter() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
          <span className="font-mono text-xs text-white/30 tracking-widest uppercase">
            Inicializando
          </span>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <AppShell /> : <LoginScreen />;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <AuthRouter />
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}