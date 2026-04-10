/**
 * @file db.js
 * @description Service layer para IndexedDB — Fase 5: 3NF + Delta Sync + Outbox Pattern.
 * @version 1.5.0
 *
 * ── Cambios v1.5.0 ────────────────────────────────────────────────────────────
 *
 *  [ARCH-01] Normalización del modelo de datos IDB (espejo de la DDL Supabase):
 *    Antes (v1.x):  workspaces { id, sheets: Sheet[]  }  ← JSON blob monolítico
 *    Ahora (v1.5):  workspaces { id, name, … }
 *                   sheets     { id, workspace_id, … }
 *                   tasks      { id, sheet_id, … }
 *                   expenses   { id, sheet_id, … }
 *    Cada entidad tiene su propio Object Store con índices por relación padre.
 *
 *  [ARCH-02] Tombstones (Soft Delete para modo offline):
 *    Cuando el usuario elimina una entidad estando offline, NO se borra de IDB.
 *    Se marca: { _deleted: true, updated_at: ISO }
 *    El Sync Engine emite el DELETE a Supabase al reconectar y luego purga el IDB.
 *
 *  [ARCH-03] Outbox durable en IDB (store 'outbox'):
 *    Cada mutación genera una entrada: { id, type, payload, created_at, retries }
 *    El outbox sobrevive recargas — las mutaciones offline no se pierden.
 *    WorkspaceContext drena el outbox en orden topológico al reconectar.
 *
 *  [ARCH-04] DB_VERSION bump a 5 con migración desde v3 (v1.0.x):
 *    v4: stores normalizados (sheets, tasks, expenses, outbox)
 *    v5: migración automática de datos legacy (sheets embebido → stores separados)
 *
 *  ── INTACTO (Restricciones absolutas) ─────────────────────────────────────────
 *  ✓ hashPassword / verifyPassword (PBKDF2 + salt — OWASP 2024)
 *  ✓ UserService (auth, create, linkSupabase, updateProfile)
 *  ✓ SyncMetaService
 *  ✓ compressImage (OffscreenCanvas + fallback HTMLCanvas)
 */

import { openDB } from 'idb';

// ─── Constantes ───────────────────────────────────────────────────────────────

const DB_NAME    = 'taskflow_enterprise';
const DB_VERSION = 5;

// Criptografía — NO MODIFICAR (compatibilidad con hashes existentes en IDB)
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH       = 'SHA-256';
const SALT_BYTES        = 16;
const KEY_BITS          = 256;

// ─── Tipos de mutación del Outbox ─────────────────────────────────────────────

/**
 * Tipos canónicos de mutación.
 * El orden numérico en MUTATION_TOPO_ORDER garantiza que el padre exista en
 * Supabase antes de que el hijo llegue (sin violaciones de FK).
 */
export const MutationType = /** @type {const} */ ({
  UPSERT_WORKSPACE: 'UPSERT_WORKSPACE',  // prioridad 1 — padre raíz
  UPSERT_SHEET:     'UPSERT_SHEET',      // prioridad 2 — hijo de workspace
  UPSERT_TASK:      'UPSERT_TASK',       // prioridad 3 — hijo de sheet
  UPSERT_EXPENSE:   'UPSERT_EXPENSE',    // prioridad 3 — hijo de sheet
  DELETE_EXPENSE:   'DELETE_EXPENSE',    // prioridad 4 — antes de delete sheet
  DELETE_TASK:      'DELETE_TASK',       // prioridad 4
  DELETE_SHEET:     'DELETE_SHEET',      // prioridad 5 — CASCADE elimina hijos
});

/** Orden topológico para el drainQueue. Primero padres, luego hijos, deletes al final. */
export const MUTATION_TOPO_ORDER = [
  MutationType.UPSERT_WORKSPACE,
  MutationType.UPSERT_SHEET,
  MutationType.UPSERT_TASK,
  MutationType.UPSERT_EXPENSE,
  MutationType.DELETE_EXPENSE,
  MutationType.DELETE_TASK,
  MutationType.DELETE_SHEET,
];

// ─── Inicialización y migración de schema ─────────────────────────────────────

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {

    // ── v1: users ─────────────────────────────────────────────────────────────
    if (oldVersion < 1) {
      const userStore = db.createObjectStore('users', { keyPath: 'uid' });
      userStore.createIndex('by_email',    'email',    { unique: true  });
      userStore.createIndex('by_googleId', 'googleId', { unique: false });
    }

    // ── v1→v2: workspaces (metadata, sin sheets embebido a partir de v4) ──────
    if (oldVersion < 1 && !db.objectStoreNames.contains('workspaces')) {
      const wsStore = db.createObjectStore('workspaces', { keyPath: 'id' });
      wsStore.createIndex('by_ownerId', 'ownerId', { unique: false });
    }

    // ── v3: sync_meta ─────────────────────────────────────────────────────────
    if (oldVersion < 3 && !db.objectStoreNames.contains('sync_meta')) {
      db.createObjectStore('sync_meta', { keyPath: 'uid' });
    }

    // ── v4: stores normalizados ───────────────────────────────────────────────
    if (oldVersion < 4) {
      if (!db.objectStoreNames.contains('sheets')) {
        const ss = db.createObjectStore('sheets', { keyPath: 'id' });
        ss.createIndex('by_workspaceId', 'workspace_id', { unique: false });
        ss.createIndex('by_ownerId',     'owner_id',     { unique: false });
      }
      if (!db.objectStoreNames.contains('tasks')) {
        const ts = db.createObjectStore('tasks', { keyPath: 'id' });
        ts.createIndex('by_sheetId', 'sheet_id', { unique: false });
        ts.createIndex('by_ownerId', 'owner_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('expenses')) {
        const es = db.createObjectStore('expenses', { keyPath: 'id' });
        es.createIndex('by_sheetId', 'sheet_id', { unique: false });
        es.createIndex('by_ownerId', 'owner_id', { unique: false });
      }
      // Outbox durable — UUID como keyPath (idempotencia por tipo+entity_id)
      if (!db.objectStoreNames.contains('outbox')) {
        const ob = db.createObjectStore('outbox', { keyPath: 'id' });
        ob.createIndex('by_type',       'type',       { unique: false });
        ob.createIndex('by_created_at', 'created_at', { unique: false });
      }
    }
    // v5: sin cambios de schema — la migración de datos legacy ocurre en
    // WorkspaceService.ensureDefault() (no puede ser async en upgrade())
  },

  blocked()    { console.warn('[DB] Otra pestaña bloquea la actualización. Ciérrala.'); },
  blocking()   { dbPromise.then((d) => d.close()).catch(() => {}); },
  terminated() { console.error('[DB] IndexedDB terminado inesperadamente. Recarga la página.'); },
}).catch((err) => { console.error('[DB] Error al abrir IDB:', err); throw err; });

// ─── Helpers internos ─────────────────────────────────────────────────────────

const generateUid = () => crypto.randomUUID();
const now         = () => new Date().toISOString();

// ─── Service: UserService ─────────────────────────────────────────────────────
// INTACTO — restricción absoluta de la auditoría v1.0.1

export const UserService = {
  async create({ email, displayName, password }) {
    const db = await dbPromise;
    const existing = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());
    if (existing) throw new Error('EMAIL_ALREADY_EXISTS');
    const passwordHash = await hashPassword(password);
    const user = {
      uid:          generateUid(),
      email:        email.toLowerCase().trim(),
      displayName:  displayName.trim(),
      passwordHash,
      googleId:     null,
      photoURL:     null,
      createdAt:    now(),
      updatedAt:    now(),
    };
    await db.add('users', user);
    return sanitizeUser(user);
  },

  async authenticate({ email, password }) {
    const db   = await dbPromise;
    const user = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());
    if (!user) throw new Error('INVALID_CREDENTIALS');
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) throw new Error('INVALID_CREDENTIALS');
    // Migración transparente SHA-256 → PBKDF2
    if (!user.passwordHash.includes(':')) {
      try {
        const newHash = await hashPassword(password);
        await db.put('users', { ...user, passwordHash: newHash, updatedAt: now() });
        console.info('[DB] Hash migrado a PBKDF2:', user.uid);
      } catch (e) { console.warn('[DB] Migración hash fallida:', e.message); }
    }
    return sanitizeUser(user);
  },

  async getById(uid) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    return sanitizeUser(user);
  },

  async findOrCreateGoogle({ googleId, email, displayName, photoURL = null }) {
    const db = await dbPromise;
    const existing = await db.getFromIndex('users', 'by_googleId', googleId);
    if (existing) return sanitizeUser(existing);
    const user = {
      uid:          generateUid(),
      email:        email.toLowerCase().trim(),
      displayName:  displayName.trim(),
      passwordHash: null,
      googleId,
      photoURL,
      createdAt:    now(),
      updatedAt:    now(),
    };
    await db.add('users', user);
    return sanitizeUser(user);
  },

  async linkSupabase(uid, supabaseUid) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
    const updated = { ...user, supabaseUid, updatedAt: now() };
    await db.put('users', updated);
    return sanitizeUser(updated);
  },

  async updateProfile(uid, { displayName, photoURL }) {
    const db   = await dbPromise;
    const user = await db.get('users', uid);
    if (!user) throw new Error('USER_NOT_FOUND');
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

// ─── Service: WorkspaceService ────────────────────────────────────────────────

export const WorkspaceService = {
  /**
   * Obtiene o crea el workspace por defecto.
   * Si detecta datos legacy (sheets embebido), los migra a stores normalizados.
   * @param {string} ownerId - UID local IDB
   * @returns {Promise<WorkspaceView>}
   */
  async ensureDefault(ownerId) {
    const db       = await dbPromise;
    const existing = await db.getAllFromIndex('workspaces', 'by_ownerId', ownerId);

    if (existing.length > 0) {
      const ws = existing[0];
      // Detectar y migrar datos legacy (campo `sheets` embebido)
      if (Array.isArray(ws.sheets) && ws.sheets.length > 0) {
        await _migrateLegacySheets(db, ws, ownerId);
        const cleaned = { ...ws };
        delete cleaned.sheets;
        cleaned.updated_at = now();
        await db.put('workspaces', cleaned);
        console.info('[DB] Migración legacy completada:', ws.id);
      }
      return _buildWorkspaceView(db, ws, ownerId);
    }

    // Primera vez: workspace + sheet inicial en transacción atómica
    const wsId      = generateUid();
    const timestamp = now();
    const defSheet  = {
      id:           generateUid(),
      workspace_id: wsId,
      owner_id:     ownerId,
      name:         'General',
      capital:      0,
      position:     0,
      created_at:   timestamp,
      updated_at:   timestamp,
      _deleted:     false,
    };
    const workspace = {
      id:         wsId,
      name:       'Mi Workspace',
      ownerId,                    // índice legacy
      owner_id:   ownerId,
      createdAt:  timestamp,
      updatedAt:  timestamp,
      updated_at: timestamp,
    };

    const tx = db.transaction(['workspaces', 'sheets'], 'readwrite');
    await tx.objectStore('workspaces').add(workspace);
    await tx.objectStore('sheets').add(defSheet);
    await tx.done;

    return {
      id:        wsId,
      name:      workspace.name,
      ownerId,
      updatedAt: timestamp,
      sheets:    [{ ...defSheet, tasks: [], expenses: [] }],
    };
  },

  /**
   * Carga la vista completa del workspace (sin tombstones).
   * @param {string} workspaceId
   * @param {string} ownerId
   */
  async loadFull(workspaceId, ownerId) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', workspaceId);
    if (!ws || (ws.ownerId !== ownerId && ws.owner_id !== ownerId)) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
    return _buildWorkspaceView(db, ws, ownerId);
  },

  /** Actualiza el nombre del workspace. */
  async updateName(workspaceId, ownerId, name) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', workspaceId);
    if (!ws || (ws.ownerId !== ownerId && ws.owner_id !== ownerId)) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
    const ts = now();
    await db.put('workspaces', { ...ws, name: name.trim(), updatedAt: ts, updated_at: ts });
  },
};

// ─── Service: SheetService ────────────────────────────────────────────────────

export const SheetService = {
  /** @returns {Promise<SheetRecord>} */
  async create({ workspaceId, ownerId, name, position }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:           generateUid(),
      workspace_id: workspaceId,
      owner_id:     ownerId,
      name:         name.trim(),
      capital:      0,
      position:     position ?? 0,
      created_at:   ts,
      updated_at:   ts,
      _deleted:     false,
    };
    await db.add('sheets', rec);
    return rec;
  },

  /** @returns {Promise<SheetRecord>} */
  async update(sheetId, ownerId, { name, capital }) {
    const db  = await dbPromise;
    const rec = await db.get('sheets', sheetId);
    if (!rec || rec.owner_id !== ownerId) throw new Error('SHEET_NOT_FOUND');
    const updated = {
      ...rec,
      ...(name    !== undefined && { name: name.trim() }),
      ...(capital !== undefined && { capital }),
      updated_at: now(),
    };
    await db.put('sheets', updated);
    return updated;
  },

  /**
   * Tombstone: marca sheet + todos sus hijos como _deleted.
   * El Sync Engine emite DELETE_SHEET → Supabase CASCADE elimina hijos.
   * @returns {Promise<SheetRecord>}
   */
  async softDelete(sheetId, ownerId) {
    const db  = await dbPromise;
    const rec = await db.get('sheets', sheetId);
    if (!rec || rec.owner_id !== ownerId) throw new Error('SHEET_NOT_FOUND');

    const ts        = now();
    const tombstone = { ...rec, _deleted: true, updated_at: ts };
    const tx        = db.transaction(['sheets', 'tasks', 'expenses'], 'readwrite');
    await tx.objectStore('sheets').put(tombstone);

    for (const t of await db.getAllFromIndex('tasks', 'by_sheetId', sheetId)) {
      if (!t._deleted) await tx.objectStore('tasks').put({ ...t, _deleted: true, updated_at: ts });
    }
    for (const e of await db.getAllFromIndex('expenses', 'by_sheetId', sheetId)) {
      if (!e._deleted) await tx.objectStore('expenses').put({ ...e, _deleted: true, updated_at: ts });
    }
    await tx.done;
    return tombstone;
  },

  /** Sheets activas de un workspace, ordenadas por position. */
  async getByWorkspace(workspaceId, ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('sheets', 'by_workspaceId', workspaceId);
    return all.filter((s) => s.owner_id === ownerId && !s._deleted)
              .sort((a, b) => a.position - b.position);
  },

  /** Upsert de sheet recibida desde Supabase (reconciliación remota). */
  async upsertFromRemote(sheet, ownerId) {
    const db = await dbPromise;
    await db.put('sheets', {
      id:           sheet.id,
      workspace_id: sheet.workspace_id,
      owner_id:     ownerId,
      name:         sheet.name,
      capital:      sheet.capital ?? 0,
      position:     sheet.position ?? 0,
      created_at:   sheet.created_at ?? now(),
      updated_at:   sheet.updated_at,
      _deleted:     false,
    });
  },
};

// ─── Service: TaskService ─────────────────────────────────────────────────────

export const TaskService = {
  /** @returns {Promise<TaskRecord>} */
  async create({ sheetId, ownerId, text }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:         generateUid(),
      sheet_id:   sheetId,
      owner_id:   ownerId,
      text:       text.trim(),
      completed:  false,
      created_at: ts,
      updated_at: ts,
      _deleted:   false,
    };
    await db.add('tasks', rec);
    return rec;
  },

  /** @returns {Promise<TaskRecord>} */
  async toggle(taskId, ownerId) {
    const db  = await dbPromise;
    const rec = await db.get('tasks', taskId);
    if (!rec || rec.owner_id !== ownerId || rec._deleted) throw new Error('TASK_NOT_FOUND');
    const updated = { ...rec, completed: !rec.completed, updated_at: now() };
    await db.put('tasks', updated);
    return updated;
  },

  /** Tombstone — el Sync Engine emite DELETE_TASK a Supabase al reconectar. */
  async softDelete(taskId, ownerId) {
    const db  = await dbPromise;
    const rec = await db.get('tasks', taskId);
    if (!rec || rec.owner_id !== ownerId) throw new Error('TASK_NOT_FOUND');
    const tombstone = { ...rec, _deleted: true, updated_at: now() };
    await db.put('tasks', tombstone);
    return tombstone;
  },

  /** Tasks activas de una sheet. */
  async getBySheet(sheetId, ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('tasks', 'by_sheetId', sheetId);
    return all.filter((t) => t.owner_id === ownerId && !t._deleted)
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  /** Tombstones pendientes de enviar a Supabase. */
  async getTombstones(ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('tasks', 'by_ownerId', ownerId);
    return all.filter((t) => t._deleted);
  },

  /** Purga física tras confirmación de DELETE remoto. */
  async purgeTombstones(ids) {
    const db = await dbPromise;
    const tx = db.transaction('tasks', 'readwrite');
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  },

  async upsertFromRemote(task, ownerId) {
    const db = await dbPromise;
    await db.put('tasks', {
      id:         task.id,
      sheet_id:   task.sheet_id,
      owner_id:   ownerId,
      text:       task.text,
      completed:  task.completed,
      created_at: task.created_at ?? now(),
      updated_at: task.updated_at,
      _deleted:   false,
    });
  },
};

// ─── Service: ExpenseService ──────────────────────────────────────────────────

export const ExpenseService = {
  /** @returns {Promise<ExpenseRecord>} */
  async create({ sheetId, ownerId, description, amount }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:          generateUid(),
      sheet_id:    sheetId,
      owner_id:    ownerId,
      description: description.trim(),
      amount:      Number(amount),
      created_at:  ts,
      updated_at:  ts,
      _deleted:    false,
    };
    await db.add('expenses', rec);
    return rec;
  },

  async softDelete(expenseId, ownerId) {
    const db  = await dbPromise;
    const rec = await db.get('expenses', expenseId);
    if (!rec || rec.owner_id !== ownerId) throw new Error('EXPENSE_NOT_FOUND');
    const tombstone = { ...rec, _deleted: true, updated_at: now() };
    await db.put('expenses', tombstone);
    return tombstone;
  },

  async getBySheet(sheetId, ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('expenses', 'by_sheetId', sheetId);
    return all.filter((e) => e.owner_id === ownerId && !e._deleted)
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  async getTombstones(ownerId) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('expenses', 'by_ownerId', ownerId);
    return all.filter((e) => e._deleted);
  },

  async purgeTombstones(ids) {
    const db = await dbPromise;
    const tx = db.transaction('expenses', 'readwrite');
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  },

  async upsertFromRemote(expense, ownerId) {
    const db = await dbPromise;
    await db.put('expenses', {
      id:          expense.id,
      sheet_id:    expense.sheet_id,
      owner_id:    ownerId,
      description: expense.description,
      amount:      expense.amount,
      created_at:  expense.created_at ?? now(),
      updated_at:  expense.updated_at,
      _deleted:    false,
    });
  },
};

// ─── Service: OutboxService ───────────────────────────────────────────────────

export const OutboxService = {
  /**
   * Encola una mutación atómica. Idempotente: si existe una entrada con el mismo
   * (type + entity.id), la sobreescribe con el payload más reciente (LWW local).
   * @param {{ type: string, payload: object }} mutation
   */
  async enqueue({ type, payload }) {
    const db       = await dbPromise;
    const entityId = payload.id ?? generateUid();
    await db.put('outbox', {
      id:         `${type}:${entityId}`,  // clave determinista para idempotencia
      type,
      payload,
      created_at: now(),
      retries:    0,
    });
  },

  /**
   * Todas las mutaciones pendientes en orden topológico estricto.
   * @returns {Promise<OutboxEntry[]>}
   */
  async getAll() {
    const db      = await dbPromise;
    const entries = await db.getAll('outbox');
    return entries.sort((a, b) => {
      const ia = MUTATION_TOPO_ORDER.indexOf(a.type);
      const ib = MUTATION_TOPO_ORDER.indexOf(b.type);
      if (ia !== ib) return ia - ib;
      return a.created_at.localeCompare(b.created_at); // FIFO desempate
    });
  },

  /** Elimina una entrada tras sync exitoso. */
  async remove(outboxId) {
    const db = await dbPromise;
    await db.delete('outbox', outboxId);
  },

  /** Incrementa reintentos (el Sync Engine descarta entradas con retries >= MAX). */
  async incrementRetry(outboxId) {
    const db    = await dbPromise;
    const entry = await db.get('outbox', outboxId);
    if (entry) await db.put('outbox', { ...entry, retries: (entry.retries ?? 0) + 1 });
  },

  /** Número de entradas pendientes (para badge en NavBar). */
  async count() {
    const db = await dbPromise;
    return db.count('outbox');
  },

  /** Vacía el outbox (logout / reset). */
  async clear() {
    const db = await dbPromise;
    await db.clear('outbox');
  },
};

// ─── Service: SyncMetaService ─────────────────────────────────────────────────
// INTACTO

export const SyncMetaService = {
  async get(uid) {
    const db = await dbPromise;
    return db.get('sync_meta', uid) ?? null;
  },

  async upsert(uid, updates) {
    const db       = await dbPromise;
    const existing = await db.get('sync_meta', uid) ?? { uid };
    const updated  = { ...existing, ...updates };
    await db.put('sync_meta', updated);
    return updated;
  },
};

// ─── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Crea una SheetView en memoria (para React state).
 * @param {string} [name]
 * @returns {SheetView}
 */
export function makeSheet(name = 'Nueva hoja') {
  return { id: crypto.randomUUID(), name: name.trim(), capital: 0, position: 0, tasks: [], expenses: [] };
}

export function makeExpense({ desc, amount }) {
  return { id: crypto.randomUUID(), description: desc.trim(), amount: Number(amount) };
}

export function makeTask(text) {
  return { id: crypto.randomUUID(), text: text.trim(), completed: false };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Construye la WorkspaceView completa desde los stores normalizados.
 * Filtra tombstones (_deleted: true) — no se muestran en UI.
 */
async function _buildWorkspaceView(db, ws, ownerId) {
  const allSheets = await db.getAllFromIndex('sheets', 'by_workspaceId', ws.id);
  const active    = allSheets.filter((s) => s.owner_id === ownerId && !s._deleted)
                             .sort((a, b) => a.position - b.position);

  const sheets = await Promise.all(active.map(async (sheet) => {
    const [tasks, expenses] = await Promise.all([
      db.getAllFromIndex('tasks',    'by_sheetId', sheet.id),
      db.getAllFromIndex('expenses', 'by_sheetId', sheet.id),
    ]);
    return {
      id:           sheet.id,
      workspace_id: sheet.workspace_id,
      name:         sheet.name,
      capital:      sheet.capital ?? 0,
      position:     sheet.position ?? 0,
      updated_at:   sheet.updated_at,
      tasks:    tasks.filter((t) => t.owner_id === ownerId && !t._deleted)
                     .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      expenses: expenses.filter((e) => e.owner_id === ownerId && !e._deleted)
                        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    };
  }));

  return {
    id:        ws.id,
    name:      ws.name,
    ownerId:   ws.ownerId ?? ws.owner_id,
    updatedAt: ws.updatedAt ?? ws.updated_at,
    sheets,
  };
}

/**
 * Migra datos legacy (sheets embebido en workspace v1.x) a stores normalizados.
 * Llamado por WorkspaceService.ensureDefault() al detectar el campo `sheets[]`.
 */
async function _migrateLegacySheets(db, ws, ownerId) {
  const ts = now();
  const tx = db.transaction(['sheets', 'tasks', 'expenses'], 'readwrite');

  for (let pos = 0; pos < ws.sheets.length; pos++) {
    const s = ws.sheets[pos];

    await tx.objectStore('sheets').put({
      id:           s.id,
      workspace_id: ws.id,
      owner_id:     ownerId,
      name:         s.name,
      capital:      s.capital ?? 0,
      position:     pos,
      created_at:   ts,
      updated_at:   ts,
      _deleted:     false,
    });

    for (const t of (s.tasks ?? [])) {
      await tx.objectStore('tasks').put({
        id:         t.id,
        sheet_id:   s.id,
        owner_id:   ownerId,
        text:       t.text,
        completed:  t.completed ?? false,
        created_at: ts,
        updated_at: ts,
        _deleted:   false,
      });
    }

    for (const e of (s.expenses ?? [])) {
      await tx.objectStore('expenses').put({
        id:          e.id,
        sheet_id:    s.id,
        owner_id:    ownerId,
        description: e.desc ?? e.description ?? '',
        amount:      e.amount ?? 0,
        created_at:  ts,
        updated_at:  ts,
        _deleted:    false,
      });
    }
  }

  await tx.done;
}

// ─── Utilidades criptográficas ────────────────────────────────────────────────
// INTACTO — PBKDF2 + salt (OWASP 2024)

async function hashPassword(password) {
  const salt        = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    keyMaterial, KEY_BITS,
  );
  const toHex = (buf) => Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('') === storedHash;
  }
  const [saltHex, hashHex] = storedHash.split(':');
  const saltBytes   = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    keyMaterial, KEY_BITS,
  );
  const candidateHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return candidateHex === hashHex;
}

function sanitizeUser(user) {
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

// ─── Utilidad: compresión de imagen ──────────────────────────────────────────
// INTACTO — OffscreenCanvas + fallback HTMLCanvas

async function compressImage(base64, maxWidth = 400, maxHeight = 400, quality = 0.7) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    return _compressOffscreen(base64, maxWidth, maxHeight, quality);
  }
  return _compressMainThread(base64, maxWidth, maxHeight, quality);
}

async function _compressOffscreen(base64, maxWidth, maxHeight, quality) {
  try {
    const blob   = await (await fetch(base64)).blob();
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    if (ratio < 1) { width = Math.round(width * ratio); height = Math.round(height * ratio); }
    const canvas = new OffscreenCanvas(width, height);
    const ctx    = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return _compressMainThread(base64, maxWidth, maxHeight, quality); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = (e) => res(/** @type {string} */ (e.target.result));
      r.onerror = () => rej(new Error('IMAGE_READ_ERROR'));
      r.readAsDataURL(jpegBlob);
    });
  } catch (err) {
    console.warn('[DB] OffscreenCanvas falló, usando fallback:', err.message);
    return _compressMainThread(base64, maxWidth, maxHeight, quality);
  }
}

function _compressMainThread(base64, maxWidth, maxHeight, quality) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      if (ratio < 1) { width = Math.round(width * ratio); height = Math.round(height * ratio); }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { res(base64); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      res(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => rej(new Error('IMAGE_LOAD_ERROR'));
    img.src = base64;
  });
}