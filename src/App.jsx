/**
 * @file App.jsx
 * @description Entry point de TaskFlow Enterprise.
 *
 * Árbol de providers (de exterior a interior):
 *   GoogleOAuthProvider  ← requiere VITE_GOOGLE_CLIENT_ID en .env
 *     AuthProvider       ← sesión, login/register/google
 *       AuthRouter
 *         AppShell (si autenticado)
 *           WorkspaceProvider
 *             NavBar + Dashboard
 *
 * GoogleOAuthProvider debe estar POR ENCIMA de AuthProvider porque
 * <GoogleLogin /> necesita acceder al contexto de Google OAuth.
 */

import { memo } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WorkspaceProvider } from './context/WorkspaceContext';
import LoginScreen from './screens/LoginScreen';
import Dashboard from './screens/Dashboard';
import NavBar from './components/NavBar';

// ─── Constante del Client ID ──────────────────────────────────────────────────

/**
 * El CLIENT_ID se lee desde variables de entorno de Vite.
 * Crear un archivo `.env.local` en la raíz del proyecto con:
 *   VITE_GOOGLE_CLIENT_ID=tu_client_id_aqui.apps.googleusercontent.com
 *
 * NUNCA hacer commit de este archivo — añadirlo a .gitignore.
 */
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

// ─── App Shell ────────────────────────────────────────────────────────────────

const AppShell = memo(function AppShell() {
  return (
    <WorkspaceProvider>
      <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
        <NavBar />
        <main className="flex-1 flex flex-col min-h-0">
          <Dashboard />
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