/**
 * @file db.js
 * @description Service layer para IndexedDB usando la librería `idb`.
 * Define los Object Stores y expone métodos CRUD tipados por entidad.
 * Toda la lógica de persistencia pasa por aquí — nunca directo desde componentes.
 */

import { openDB } from 'idb';

// ─── Constantes ───────────────────────────────────────────────────────────────

const DB_NAME = 'taskflow_enterprise';
// v2: workspaces ahora almacena el array `sheets` embebido en el documento.
// No se necesita un store adicional; las sheets viajan dentro del workspace.
const DB_VERSION = 3;  // v3: adds sync_meta store for cloud sync metadata

// ─── Inicialización ───────────────────────────────────────────────────────────

/**
 * Abre (o crea) la base de datos y define los Object Stores.
 * El resultado se cachea; llamadas posteriores reutilizan la conexión.
 */
const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {
    // ── v1: Store users ───────────────────────────────────────────────────────
    if (oldVersion < 1) {
      const userStore = db.createObjectStore('users', { keyPath: 'uid' });
      userStore.createIndex('by_email', 'email', { unique: true });
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
});

// ─── Helpers internos ─────────────────────────────────────────────────────────

/** Genera un UUID v4 sin dependencias externas */
const generateUid = () => crypto.randomUUID();

/** Timestamp ISO actual */
const now = () => new Date().toISOString();

// ─── Service: UserService ─────────────────────────────────────────────────────

export const UserService = {
  /**
   * Crea un nuevo usuario con contraseña hasheada (SHA-256).
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
      uid: generateUid(),
      email: email.toLowerCase().trim(),
      displayName: displayName.trim(),
      passwordHash,
      googleId: null,
      photoURL: null,        // Base64 string | null
      createdAt: now(),
      updatedAt: now(),
    };

    await db.add('users', user);
    // Nunca devolver el hash al caller
    return sanitizeUser(user);
  },

  /**
   * Valida credenciales y devuelve el usuario (sin passwordHash).
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<User>}
   */
  async authenticate({ email, password }) {
    const db = await dbPromise;
    const user = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());

    if (!user) throw new Error('INVALID_CREDENTIALS');

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) throw new Error('INVALID_CREDENTIALS');

    return sanitizeUser(user);
  },

  /**
   * Obtiene un usuario por UID. Lanza si no existe.
   * @param {string} uid
   * @returns {Promise<User>}
   */
  async getById(uid) {
    const db = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    return sanitizeUser(user);
  },

  /**
   * Busca o crea un usuario via Google OAuth (mock-ready).
   * @param {{ googleId: string, email: string, displayName: string, photoURL?: string }} profile
   * @returns {Promise<User>}
   */
  async findOrCreateGoogle({ googleId, email, displayName, photoURL = null }) {
    const db = await dbPromise;

    const existing = await db.getFromIndex('users', 'by_googleId', googleId);
    if (existing) return sanitizeUser(existing);

    const user = {
      uid: generateUid(),
      email: email.toLowerCase().trim(),
      displayName: displayName.trim(),
      passwordHash: null,
      googleId,
      photoURL,
      createdAt: now(),
      updatedAt: now(),
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
    const db = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated = { ...user, supabaseUid, updatedAt: now() };
    await db.put('users', updated);
    return sanitizeUser(updated);
  },

  /**
   * Actualiza displayName y/o photoURL.
   * Si se recibe un photoURL (Base64 crudo), lo comprime antes de persistir:
   * redimensiona a 400x400 max y codifica como JPEG 0.7 quality.
   * Filtra por uid para aislamiento multitenant.
   *
   * @param {string} uid
   * @param {{ displayName?: string, photoURL?: string }} updates
   * @returns {Promise<User>}
   */
  async updateProfile(uid, { displayName, photoURL }) {
    const db = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');

    // Comprimir imagen si se está actualizando el avatar
    let compressedPhoto = photoURL;
    if (photoURL !== undefined && photoURL !== null) {
      compressedPhoto = await compressImage(photoURL, 400, 400, 0.7);
    }

    const updated = {
      ...user,
      ...(displayName !== undefined && { displayName: displayName.trim() }),
      ...(photoURL !== undefined && { photoURL: compressedPhoto }),
      updatedAt: now(),
    };

    await db.put('users', updated);
    return sanitizeUser(updated);
  },
};

// ─── Utilidad: compresión de imagen en cliente ────────────────────────────────

/**
 * Redimensiona y comprime una imagen Base64 usando HTMLCanvasElement.
 * Opera completamente en el browser — cero dependencias externas.
 *
 * Algoritmo:
 *  1. Decodifica el Base64 en un HTMLImageElement
 *  2. Calcula las dimensiones de destino manteniendo aspect ratio
 *  3. Dibuja en un OffscreenCanvas (o HTMLCanvasElement como fallback)
 *  4. Exporta como JPEG con la calidad indicada
 *
 * @param {string}  base64     - Data URL completa ("data:image/...;base64,...")
 * @param {number}  maxWidth   - Ancho máximo en px (default 400)
 * @param {number}  maxHeight  - Alto máximo en px (default 400)
 * @param {number}  quality    - Calidad JPEG 0-1 (default 0.7)
 * @returns {Promise<string>}  Data URL JPEG comprimida
 */
async function compressImage(base64, maxWidth = 400, maxHeight = 400, quality = 0.7) {
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
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // Si el contexto no está disponible (SSR/tests), devolver original
        resolve(base64);
        return;
      }

      // imageSmoothingQuality = 'high' activa el algoritmo bilinear en Chromium
      ctx.imageSmoothingEnabled  = true;
      ctx.imageSmoothingQuality  = 'high';
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
      id: generateUid(),
      name: name.trim(),
      ownerId,
      sheets: [],          // Fase 2: array de sheets embebido
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
    const db = await dbPromise;
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
      id: generateUid(),
      name: 'Mi Workspace',
      ownerId,
      sheets: [defaultSheet],
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
   * @param {string} id          - workspace id
   * @param {string} ownerId     - uid del usuario autenticado
   * @param {Sheet[]} sheets     - array completo actualizado
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

// ─── Service: SyncMetaService ────────────────────────────────────────────────
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
    const db = await dbPromise;
    const existing = await db.get('sync_meta', uid) ?? { uid };
    const updated = { ...existing, ...updates };
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
    id: crypto.randomUUID(),
    name: name.trim(),
    capital: 0,
    expenses: [],
    tasks: [],
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
 * Hash SHA-256 de la contraseña usando Web Crypto API (nativo, sin dependencias).
 * @param {string} password
 * @returns {Promise<string>} hex digest
 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compara contraseña en texto plano con hash almacenado.
 * @param {string} password
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  const hash = await hashPassword(password);
  return hash === storedHash;
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