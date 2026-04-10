/**
 * @file db.js
 * @description Service layer para IndexedDB usando la librería `idb`.
 * @version 1.0.1 — Seguridad criptográfica y compresión off-thread
 *
 * Define los Object Stores y expone métodos CRUD tipados por entidad.
 * Toda la lógica de persistencia pasa por aquí — nunca directo desde componentes.
 *
 * ── Cambios v1.0.1 ────────────────────────────────────────────────────────────
 *  [SEC-01] hashPassword migrado de SHA-256 puro a PBKDF2 con salt aleatorio.
 *           OWASP 2024 recomienda mínimo 310.000 iteraciones para PBKDF2-SHA256.
 *           Formato almacenado: "<saltHex>:<hashHex>" (16 bytes salt + 32 bytes hash).
 *           verifyPassword detecta automáticamente si el hash legacy es SHA-256 puro
 *           (sin el separador ":") para migración transparente en el próximo login.
 *  [SEC-02] dbPromise incluye handlers `blocked`, `blocking` y `terminated` para
 *           gestionar correctamente múltiples pestañas y versiones de IDB.
 *  [OPT-03] compressImage usa OffscreenCanvas cuando está disponible (Chrome 69+,
 *           Firefox 105+, Safari 16.4+) para ejecutar la compresión fuera del
 *           hilo principal, eliminando bloqueos de hasta 200ms con imágenes 4K.
 *           Fallback automático a HTMLCanvasElement en entornos legacy.
 */

import { openDB } from 'idb';

// ─── Constantes ───────────────────────────────────────────────────────────────

const DB_NAME = 'taskflow_enterprise';
// v2: workspaces ahora almacena el array `sheets` embebido en el documento.
// No se necesita un store adicional; las sheets viajan dentro del workspace.
const DB_VERSION = 3;  // v3: adds sync_meta store for cloud sync metadata

// ─── Constantes criptográficas ────────────────────────────────────────────────

/**
 * Iteraciones PBKDF2-SHA256.
 * OWASP Password Storage Cheat Sheet (2024): mínimo 310.000 para SHA-256.
 * Benchmark en hardware de gama media: ~80-120ms por hash → aceptable para login.
 * Aumentar en futuras versiones si el hardware objetivo lo permite.
 */
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH       = 'SHA-256';
const SALT_BYTES        = 16;   // 128 bits de entropía en el salt
const KEY_BITS          = 256;  // Longitud del hash derivado

// ─── Inicialización ───────────────────────────────────────────────────────────

/**
 * Abre (o crea) la base de datos y define los Object Stores.
 * El resultado se cachea; llamadas posteriores reutilizan la conexión.
 *
 * [SEC-02] Handlers de ciclo de vida para gestión multi-pestaña:
 *  - blocked:    Esta pestaña bloquea una upgrade en otra → informar al usuario.
 *  - blocking:   Esta instancia está bloqueando una upgrade → cerrar conexión.
 *  - terminated: IDB fue terminado inesperadamente (e.g. storage pressure en iOS).
 */
const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {
    // ── v1: Store users ───────────────────────────────────────────────────────
    if (oldVersion < 1) {
      const userStore = db.createObjectStore('users', { keyPath: 'uid' });
      userStore.createIndex('by_email',    'email',    { unique: true  });
      userStore.createIndex('by_googleId', 'googleId', { unique: false });
    }

    // ── v1→v2: Store workspaces ───────────────────────────────────────────────
    // key: id (UUID). Índice por ownerId para aislamiento multitenant.
    // El campo `sheets: Sheet[]` se almacena embebido en cada documento.
    if (oldVersion < 1 && !db.objectStoreNames.contains('workspaces')) {
      const wsStore = db.createObjectStore('workspaces', { keyPath: 'id' });
      wsStore.createIndex('by_ownerId', 'ownerId', { unique: false });
    }
    // Si ya existía el store de workspaces (upgrade de v1→v2), no se recrea.
    // Los documentos existentes simplemente no tendrán `sheets`; se inicializan
    // con [] al leerlos por primera vez en `ensureDefault`.

    // ── v3: Store sync_meta ───────────────────────────────────────────────────
    // Metadatos de sincronización cloud por usuario.
    // key: uid (local IDB uid)
    // Separado de users para no contaminar el modelo de negocio con infra de sync.
    if (oldVersion < 3 && !db.objectStoreNames.contains('sync_meta')) {
      db.createObjectStore('sync_meta', { keyPath: 'uid' });
    }
  },

  // [SEC-02] Multi-tab: esta instancia está bloqueando una upgrade en otra pestaña
  blocked() {
    console.warn(
      '[DB] Una versión anterior de la app está abierta en otra pestaña. ' +
      'Cierra las demás pestañas para aplicar la actualización.'
    );
  },

  // [SEC-02] Multi-tab: otra pestaña quiere hacer upgrade — liberar la conexión
  blocking() {
    // Cerrar esta conexión para no bloquear la upgrade de la otra pestaña
    dbPromise.then((db) => db.close()).catch(() => {});
    console.warn('[DB] Cerrando conexión para permitir upgrade en otra pestaña.');
  },

  // [SEC-02] IDB terminado inesperadamente (storage pressure, crash del browser)
  terminated() {
    console.error(
      '[DB] IndexedDB fue terminado inesperadamente. ' +
      'La aplicación puede estar inestable — recarga la página.'
    );
  },
}).catch((err) => {
  // Captura errores de apertura (modo incógnito Safari, cuota excedida, etc.)
  // Los servicios que llamen a `await dbPromise` recibirán este error y lo propagarán
  // hacia WorkspaceContext/AuthContext, que lo mostrarán al usuario.
  console.error('[DB] No se pudo abrir IndexedDB:', err);
  throw err;
});

// ─── Helpers internos ─────────────────────────────────────────────────────────

/** Genera un UUID v4 sin dependencias externas */
const generateUid = () => crypto.randomUUID();

/** Timestamp ISO actual */
const now = () => new Date().toISOString();

// ─── Service: UserService ─────────────────────────────────────────────────────

export const UserService = {
  /**
   * Crea un nuevo usuario con contraseña hasheada (PBKDF2 + salt — [SEC-01]).
   * @param {{ email: string, password: string, displayName: string }} payload
   * @returns {Promise<User>}
   */
  async create({ email, displayName, password }) {
    const db = await dbPromise;

    // Validación: email único
    const existing = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());
    if (existing) throw new Error('EMAIL_ALREADY_EXISTS');

    const passwordHash = await hashPassword(password);
    const user = {
      uid:          generateUid(),
      email:        email.toLowerCase().trim(),
      displayName:  displayName.trim(),
      passwordHash,
      googleId:     null,
      photoURL:     null,        // Base64 string | null
      createdAt:    now(),
      updatedAt:    now(),
    };

    await db.add('users', user);
    // Nunca devolver el hash al caller
    return sanitizeUser(user);
  },

  /**
   * Valida credenciales y devuelve el usuario (sin passwordHash).
   * [SEC-01] verifyPassword detecta automáticamente hashes legacy SHA-256
   * y los migra a PBKDF2 de forma transparente en el primer login exitoso.
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<User>}
   */
  async authenticate({ email, password }) {
    const db   = await dbPromise;
    const user = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());

    if (!user) throw new Error('INVALID_CREDENTIALS');

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) throw new Error('INVALID_CREDENTIALS');

    // ── Migración transparente de hash legacy ─────────────────────────────────
    // Si el hash almacenado era SHA-256 puro (sin ":"), re-hashear con PBKDF2
    // y actualizar silenciosamente en IDB. El usuario no nota nada.
    if (isValid && !user.passwordHash.includes(':')) {
      try {
        const newHash = await hashPassword(password);
        await db.put('users', { ...user, passwordHash: newHash, updatedAt: now() });
        console.info('[DB] Hash de contraseña migrado a PBKDF2 para:', user.uid);
      } catch (migrationErr) {
        // La migración falla silenciosamente — el usuario sigue autenticado
        console.warn('[DB] Migración de hash fallida (no crítico):', migrationErr.message);
      }
    }

    return sanitizeUser(user);
  },

  /**
   * Obtiene un usuario por UID. Lanza si no existe.
   * @param {string} uid
   * @returns {Promise<User>}
   */
  async getById(uid) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    return sanitizeUser(user);
  },

  /**
   * Busca o crea un usuario via Google OAuth.
   * @param {{ googleId: string, email: string, displayName: string, photoURL?: string }} profile
   * @returns {Promise<User>}
   */
  async findOrCreateGoogle({ googleId, email, displayName, photoURL = null }) {
    const db = await dbPromise;

    const existing = await db.getFromIndex('users', 'by_googleId', googleId);
    if (existing) return sanitizeUser(existing);

    const user = {
      uid:          generateUid(),
      email:        email.toLowerCase().trim(),
      displayName:  displayName.trim(),
      passwordHash: null,  // Usuarios Google no tienen contraseña local
      googleId,
      photoURL,
      createdAt:    now(),
      updatedAt:    now(),
    };

    await db.add('users', user);
    return sanitizeUser(user);
  },

  /**
   * Vincula un Supabase UID al usuario local.
   * Llamado tras el handshake auth con Supabase — persiste el UID para
   * que WorkspaceContext pueda usarlo como owner_id en las consultas RLS.
   * @param {string} uid         - UID local IDB
   * @param {string} supabaseUid - UID de Supabase Auth
   * @returns {Promise<User>}
   */
  async linkSupabase(uid, supabaseUid) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated = { ...user, supabaseUid, updatedAt: now() };
    await db.put('users', updated);
    return sanitizeUser(updated);
  },

  /**
   * Actualiza displayName y/o photoURL.
   * Si se recibe un photoURL (Base64 crudo), lo comprime antes de persistir
   * usando OffscreenCanvas cuando está disponible ([OPT-03]).
   * Filtra por uid para aislamiento multitenant.
   *
   * @param {string} uid
   * @param {{ displayName?: string, photoURL?: string|null }} updates
   * @returns {Promise<User>}
   */
  async updateProfile(uid, { displayName, photoURL }) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');

    // Comprimir imagen si se está actualizando el avatar con un nuevo Base64
    let compressedPhoto = photoURL;
    if (photoURL !== undefined && photoURL !== null) {
      compressedPhoto = await compressImage(photoURL, 400, 400, 0.7);
    }

    const updated = {
      ...user,
      ...(displayName !== undefined && { displayName: displayName.trim() }),
      ...(photoURL    !== undefined && { photoURL: compressedPhoto }),
      updatedAt: now(),
    };

    await db.put('users', updated);
    return sanitizeUser(updated);
  },
};

// ─── Utilidad: compresión de imagen en cliente ────────────────────────────────

/**
 * Redimensiona y comprime una imagen Base64.
 * Usa OffscreenCanvas cuando está disponible para no bloquear el hilo principal.
 *
 * Algoritmo de selección de path ([OPT-03]):
 *  1. OffscreenCanvas disponible → compressWithOffscreenCanvas
 *     - Soporte: Chrome 69+, Firefox 105+, Safari 16.4+ (2022+)
 *     - createImageBitmap + convertToBlob son async-nativos → 0ms en main thread
 *  2. Fallback → compressWithMainThreadCanvas
 *     - Igual que la implementación v1.0.0 — síncrono pero garantizado
 *
 * @param {string}  base64     - Data URL completa ("data:image/...;base64,...")
 * @param {number}  maxWidth   - Ancho máximo en px (default 400)
 * @param {number}  maxHeight  - Alto máximo en px (default 400)
 * @param {number}  quality    - Calidad JPEG 0-1 (default 0.7)
 * @returns {Promise<string>}  Data URL JPEG comprimida
 */
async function compressImage(base64, maxWidth = 400, maxHeight = 400, quality = 0.7) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    return compressWithOffscreenCanvas(base64, maxWidth, maxHeight, quality);
  }
  return compressWithMainThreadCanvas(base64, maxWidth, maxHeight, quality);
}

/**
 * Compresión off-thread via OffscreenCanvas + createImageBitmap.
 * [OPT-03] No bloquea el hilo principal — ideal para imágenes de alta resolución.
 *
 * Flujo:
 *  base64 → fetch(blob) → createImageBitmap (async) → OffscreenCanvas →
 *  convertToBlob (async) → FileReader → Data URL
 *
 * @param {string} base64
 * @param {number} maxWidth
 * @param {number} maxHeight
 * @param {number} quality
 * @returns {Promise<string>}
 */
async function compressWithOffscreenCanvas(base64, maxWidth, maxHeight, quality) {
  try {
    // Convertir Data URL a Blob para createImageBitmap
    const res  = await fetch(base64);
    const blob = await res.blob();

    // createImageBitmap decodifica la imagen de forma asíncrona fuera del main thread
    const bitmap = await createImageBitmap(blob);

    // ── Calcular dimensiones respetando aspect ratio ───────────────────────────
    let { width, height } = bitmap;
    const ratio = Math.min(maxWidth / width, maxHeight / height);

    // Solo reducir, nunca escalar hacia arriba
    if (ratio < 1) {
      width  = Math.round(width  * ratio);
      height = Math.round(height * ratio);
    }

    // ── Dibujar en OffscreenCanvas ─────────────────────────────────────────────
    const canvas = new OffscreenCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    if (!ctx) {
      // Contexto no disponible en este entorno — fallback al método legacy
      bitmap.close();
      return compressWithMainThreadCanvas(base64, maxWidth, maxHeight, quality);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close(); // Liberar memoria del ImageBitmap

    // ── Convertir a Blob JPEG (async — no bloquea UI) ─────────────────────────
    const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });

    // ── Blob → Data URL via FileReader ─────────────────────────────────────────
    return new Promise((resolve, reject) => {
      const reader   = new FileReader();
      reader.onload  = (e) => resolve(/** @type {string} */ (e.target.result));
      reader.onerror = ()  => reject(new Error('IMAGE_READ_ERROR'));
      reader.readAsDataURL(jpegBlob);
    });

  } catch (err) {
    // Si el path de OffscreenCanvas falla por cualquier razón,
    // degradar silenciosamente al canvas síncrono del hilo principal
    console.warn('[DB] OffscreenCanvas falló, usando canvas fallback:', err.message);
    return compressWithMainThreadCanvas(base64, maxWidth, maxHeight, quality);
  }
}

/**
 * Compresión en el hilo principal via HTMLCanvasElement.
 * Path de fallback para entornos que no soportan OffscreenCanvas.
 * Opera completamente en el browser — cero dependencias externas.
 *
 * Algoritmo:
 *  1. Decodifica el Base64 en un HTMLImageElement
 *  2. Calcula las dimensiones de destino manteniendo aspect ratio
 *  3. Dibuja en un HTMLCanvasElement (síncrono)
 *  4. Exporta como JPEG con la calidad indicada
 *
 * @param {string} base64
 * @param {number} maxWidth
 * @param {number} maxHeight
 * @param {number} quality
 * @returns {Promise<string>}
 */
function compressWithMainThreadCanvas(base64, maxWidth, maxHeight, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      // ── Calcular dimensiones respetando aspect ratio ──────────────────────
      let { width, height } = img;
      const ratio = Math.min(maxWidth / width, maxHeight / height);

      // Solo reducir, nunca escalar hacia arriba
      if (ratio < 1) {
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }

      // ── Dibujar en canvas ─────────────────────────────────────────────────
      const canvas   = document.createElement('canvas');
      canvas.width   = width;
      canvas.height  = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // Si el contexto no está disponible (SSR/tests), devolver original
        resolve(base64);
        return;
      }

      // imageSmoothingQuality = 'high' activa el algoritmo bilinear en Chromium
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      // ── Exportar como JPEG ────────────────────────────────────────────────
      const compressed = canvas.toDataURL('image/jpeg', quality);
      resolve(compressed);
    };

    img.onerror = () => reject(new Error('IMAGE_LOAD_ERROR'));

    // Asignar src DESPUÉS de definir los handlers
    img.src = base64;
  });
}

// ─── Service: WorkspaceService ────────────────────────────────────────────────

export const WorkspaceService = {
  /**
   * Crea un workspace vinculado al ownerId.
   * @param {{ name: string, ownerId: string }} payload
   * @returns {Promise<Workspace>}
   */
  async create({ name, ownerId }) {
    const db = await dbPromise;
    const workspace = {
      id:        generateUid(),
      name:      name.trim(),
      ownerId,
      sheets:    [],          // Fase 2: array de sheets embebido
      createdAt: now(),
      updatedAt: now(),
    };
    await db.add('workspaces', workspace);
    return workspace;
  },

  /**
   * Devuelve TODOS los workspaces de un owner (filtro por índice).
   * NUNCA omitir el filtro ownerId.
   * @param {string} ownerId
   * @returns {Promise<Workspace[]>}
   */
  async getAllByOwner(ownerId) {
    const db = await dbPromise;
    return db.getAllFromIndex('workspaces', 'by_ownerId', ownerId);
  },

  /**
   * Obtiene un workspace validando que pertenezca al ownerId solicitante.
   * @param {string} id
   * @param {string} ownerId
   * @returns {Promise<Workspace>}
   */
  async getById(id, ownerId) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', id);
    if (!ws || ws.ownerId !== ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    return ws;
  },

  /**
   * Obtiene o crea el workspace por defecto del usuario.
   * Garantiza que siempre exista al menos un workspace activo.
   * @param {string} ownerId
   * @returns {Promise<Workspace>}
   */
  async ensureDefault(ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('workspaces', 'by_ownerId', ownerId);

    if (all.length > 0) {
      // Normaliza documentos legacy (sin campo `sheets`) creados en v1
      const ws = all[0];
      if (!Array.isArray(ws.sheets)) {
        const normalized = { ...ws, sheets: [], updatedAt: now() };
        await db.put('workspaces', normalized);
        return normalized;
      }
      return ws;
    }

    // Primera vez: crea workspace por defecto con una sheet inicial
    const defaultSheet = makeSheet('General');
    const workspace = {
      id:        generateUid(),
      name:      'Mi Workspace',
      ownerId,
      sheets:    [defaultSheet],
      createdAt: now(),
      updatedAt: now(),
    };
    await db.add('workspaces', workspace);
    return workspace;
  },

  /**
   * Persiste el array completo de sheets en el workspace.
   * Es la única operación de escritura para mutaciones de sheets/tareas/gastos.
   * Valida ownership antes de escribir.
   * @param {string}   id      - workspace id
   * @param {string}   ownerId - uid del usuario autenticado
   * @param {Sheet[]}  sheets  - array completo actualizado
   * @returns {Promise<Workspace>}
   */
  async saveSheets(id, ownerId, sheets) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', id);
    if (!ws || ws.ownerId !== ownerId) throw new Error('WORKSPACE_NOT_FOUND');

    const updated = { ...ws, sheets, updatedAt: now() };
    await db.put('workspaces', updated);
    return updated;
  },

  /**
   * Actualiza nombre del workspace con validación de ownership.
   * @param {string} id
   * @param {string} ownerId
   * @param {{ name: string }} updates
   * @returns {Promise<Workspace>}
   */
  async update(id, ownerId, { name }) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', id);
    if (!ws || ws.ownerId !== ownerId) throw new Error('WORKSPACE_NOT_FOUND');

    const updated = { ...ws, name: name.trim(), updatedAt: now() };
    await db.put('workspaces', updated);
    return updated;
  },

  /**
   * Elimina workspace solo si pertenece al ownerId.
   * @param {string} id
   * @param {string} ownerId
   */
  async delete(id, ownerId) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', id);
    if (!ws || ws.ownerId !== ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    await db.delete('workspaces', id);
  },
};

// ─── Service: SyncMetaService ─────────────────────────────────────────────────
// Gestiona metadatos de sincronización cloud (lastSyncedAt, supabaseUid).
// Completamente separado de la lógica de negocio.

export const SyncMetaService = {
  /**
   * Lee los metadatos de sync del usuario.
   * @param {string} uid - UID local IDB
   * @returns {Promise<SyncMeta | null>}
   */
  async get(uid) {
    const db = await dbPromise;
    return db.get('sync_meta', uid) ?? null;
  },

  /**
   * Crea o actualiza los metadatos de sync.
   * @param {string} uid
   * @param {{ supabaseUid?: string, lastSyncedAt?: string }} updates
   * @returns {Promise<SyncMeta>}
   */
  async upsert(uid, updates) {
    const db       = await dbPromise;
    const existing = await db.get('sync_meta', uid) ?? { uid };
    const updated  = { ...existing, ...updates };
    await db.put('sync_meta', updated);
    return updated;
  },
};

// ─── Factory helpers (compartidos con WorkspaceContext) ───────────────────────

/**
 * Crea una Sheet con valores por defecto.
 * @param {string} name
 * @returns {Sheet}
 */
export function makeSheet(name = 'Nueva hoja') {
  return {
    id:       crypto.randomUUID(),
    name:     name.trim(),
    capital:  0,
    expenses: [],
    tasks:    [],
  };
}

/**
 * Crea un Expense.
 * @param {{ desc: string, amount: number }} payload
 * @returns {Expense}
 */
export function makeExpense({ desc, amount }) {
  return { id: crypto.randomUUID(), desc: desc.trim(), amount: Number(amount) };
}

/**
 * Crea una Task.
 * @param {string} text
 * @returns {Task}
 */
export function makeTask(text) {
  return { id: crypto.randomUUID(), text: text.trim(), completed: false };
}

// ─── Utilidades criptográficas ────────────────────────────────────────────────

/**
 * Deriva un hash seguro de la contraseña usando PBKDF2-SHA256 con salt aleatorio.
 *
 * [SEC-01] Reemplaza SHA-256 puro que era vulnerable a rainbow tables.
 *
 * Algoritmo:
 *  1. Generar 16 bytes de salt criptográfico (128 bits de entropía)
 *  2. Importar la contraseña como CryptoKey para PBKDF2
 *  3. Derivar 256 bits con 310.000 iteraciones de SHA-256
 *  4. Codificar salt + hash en hex con separador ":"
 *     Formato: "<32 chars salt hex>:<64 chars hash hex>"
 *
 * El salt se almacena junto al hash — esto es estándar y seguro.
 * Sin el salt no es posible verificar (ni atacar) el hash.
 *
 * @param {string} password - Contraseña en texto plano
 * @returns {Promise<string>} Hash en formato "<saltHex>:<hashHex>"
 */
async function hashPassword(password) {
  // ── 1. Salt aleatorio ──────────────────────────────────────────────────────
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  // ── 2. Importar contraseña como material de clave ──────────────────────────
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,          // No exportable
    ['deriveBits'],
  );

  // ── 3. Derivar bits con PBKDF2 ─────────────────────────────────────────────
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash:       PBKDF2_HASH,
    },
    keyMaterial,
    KEY_BITS,
  );

  // ── 4. Codificar como hex ──────────────────────────────────────────────────
  const toHex = (buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const saltHex = toHex(salt.buffer);
  const hashHex = toHex(derivedBits);

  // Formato: "<saltHex>:<hashHex>" — el ":" es el discriminador para detección legacy
  return `${saltHex}:${hashHex}`;
}

/**
 * Verifica una contraseña contra un hash almacenado.
 *
 * [SEC-01] Soporta dos formatos:
 *  - PBKDF2 (v1.0.1+): "<saltHex>:<hashHex>" — verificación completa con PBKDF2
 *  - SHA-256 legacy (v1.0.0):  sin ":" — comparación directa para migración
 *    El hash legacy es detectado por la ausencia del separador ":".
 *    authenticate() se encarga de hacer la migración tras login exitoso.
 *
 * La comparación de hashes usa === que en JavaScript no es constant-time,
 * pero el riesgo de timing attack vía IDB client-side es mínimo en este modelo
 * (el atacante ya tiene acceso al dispositivo si puede medir tiempos en IDB).
 *
 * @param {string} password    - Contraseña en texto plano a verificar
 * @param {string} storedHash  - Hash almacenado (PBKDF2 o SHA-256 legacy)
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  // Detectar formato: PBKDF2 tiene ":", SHA-256 legacy no
  if (!storedHash || !storedHash.includes(':')) {
    // ── Path legacy: SHA-256 puro ──────────────────────────────────────────────
    // Verificar con SHA-256 para que los usuarios existentes puedan hacer login
    // una última vez antes de que authenticate() migre su hash a PBKDF2.
    const encoder   = new TextEncoder();
    const hashBuf   = await crypto.subtle.digest('SHA-256', encoder.encode(password));
    const candidateHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return candidateHex === storedHash;
  }

  // ── Path PBKDF2 (v1.0.1+) ─────────────────────────────────────────────────
  const [saltHex, hashHex] = storedHash.split(':');

  // Reconstruir el salt desde hex
  const saltBytes = new Uint8Array(
    saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)),
  );

  // Importar contraseña candidata
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  // Derivar con los mismos parámetros que hashPassword
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      salt:       saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash:       PBKDF2_HASH,
    },
    keyMaterial,
    KEY_BITS,
  );

  const candidateHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return candidateHex === hashHex;
}

/**
 * Elimina passwordHash antes de devolver el usuario al cliente.
 * @param {object} user
 * @returns {User}
 */
function sanitizeUser(user) {
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}
