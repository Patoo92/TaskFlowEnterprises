/**
 * @file main.jsx
 * @description Punto de entrada de la aplicación React.
 * No se registran providers adicionales aquí; el árbol de contextos
 * se gestiona dentro de App.jsx (AuthProvider → WorkspaceProvider).
 */
 
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
 
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
 