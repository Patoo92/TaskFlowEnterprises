# 🚀 TaskFlow Enterprise v1.0.1

Sistema de gestión de proyectos de alto rendimiento construido con **React 18**, **Vite 5** y **Supabase**, diseñado bajo una arquitectura *local-first* con sincronización en la nube.

## 🛠️ Stack Tecnológico
- **Frontend:** React + TailwindCSS + Lucide Icons.
- **Backend/DB:** Supabase (PostgreSQL + Auth + Realtime).
- **Persistencia Local:** IndexedDB (vía librería `idb`).
- **Seguridad:** Google Identity Services + PBKDF2 Criptografía.

---

## 📅 Bitácora de Desarrollo (Log de Auditoría)

### Fase 1: Estabilización de Infraestructura y OAuth (Ayer)
- **Corrección de Orígenes:** Resolución de errores 400/403 de Google mediante la reconfiguración de URIs de redireccionamiento y orígenes de JavaScript.
- **Protocolo de Seguridad de Navegador:** Implementación de cabeceras COOP (Cross-Origin-Opener-Policy) y COEP en el servidor de desarrollo Vite para permitir la comunicación segura entre el popup de Google y la aplicación.
- **Persistencia de Sesión:** Sincronización exitosa entre Supabase Auth y el estado local de React.

### Fase 2: Auditoría Molecular y Hardening (Hoy)
Realizamos una auditoría profunda de la arquitectura, resultando en las siguientes mejoras críticas:

#### 🔐 Seguridad & Criptografía
- **Migración a PBKDF2:** Se eliminó el hashing SHA-256 simple por PBKDF2 con 310,000 iteraciones y salt aleatorio, cumpliendo con los estándares **OWASP 2024**.
- **Content Security Policy (CSP):** Implementación de una política de seguridad de contenido estricta en el `index.html` para mitigar ataques XSS y Clickjacking.
- **Validación de Tokens:** Hardening del proceso de decodificación de JWT de Google con verificación de expiración (`exp`).

#### ⚡ Optimización de Rendimiento
- **OffscreenCanvas:** La compresión de imágenes para avatares ahora se realiza fuera del hilo principal del navegador (Off-thread) cuando está disponible, eliminando bloqueos de UI.
- **Refactor de Reducer:** Reducción de la complejidad ciclomática en el `WorkspaceContext` mediante la implementación de helpers de actualización funcional, mejorando la mantenibilidad.
- **Cookie Optimization:** Reducción del payload de la cookie de sesión (`tf_session`) eliminando datos Base64 para garantizar compatibilidad con límites de 4KB por cabecera HTTP.

---

## 🏗️ Plan de Escalabilidad (Roadmap 100x)
El sistema está preparado para escalar de 500 a 50,000 usuarios mediante los siguientes hitos:
1.  **Fase A:** Implementación de PgBouncer en Supabase para manejo masivo de conexiones.
2.  **Fase B:** Normalización del modelo de datos de "Bloque JSON" a tablas relacionales (`sheets`, `tasks`, `expenses`).
3.  **Fase C:** Implementación de *Sync Delta* para reducir el consumo de ancho de banda en un 95%.

---

## 🚀 Instalación y Uso

1. Instalar dependencias: `npm install`
2. Configurar variables de entorno en `.env.local` (Supabase URL/Key y Google Client ID).
3. Ejecutar en desarrollo: `npm run dev`

> **Nota de Seguridad:** Al realizar cambios en el sistema de hashing, si tienes datos locales previos, se recomienda limpiar el almacenamiento del navegador (F12 > Application > Clear Site Data) para asegurar que el nuevo protocolo PBKDF2 tome efecto correctamente.

---
**Desarrollado con mentalidad Enterprise | 2026**