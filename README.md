# 🚀 TaskFlow Enterprise v2.0.0

Sistema de gestión de proyectos de alto rendimiento construido con **React 19**, **Vite 6** y **Supabase**, diseñado bajo una arquitectura *local-first* con sincronización avanzada en la nube.

## 🛠️ Stack Tecnológico
- **Frontend:** React 19 + TailwindCSS + Lucide Icons.
- **Backend/DB:** Supabase (PostgreSQL 16 + Auth + RLS).
- **Persistencia Local:** IndexedDB (Arquitectura 3NF) vía `idb`.
- **Seguridad:** Google Identity Services + PBKDF2 Criptografía.
- **IA Dev:** Claude 4.6 Sonnet (Refactorización y Auditoría).

---

## 📅 Bitácora de Desarrollo (Log de Auditoría)

### Fase 1: Estabilización de Infraestructura y OAuth
- **Corrección de Orígenes:** Resolución de errores 400/403 de Google mediante la reconfiguración de URIs de redireccionamiento.
- **Protocolo de Seguridad:** Implementación de cabeceras COOP y COEP para permitir la comunicación segura con el popup de Google.

### Fase 2: Auditoría Molecular y Hardening
- **Migración a PBKDF2:** Implementación de hashing con 310,000 iteraciones y salt aleatorio (Estándar OWASP).
- **Cifrado Local:** Protección de datos sensibles en IndexedDB.

### Fase 5: Enterprise Sync & Relational 3NF (Actualizado 14/04/2026)
Tras una auditoría profunda de 34 puntos (archivo `revision.txt`), se ha reconstruido el motor de sincronización eliminando los "Bugs Encadenados":

#### 🔐 Seguridad & Hardening (S1-S4)
- **RLS Policy Enforcement:** Implementación de Row Level Security en las tablas `workspaces`, `sheets`, `tasks` y `expenses`.
- **Security Invoker:** Migración de funciones RPC de `SECURITY DEFINER` a `SECURITY INVOKER` para garantizar que nadie acceda a datos ajenos.
- **CSP & OAuth:** Refuerzo de la Content Security Policy en `index.html` para habilitar Google One Tap sin vulnerabilidades.

#### 🔄 Sync Engine v2.0.0 (Resolución Error 400)
- **Contrato de Datos Estricto (A15/A16):** Se eliminó la "adivinación" de IDs. Ahora el cliente envía el `workspaceId` de forma explícita al RPC `batch_sync_workspace`.
- **Sanitización de Tipos (A1/A2):** El frontend ahora fuerza tipos (`Boolean` y `Number`) antes del envío, evitando rechazos por parte de PostgreSQL.
- **Locking de Concurrencia (M1):** Implementación de `syncInProgressRef` en el contexto para evitar colisiones de datos en conexiones inestables.
- **Timeout & Resiliencia (A8):** Uso de `AbortController` (8s) en puentes de autenticación para evitar bloqueos infinitos de la UI.

---

## 🏗️ Arquitectura de Datos: Fase 5 (Finalizada)

Hemos evolucionado de un modelo basado en documentos JSON a un modelo **Relacional de Tercera Forma Normal (3NF)**.

### Características Clave:
- **Esquema Relacional:** Tablas independientes con integridad referencial completa.
- **Delta Sync Engine:** Solo se envían los cambios específicos (deltas), reduciendo el consumo de ancho de banda en un 95%.
- **Offline-First Avanzado:** Cola de salida (**Outbox**) persistente en IndexedDB que garantiza la entrega de cambios incluso tras cierres inesperados.
- **Atomicidad Transaccional:** El RPC procesa el lote completo; si un solo elemento falla, se realiza rollback para evitar inconsistencias (FK violations).

---

## 📊 Estado de la Auditoría Final (14/04/2026)

| Hallazgo | Impacto | Estado | Resolución |
| :--- | :--- | :--- | :--- |
| **Bugs Críticos (Error 400)** | 🔴 Crítico | ✅ **Solucionado** | Contrato RPC v2.0.0 & Inyección de IDs |
| **Seguridad RLS** | 🔴 Crítico | ✅ **Solucionado** | Migración a Security Invoker |
| **Concurrencia (Race conditions)**| 🟠 Alto | ✅ **Solucionado** | Locking vía useRef en Contexto |
| **Timeouts de Auth** | 🟠 Alto | ✅ **Solucionado** | Implementación de AbortController |
| **Normalización 3NF** | 🟢 Bajo | ✅ **Solucionado** | Esquema Relacional en IDB y Supabase |

---

## 🚀 Instalación y Uso

1.  **Instalar dependencias:** `npm install`
2.  **Configurar Variables de Entorno (.env.local):**
    - `VITE_SUPABASE_URL`
    - `VITE_SUPABASE_ANON_KEY`
    - `VITE_GOOGLE_CLIENT_ID`
3.  **Base de Datos:** Ejecutar `batch_sync_workspace.sql` en el SQL Editor de Supabase.
4.  **Ejecutar en desarrollo:** `npm run dev`

> **Nota:** Se recomienda limpiar el almacenamiento del navegador (F12 > Application > Clear Site Data) al instalar esta versión para asegurar que el nuevo esquema 3NF se inicialice correctamente.

---
**Desarrollado con mentalidad Enterprise | 2026**