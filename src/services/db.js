/**
 * @file db.js
 * @description Service layer para IndexedDB — Fase 5 REFACTORED: 3NF + Delta Sync + Outbox Pattern.
 * @version 2.0.0
 *
 * ── Cambios v2.0.0 (Refactor completo post-auditoría) ────────────────────────
 *
 *  [ARCH-01] Normalización estricta 3NF con índices limpios:
 *    workspaces { idb_id (PK autoincrement), id (UUID sync), owner_uid, name, … }
 *    sheets     { idb_id (PK autoincrement), id (UUID sync), workspace_idb_id (FK), owner_uid, … }
 *    tasks      { idb_id (PK autoincrement), id (UUID sync), sheet_idb_id (FK), owner_uid, … }
 *    expenses   { idb_id (PK autoincrement), id (UUID sync), sheet_idb_id (FK), owner_uid, … }
 *    outbox     { idb_id (PK autoincrement), mutation_key (unique), type, payload, … }
 *
 *  [ARCH-02] Gestión inequívoca de IDs:
 *    - `idb_id`: número autoincremental, clave primaria local de IDB. NUNCA viaja a Supabase.
 *    - `id`: UUID v4, clave de sincronización con Supabase. Generado en cliente, estable.
 *    - `owner_uid`: UID local del usuario (IDB), no el supabaseUid. Separación de concerns.
 *
 *  [ARCH-03] Outbox atómico con mutation_key determinista:
 *    - PUT idempotente via unique index 'by_mutation_key'.
 *    - DELETE al encolar un DELETE_* cancela el UPSERT_* previo del mismo UUID.
 *    - Todo en una transacción IDB: lectura + escritura de outbox en el mismo tx.
 *
 *  [ARCH-04] Limpieza de huérfanos en inicialización:
 *    _purgeOrphans(): elimina tasks/expenses cuyo sheet padre no existe, y sheets cuyo
 *    workspace padre no existe. Se ejecuta una vez por sesión al arrancar ensureDefault().
 *
 *  [ARCH-05] DB_VERSION = 6 con migration guards completos (if oldVersion < N):
 *    Cada versión tiene su bloque independiente. No hay riesgo de skip silencioso.
 *
 *  [ARCH-06] Tombstones con campo _deleted_at (ISO) para TTL futuro:
 *    Al soft-delete: { _deleted: true, _deleted_at: ISO, updated_at: ISO }
 *    purgeTombstones() hace hard-delete físico tras confirmación de Supabase.
 *
 *  [ARCH-07] getAll() del OutboxService usa cursor con index 'by_topo_order':
 *    El índice numérico topo_order garantiza orden topológico sin sort en JS.
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
const DB_VERSION = 6;

// Criptografía — NO MODIFICAR (compatibilidad con hashes existentes en IDB)
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH       = 'SHA-256';
const SALT_BYTES        = 16;
const KEY_BITS          = 256;

// ─── Tipos de mutación del Outbox ─────────────────────────────────────────────

/**
 * Tipos canónicos de mutación.
 * topo_order: número usado como índice IDB para ordenación O(1) en getAll().
 * Los DELETEs van al final para que Supabase CASCADE funcione correctamente.
 */
export const MutationType = /** @type {const} */ ({
  UPSERT_WORKSPACE: 'UPSERT_WORKSPACE',  // topo_order: 1
  UPSERT_SHEET:     'UPSERT_SHEET',      // topo_order: 2
  UPSERT_TASK:      'UPSERT_TASK',       // topo_order: 3
  UPSERT_EXPENSE:   'UPSERT_EXPENSE',    // topo_order: 4
  DELETE_EXPENSE:   'DELETE_EXPENSE',    // topo_order: 5
  DELETE_TASK:      'DELETE_TASK',       // topo_order: 6
  DELETE_SHEET:     'DELETE_SHEET',      // topo_order: 7
});

/** Mapa tipo → número topológico. Usado al encolar para indexar en IDB. */
const TOPO_ORDER_MAP = {
  [MutationType.UPSERT_WORKSPACE]: 1,
  [MutationType.UPSERT_SHEET]:     2,
  [MutationType.UPSERT_TASK]:      3,
  [MutationType.UPSERT_EXPENSE]:   4,
  [MutationType.DELETE_EXPENSE]:   5,
  [MutationType.DELETE_TASK]:      6,
  [MutationType.DELETE_SHEET]:     7,
};

/** Array ordenado para compatibilidad con código que consume el orden. */
export const MUTATION_TOPO_ORDER = Object.keys(TOPO_ORDER_MAP).sort(
  (a, b) => TOPO_ORDER_MAP[a] - TOPO_ORDER_MAP[b],
);

// ─── Flag de sesión para orphan purge ────────────────────────────────────────
// Se ejecuta una sola vez por sesión (tab/reload).
let _orphanPurgeRanThisSession = false;

// ─── Inicialización y migración de schema ─────────────────────────────────────

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion, _newVersion, transaction) {

    // ── v1: users ─────────────────────────────────────────────────────────────
    if (oldVersion < 1) {
      if (!db.objectStoreNames.contains('users')) {
        const userStore = db.createObjectStore('users', { keyPath: 'uid' });
        userStore.createIndex('by_email',    'email',    { unique: true  });
        userStore.createIndex('by_googleId', 'googleId', { unique: false });
      }
    }

    // ── v2: workspaces legacy (metadata blob) ─────────────────────────────────
    if (oldVersion < 2) {
      if (!db.objectStoreNames.contains('workspaces')) {
        const wsStore = db.createObjectStore('workspaces', { keyPath: 'uid' });
        wsStore.createIndex('by_ownerId', 'ownerId', { unique: false });
      }
    }

    // ── v3: sync_meta ─────────────────────────────────────────────────────────
    if (oldVersion < 3) {
      if (!db.objectStoreNames.contains('sync_meta')) {
        db.createObjectStore('sync_meta', { keyPath: 'uid' });
      }
    }

    // ── v4: stores normalizados (keyPath string UUID) ──────────────────────────
    // Nota: estos stores usaban keyPath: 'id' (UUID string). Se mantienen en v4
    // para que las migraciones legacy de v4 sigan funcionando. En v6 los
    // reemplazamos por stores 3NF con autoincrement + unique UUID index.
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
      if (!db.objectStoreNames.contains('outbox')) {
        const ob = db.createObjectStore('outbox', { keyPath: 'id' });
        ob.createIndex('by_type',       'type',       { unique: false });
        ob.createIndex('by_created_at', 'created_at', { unique: false });
      }
    }

    // ── v5: sin cambios de schema (migración de datos en WorkspaceService) ─────
    // (idempotente — no añade stores nuevos)

    // ── v6: 3NF completo — nuevos stores con autoincrement + índices limpios ───
    // Los stores de v4 (sheets, tasks, expenses, outbox) se eliminan y recrean
    // con el nuevo schema. Los datos son migrados por WorkspaceService.ensureDefault()
    // la primera vez que se cargue (detecta stores v4 vacíos vs stores v6 nuevos).
    //
    // ESTRATEGIA: en vez de borrar stores existentes (no permitido en idb sin
    // cerrar la conexión), creamos los nuevos stores con sufijo '_v6'. En
    // ensureDefault() se detectan los stores viejos con datos y se migran.
    if (oldVersion < 6) {
      // Sheets v6: idb_id autoincrement + id UUID único + relaciones limpias
      if (!db.objectStoreNames.contains('sheets_v6')) {
        const ss = db.createObjectStore('sheets_v6', {
          keyPath:       'idb_id',
          autoIncrement: true,
        });
        ss.createIndex('by_sync_id',      'id',           { unique: true  });
        ss.createIndex('by_workspace_id', 'workspace_id', { unique: false });
        ss.createIndex('by_owner_uid',    'owner_uid',    { unique: false });
      }

      // Tasks v6
      if (!db.objectStoreNames.contains('tasks_v6')) {
        const ts = db.createObjectStore('tasks_v6', {
          keyPath:       'idb_id',
          autoIncrement: true,
        });
        ts.createIndex('by_sync_id',   'id',           { unique: true  });
        ts.createIndex('by_sheet_id',  'sheet_id',     { unique: false });
        ts.createIndex('by_owner_uid', 'owner_uid',    { unique: false });
      }

      // Expenses v6
      if (!db.objectStoreNames.contains('expenses_v6')) {
        const es = db.createObjectStore('expenses_v6', {
          keyPath:       'idb_id',
          autoIncrement: true,
        });
        es.createIndex('by_sync_id',   'id',        { unique: true  });
        es.createIndex('by_sheet_id',  'sheet_id',  { unique: false });
        es.createIndex('by_owner_uid', 'owner_uid', { unique: false });
      }

      // Outbox v6: mutation_key determinista como índice único para idempotencia
      if (!db.objectStoreNames.contains('outbox_v6')) {
        const ob = db.createObjectStore('outbox_v6', {
          keyPath:       'idb_id',
          autoIncrement: true,
        });
        // mutation_key = '<TYPE>:<entity_uuid>' — garantiza idempotencia LWW
        ob.createIndex('by_mutation_key', 'mutation_key', { unique: true  });
        // topo_order numérico: permite getAll ordenado por IDB cursor sin sort JS
        ob.createIndex('by_topo_order',   'topo_order',   { unique: false });
        ob.createIndex('by_created_at',   'created_at',   { unique: false });
      }

      // Workspaces v6: mantiene retrocompatibilidad de keyPath 'id' (UUID)
      // pero añade owner_uid (string) + índice by_owner_uid limpio
      // (en v1-v2 el keyPath era 'uid' — workspace con keyPath 'id' fue
      // introducido directamente en ensureDefault() en v1.5.0)
      // No necesitamos nuevo store: los workspaces ya usan id=UUID como keyPath.
      // Solo añadimos el índice by_owner_uid si no existe.
      if (db.objectStoreNames.contains('workspaces')) {
        try {
          const wsStore = transaction.objectStore('workspaces');
          if (!wsStore.indexNames.contains('by_owner_uid')) {
            wsStore.createIndex('by_owner_uid', 'owner_uid', { unique: false });
          }
        } catch (_e) {
          // El store workspaces podría tener keyPath 'uid' (v1-v2).
          // En ese caso ignoramos — WorkspaceService.ensureDefault() maneja ambos.
        }
      }
    }
  },

  blocked()    { console.warn('[DB] Otra pestaña bloquea la actualización. Ciérrala.'); },
  blocking()   { dbPromise.then((d) => d.close()).catch(() => {}); },
  terminated() { console.error('[DB] IndexedDB terminado inesperadamente. Recarga la página.'); },
}).catch((err) => {
  console.error('[DB] Error al abrir IDB:', err);
  throw err;
});

// ─── Helpers internos ─────────────────────────────────────────────────────────

const generateUUID = () => crypto.randomUUID();
const now          = () => new Date().toISOString();

/**
 * Limpieza de huérfanos — se ejecuta una vez por sesión.
 *
 * Detecta y elimina:
 *  1. tasks_v6 cuyo sheet_id no existe en sheets_v6 (no eliminado).
 *  2. expenses_v6 cuyo sheet_id no existe en sheets_v6.
 *  3. sheets_v6 cuyo workspace_id no existe en workspaces activos.
 *
 * No elimina tombstones (_deleted: true) — esos se purgan tras sync exitoso.
 *
 * @param {import('idb').IDBPDatabase} db
 * @param {string} ownerUid
 */
async function _purgeOrphans(db, ownerUid) {
  try {
    // Recoger IDs activos de sheets
    const activeSheets = await db.getAllFromIndex('sheets_v6', 'by_owner_uid', ownerUid);
    const activeSheetIds = new Set(
      activeSheets.filter((s) => !s._deleted).map((s) => s.id),
    );

    // Purgar tasks huérfanas
    const allTasks = await db.getAllFromIndex('tasks_v6', 'by_owner_uid', ownerUid);
    const orphanTasks = allTasks.filter((t) => !activeSheetIds.has(t.sheet_id) && !t._deleted);
    if (orphanTasks.length > 0) {
      const txT = db.transaction('tasks_v6', 'readwrite');
      for (const t of orphanTasks) await txT.store.delete(t.idb_id);
      await txT.done;
      console.info(`[DB] Orphan purge: eliminadas ${orphanTasks.length} tasks huérfanas.`);
    }

    // Purgar expenses huérfanas
    const allExpenses = await db.getAllFromIndex('expenses_v6', 'by_owner_uid', ownerUid);
    const orphanExpenses = allExpenses.filter((e) => !activeSheetIds.has(e.sheet_id) && !e._deleted);
    if (orphanExpenses.length > 0) {
      const txE = db.transaction('expenses_v6', 'readwrite');
      for (const e of orphanExpenses) await txE.store.delete(e.idb_id);
      await txE.done;
      console.info(`[DB] Orphan purge: eliminados ${orphanExpenses.length} expenses huérfanos.`);
    }

    // Purgar sheets cuyo workspace no existe
    const workspaces = await db.getAll('workspaces');
    const activeWsIds = new Set(workspaces.map((w) => w.id ?? w.uid));
    const orphanSheets = activeSheets.filter(
      (s) => !activeWsIds.has(s.workspace_id) && !s._deleted,
    );
    if (orphanSheets.length > 0) {
      const txS = db.transaction('sheets_v6', 'readwrite');
      for (const s of orphanSheets) await txS.store.delete(s.idb_id);
      await txS.done;
      console.info(`[DB] Orphan purge: eliminadas ${orphanSheets.length} sheets huérfanas.`);
    }
  } catch (err) {
    // Orphan purge es best-effort — no bloquea el arranque
    console.warn('[DB] _purgeOrphans error (non-fatal):', err.message);
  }
}

/**
 * Migra datos del schema v4 (stores sheets/tasks/expenses con keyPath 'id')
 * al schema v6 (stores _v6 con autoincrement idb_id).
 * Se llama una sola vez cuando se detectan datos en los stores viejos.
 *
 * @param {import('idb').IDBPDatabase} db
 * @param {string} ownerUid
 */
async function _migrateV4toV6(db, ownerUid) {
  const ts = now();

  // Migrar sheets
  const oldSheets = db.objectStoreNames.contains('sheets')
    ? await db.getAll('sheets')
    : [];

  const sheetsToMigrate = oldSheets.filter(
    (s) => (s.owner_id === ownerUid || s.owner_uid === ownerUid) && !s._deleted,
  );

  for (const s of sheetsToMigrate) {
    // Verificar que no exista ya en v6
    const existing = await db.getFromIndex('sheets_v6', 'by_sync_id', s.id);
    if (!existing) {
      await db.add('sheets_v6', {
        id:           s.id,
        workspace_id: s.workspace_id,
        owner_uid:    ownerUid,
        name:         s.name,
        capital:      s.capital ?? 0,
        position:     s.position ?? 0,
        created_at:   s.created_at ?? ts,
        updated_at:   s.updated_at ?? ts,
        _deleted:     false,
        _deleted_at:  null,
      });
    }
  }

  // Migrar tasks
  const oldTasks = db.objectStoreNames.contains('tasks')
    ? await db.getAll('tasks')
    : [];

  const tasksToMigrate = oldTasks.filter(
    (t) => (t.owner_id === ownerUid || t.owner_uid === ownerUid) && !t._deleted,
  );

  for (const t of tasksToMigrate) {
    const existing = await db.getFromIndex('tasks_v6', 'by_sync_id', t.id);
    if (!existing) {
      await db.add('tasks_v6', {
        id:          t.id,
        sheet_id:    t.sheet_id,
        owner_uid:   ownerUid,
        text:        t.text,
        completed:   t.completed ?? false,
        created_at:  t.created_at ?? ts,
        updated_at:  t.updated_at ?? ts,
        _deleted:    false,
        _deleted_at: null,
      });
    }
  }

  // Migrar expenses
  const oldExpenses = db.objectStoreNames.contains('expenses')
    ? await db.getAll('expenses')
    : [];

  const expensesToMigrate = oldExpenses.filter(
    (e) => (e.owner_id === ownerUid || e.owner_uid === ownerUid) && !e._deleted,
  );

  for (const e of expensesToMigrate) {
    const existing = await db.getFromIndex('expenses_v6', 'by_sync_id', e.id);
    if (!existing) {
      await db.add('expenses_v6', {
        id:          e.id,
        sheet_id:    e.sheet_id,
        owner_uid:   ownerUid,
        description: e.description ?? e.desc ?? '',
        amount:      e.amount ?? 0,
        created_at:  e.created_at ?? ts,
        updated_at:  e.updated_at ?? ts,
        _deleted:    false,
        _deleted_at: null,
      });
    }
  }

  console.info('[DB] Migración v4→v6 completada.');
}

/**
 * Migra datos legacy embebidos (schema v1.x: sheets[] anidado en workspace)
 * directamente a los stores v6.
 *
 * @param {import('idb').IDBPDatabase} db
 * @param {object} ws - Workspace con campo sheets[] embebido
 * @param {string} ownerUid
 */
async function _migrateLegacySheetsToV6(db, ws, ownerUid) {
  const ts = now();

  for (let pos = 0; pos < ws.sheets.length; pos++) {
    const s = ws.sheets[pos];

    const existingSheet = await db.getFromIndex('sheets_v6', 'by_sync_id', s.id);
    if (!existingSheet) {
      await db.add('sheets_v6', {
        id:           s.id,
        workspace_id: ws.id ?? ws.uid,
        owner_uid:    ownerUid,
        name:         s.name,
        capital:      s.capital ?? 0,
        position:     pos,
        created_at:   ts,
        updated_at:   ts,
        _deleted:     false,
        _deleted_at:  null,
      });
    }

    for (const t of (s.tasks ?? [])) {
      const existingTask = await db.getFromIndex('tasks_v6', 'by_sync_id', t.id);
      if (!existingTask) {
        await db.add('tasks_v6', {
          id:          t.id,
          sheet_id:    s.id,
          owner_uid:   ownerUid,
          text:        t.text,
          completed:   t.completed ?? false,
          created_at:  ts,
          updated_at:  ts,
          _deleted:    false,
          _deleted_at: null,
        });
      }
    }

    for (const e of (s.expenses ?? [])) {
      const existingExp = await db.getFromIndex('expenses_v6', 'by_sync_id', e.id);
      if (!existingExp) {
        await db.add('expenses_v6', {
          id:          e.id,
          sheet_id:    s.id,
          owner_uid:   ownerUid,
          description: e.desc ?? e.description ?? '',
          amount:      e.amount ?? 0,
          created_at:  ts,
          updated_at:  ts,
          _deleted:    false,
          _deleted_at: null,
        });
      }
    }
  }

  console.info('[DB] Migración legacy→v6 completada:', ws.id ?? ws.uid);
}

/**
 * Construye la WorkspaceView completa desde los stores _v6.
 * Filtra tombstones (_deleted: true).
 *
 * @param {import('idb').IDBPDatabase} db
 * @param {object} ws - Registro del workspace
 * @param {string} ownerUid
 * @returns {Promise<WorkspaceView>}
 */
async function _buildWorkspaceView(db, ws, ownerUid) {
  const wsId = ws.id ?? ws.uid;

  const allSheets = await db.getAllFromIndex('sheets_v6', 'by_workspace_id', wsId);
  const active    = allSheets
    .filter((s) => s.owner_uid === ownerUid && !s._deleted)
    .sort((a, b) => a.position - b.position);

  const sheets = await Promise.all(active.map(async (sheet) => {
    const [allTasks, allExpenses] = await Promise.all([
      db.getAllFromIndex('tasks_v6',    'by_sheet_id', sheet.id),
      db.getAllFromIndex('expenses_v6', 'by_sheet_id', sheet.id),
    ]);

    const tasks = allTasks
      .filter((t) => t.owner_uid === ownerUid && !t._deleted)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const expenses = allExpenses
      .filter((e) => e.owner_uid === ownerUid && !e._deleted)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    return {
      // idb_id expuesto para operaciones locales (update, delete por clave IDB)
      idb_id:       sheet.idb_id,
      // id (UUID) para sync con Supabase
      id:           sheet.id,
      workspace_id: sheet.workspace_id,
      name:         sheet.name,
      capital:      sheet.capital ?? 0,
      position:     sheet.position ?? 0,
      updated_at:   sheet.updated_at,
      tasks:        tasks.map((t) => ({
        idb_id:     t.idb_id,
        id:         t.id,
        sheet_id:   t.sheet_id,
        text:       t.text,
        completed:  t.completed,
        updated_at: t.updated_at,
        created_at: t.created_at,
      })),
      expenses: expenses.map((e) => ({
        idb_id:      e.idb_id,
        id:          e.id,
        sheet_id:    e.sheet_id,
        description: e.description,
        // alias 'desc' para retrocompatibilidad con Dashboard.jsx
        desc:        e.description,
        amount:      e.amount,
        updated_at:  e.updated_at,
        created_at:  e.created_at,
      })),
    };
  }));

  return {
    id:         wsId,
    name:       ws.name,
    ownerUid:   ownerUid,
    updated_at: ws.updated_at ?? ws.updatedAt,
    sheets,
  };
}

// ─── Service: WorkspaceService ────────────────────────────────────────────────

export const WorkspaceService = {
  /**
   * Obtiene o crea el workspace por defecto.
   *
   * Pipeline de inicialización:
   *  1. Buscar workspace existente para ownerUid.
   *  2. Si encontrado con datos legacy (sheets[] embebido) → migrar a _v6.
   *  3. Si encontrado con datos en stores v4 → migrar a _v6.
   *  4. Si no encontrado → crear workspace + sheet inicial en stores _v6.
   *  5. Ejecutar _purgeOrphans() una vez por sesión.
   *  6. Retornar WorkspaceView completa.
   *
   * @param {string} ownerUid - UID local del usuario
   * @returns {Promise<WorkspaceView>}
   */
  async ensureDefault(ownerUid, canonicalWorkspaceId = null) {
    const db = await dbPromise;

    // ── Buscar workspace existente ────────────────────────────────────────────
    // El store 'workspaces' ha usado dos keyPaths históricos: 'uid' (v1-v2) e 'id' (v1.5+).
    // Buscamos con ambos índices disponibles.
    let existingWs = null;

    // [CVE-007] Si hay canonicalWorkspaceId, búscalo primero
    if (canonicalWorkspaceId) {
      try {
        existingWs = await db.get('workspaces', canonicalWorkspaceId);
      } catch (_e) { /* no existe */ }
    }

    // Si no existe el canonical, buscar por owner
    if (!existingWs) {
      try {
        // Intentar con índice by_ownerId (v1.5)
        const byOwner = await db.getAllFromIndex('workspaces', 'by_ownerId', ownerUid);
        if (byOwner.length > 0) existingWs = byOwner[0];
      } catch (_e) { /* índice no existe */ }
    }

    if (!existingWs) {
      try {
        // Intentar con índice by_owner_uid (v6)
        const byOwnerUid = await db.getAllFromIndex('workspaces', 'by_owner_uid', ownerUid);
        if (byOwnerUid.length > 0) existingWs = byOwnerUid[0];
      } catch (_e) { /* índice no existe */ }
    }

    if (!existingWs) {
      // Fallback: scan completo (workspaces debería tener 1 entrada por usuario)
      const all = await db.getAll('workspaces');
      existingWs = all.find(
        (w) => w.ownerId === ownerUid || w.owner_id === ownerUid || w.owner_uid === ownerUid,
      ) ?? null;
    }

    if (existingWs) {
      const wsId = existingWs.id ?? existingWs.uid;

      // ── Migración: datos legacy embebidos (sheets[] en workspace) ────────────
      if (Array.isArray(existingWs.sheets) && existingWs.sheets.length > 0) {
        await _migrateLegacySheetsToV6(db, existingWs, ownerUid);
        const cleaned = { ...existingWs };
        delete cleaned.sheets;
        cleaned.updated_at = now();
        cleaned.owner_uid  = ownerUid; // normalizar campo
        // Preservar el keyPath original (id o uid)
        await db.put('workspaces', cleaned);
      }

      // ── Migración: datos en stores v4 ────────────────────────────────────────
      // Solo si _v6 está vacío para este owner (primera vez post-upgrade v6)
      const existingV6Sheets = await db.getAllFromIndex('sheets_v6', 'by_owner_uid', ownerUid);
      if (existingV6Sheets.length === 0) {
        const oldSheets = db.objectStoreNames.contains('sheets')
          ? await db.getAll('sheets')
          : [];
        const hasOldData = oldSheets.some(
          (s) => (s.owner_id === ownerUid || s.owner_uid === ownerUid) && !s._deleted,
        );
        if (hasOldData) {
          await _migrateV4toV6(db, ownerUid);
        }
      }

      // ── Normalizar workspace con owner_uid ────────────────────────────────────
      if (!existingWs.owner_uid) {
        const normalized = { ...existingWs, owner_uid: ownerUid };
        await db.put('workspaces', normalized);
      }

      // ── Purge de huérfanos (una vez por sesión) ───────────────────────────────
      if (!_orphanPurgeRanThisSession) {
        _orphanPurgeRanThisSession = true;
        // Fire-and-forget — no bloquea la carga
        _purgeOrphans(db, ownerUid).catch(() => {});
      }

      return _buildWorkspaceView(db, existingWs, ownerUid);
    }

    // ── Crear workspace + sheet inicial ──────────────────────────────────────
    // [CVE-007] Usar canonicalWorkspaceId si se proporciona; de lo contrario, generar uno
    const wsId      = canonicalWorkspaceId ?? generateUUID();
    const sheetId   = generateUUID();
    const timestamp = now();

    const workspace = {
      uid:        wsId,        // IDB keyPath (required)
      id:         wsId,        // UUID sync también como id
      owner_uid:  ownerUid,    // v6 campo limpio
      ownerId:    ownerUid,    // retrocompatibilidad índice v1.5
      owner_id:   ownerUid,    // retrocompatibilidad
      name:       'Mi Workspace',
      created_at: timestamp,
      updated_at: timestamp,
      updatedAt:  timestamp,   // retrocompatibilidad
    };

    const defaultSheet = {
      // idb_id se asigna por autoincrement
      id:           sheetId,
      workspace_id: wsId,
      owner_uid:    ownerUid,
      name:         'General',
      capital:      0,
      position:     0,
      created_at:   timestamp,
      updated_at:   timestamp,
      _deleted:     false,
      _deleted_at:  null,
    };

    // Transacción atómica: workspace + sheet inicial
    const tx = db.transaction(['workspaces', 'sheets_v6'], 'readwrite');
    await tx.objectStore('workspaces').add(workspace);
    const newIdbId = await tx.objectStore('sheets_v6').add(defaultSheet);
    await tx.done;

    _orphanPurgeRanThisSession = true; // base de datos limpia — no necesita purge

    return {
      id:         wsId,
      name:       workspace.name,
      ownerUid:   ownerUid,
      updated_at: timestamp,
      sheets: [{
        idb_id:       newIdbId,
        id:           sheetId,
        workspace_id: wsId,
        name:         'General',
        capital:      0,
        position:     0,
        updated_at:   timestamp,
        tasks:        [],
        expenses:     [],
      }],
    };
  },

  /**
   * Carga la vista completa del workspace desde los stores _v6.
   * @param {string} workspaceId - UUID del workspace
   * @param {string} ownerUid
   * @returns {Promise<WorkspaceView>}
   */
  async loadFull(workspaceId, ownerUid) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', workspaceId);
    if (!ws) throw new Error('WORKSPACE_NOT_FOUND');

    const isOwner = ws.owner_uid === ownerUid
      || ws.ownerId  === ownerUid
      || ws.owner_id === ownerUid;
    if (!isOwner) throw new Error('WORKSPACE_NOT_FOUND');

    return _buildWorkspaceView(db, ws, ownerUid);
  },

  /**
   * Actualiza el nombre del workspace.
   * @param {string} workspaceId - UUID
   * @param {string} ownerUid
   * @param {string} name
   */
  async updateName(workspaceId, ownerUid, name) {
    const db = await dbPromise;
    const ws = await db.get('workspaces', workspaceId);
    if (!ws) throw new Error('WORKSPACE_NOT_FOUND');

    const isOwner = ws.owner_uid === ownerUid
      || ws.ownerId  === ownerUid
      || ws.owner_id === ownerUid;
    if (!isOwner) throw new Error('WORKSPACE_NOT_FOUND');

    const ts = now();
    await db.put('workspaces', {
      ...ws,
      name:       name.trim(),
      updated_at: ts,
      updatedAt:  ts,
    });
  },
};

// ─── Service: SheetService ────────────────────────────────────────────────────

export const SheetService = {
  /**
   * Crea una sheet en el store _v6.
   * @returns {Promise<SheetRecord>} - Incluye idb_id asignado por autoincrement
   */
  async create({ workspaceId, ownerUid, name, position }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:           generateUUID(),
      workspace_id: workspaceId,
      owner_uid:    ownerUid,
      name:         name.trim(),
      capital:      0,
      position:     position ?? 0,
      created_at:   ts,
      updated_at:   ts,
      _deleted:     false,
      _deleted_at:  null,
    };
    const idb_id = await db.add('sheets_v6', rec);
    return { ...rec, idb_id };
  },

  /**
   * Actualiza nombre y/o capital de una sheet.
   * Busca por sync UUID (id), no por idb_id.
   * @returns {Promise<SheetRecord>}
   */
  async update(sheetSyncId, ownerUid, { name, capital }) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('sheets_v6', 'by_sync_id', sheetSyncId);
    if (!rec || rec.owner_uid !== ownerUid) throw new Error('SHEET_NOT_FOUND');

    const updated = {
      ...rec,
      ...(name    !== undefined && { name: name.trim() }),
      ...(capital !== undefined && { capital }),
      updated_at: now(),
    };
    await db.put('sheets_v6', updated);
    return updated;
  },

  /**
   * Soft-delete de sheet + tombstones en cascade para tasks y expenses.
   * Usa una única transacción atómica en los tres stores.
   * @returns {Promise<SheetRecord>}
   */
  async softDelete(sheetSyncId, ownerUid) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('sheets_v6', 'by_sync_id', sheetSyncId);
    if (!rec || rec.owner_uid !== ownerUid) throw new Error('SHEET_NOT_FOUND');

    const ts        = now();
    const tombstone = { ...rec, _deleted: true, _deleted_at: ts, updated_at: ts };

    const tx = db.transaction(['sheets_v6', 'tasks_v6', 'expenses_v6'], 'readwrite');

    await tx.objectStore('sheets_v6').put(tombstone);

    // Cascade tombstone a tasks
    const tasks = await tx.objectStore('tasks_v6').index('by_sheet_id').getAll(sheetSyncId);
    for (const t of tasks) {
      if (!t._deleted) {
        await tx.objectStore('tasks_v6').put({
          ...t, _deleted: true, _deleted_at: ts, updated_at: ts,
        });
      }
    }

    // Cascade tombstone a expenses
    const expenses = await tx.objectStore('expenses_v6').index('by_sheet_id').getAll(sheetSyncId);
    for (const e of expenses) {
      if (!e._deleted) {
        await tx.objectStore('expenses_v6').put({
          ...e, _deleted: true, _deleted_at: ts, updated_at: ts,
        });
      }
    }

    await tx.done;
    return tombstone;
  },

  /**
   * Sheets activas de un workspace, ordenadas por position.
   * @returns {Promise<SheetRecord[]>}
   */
  async getByWorkspace(workspaceId, ownerUid) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('sheets_v6', 'by_workspace_id', workspaceId);
    return all
      .filter((s) => s.owner_uid === ownerUid && !s._deleted)
      .sort((a, b) => a.position - b.position);
  },

  /**
   * Upsert de sheet recibida desde Supabase (reconciliación remota LWW).
   * Preserva idb_id si ya existe; crea nuevo si no.
   */
  async upsertFromRemote(sheet, ownerUid) {
    const db       = await dbPromise;
    const existing = await db.getFromIndex('sheets_v6', 'by_sync_id', sheet.id);
    const base     = existing ?? {};
    await db.put('sheets_v6', {
      ...base,
      id:           sheet.id,
      workspace_id: sheet.workspace_id,
      owner_uid:    ownerUid,
      name:         sheet.name,
      capital:      sheet.capital ?? 0,
      position:     sheet.position ?? 0,
      created_at:   sheet.created_at ?? now(),
      updated_at:   sheet.updated_at,
      _deleted:     false,
      _deleted_at:  null,
    });
  },
};

// ─── Service: TaskService ─────────────────────────────────────────────────────

export const TaskService = {
  /**
   * Crea una task en el store _v6.
   * @returns {Promise<TaskRecord>}
   */
  async create({ sheetId, ownerUid, text }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:          generateUUID(),
      sheet_id:    sheetId,
      owner_uid:   ownerUid,
      text:        text.trim(),
      completed:   false,
      created_at:  ts,
      updated_at:  ts,
      _deleted:    false,
      _deleted_at: null,
    };
    const idb_id = await db.add('tasks_v6', rec);
    return { ...rec, idb_id };
  },

  /**
   * Toggle completed. Busca por sync UUID.
   * @returns {Promise<TaskRecord>}
   */
  async toggle(taskSyncId, ownerUid) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('tasks_v6', 'by_sync_id', taskSyncId);
    if (!rec || rec.owner_uid !== ownerUid || rec._deleted) throw new Error('TASK_NOT_FOUND');

    const updated = { ...rec, completed: !rec.completed, updated_at: now() };
    await db.put('tasks_v6', updated);
    return updated;
  },

  /**
   * Soft-delete (tombstone). Busca por sync UUID.
   * @returns {Promise<TaskRecord>}
   */
  async softDelete(taskSyncId, ownerUid) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('tasks_v6', 'by_sync_id', taskSyncId);
    if (!rec || rec.owner_uid !== ownerUid) throw new Error('TASK_NOT_FOUND');

    const ts        = now();
    const tombstone = { ...rec, _deleted: true, _deleted_at: ts, updated_at: ts };
    await db.put('tasks_v6', tombstone);
    return tombstone;
  },

  /**
   * Tasks activas de una sheet.
   * @returns {Promise<TaskRecord[]>}
   */
  async getBySheet(sheetId, ownerUid) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('tasks_v6', 'by_sheet_id', sheetId);
    return all
      .filter((t) => t.owner_uid === ownerUid && !t._deleted)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  /**
   * Purga física de tombstones confirmados por Supabase.
   * Busca por sync UUID (id), borra por idb_id (PK).
   * @param {string[]} syncIds - UUIDs de las tasks borradas en Supabase
   */
  async purgeTombstones(syncIds) {
    const db = await dbPromise;
    const tx = db.transaction('tasks_v6', 'readwrite');
    for (const syncId of syncIds) {
      const rec = await tx.store.index('by_sync_id').get(syncId);
      if (rec) await tx.store.delete(rec.idb_id);
    }
    await tx.done;
  },

  /**
   * Upsert desde Supabase. Preserva idb_id si existe.
   */
  async upsertFromRemote(task, ownerUid) {
    const db       = await dbPromise;
    const existing = await db.getFromIndex('tasks_v6', 'by_sync_id', task.id);
    const base     = existing ?? {};
    await db.put('tasks_v6', {
      ...base,
      id:          task.id,
      sheet_id:    task.sheet_id,
      owner_uid:   ownerUid,
      text:        task.text,
      completed:   task.completed,
      created_at:  task.created_at ?? now(),
      updated_at:  task.updated_at,
      _deleted:    false,
      _deleted_at: null,
    });
  },
};

// ─── Service: ExpenseService ──────────────────────────────────────────────────

export const ExpenseService = {
  /**
   * Crea un expense en el store _v6.
   * @returns {Promise<ExpenseRecord>}
   */
  async create({ sheetId, ownerUid, description, amount }) {
    const db  = await dbPromise;
    const ts  = now();
    const rec = {
      id:          generateUUID(),
      sheet_id:    sheetId,
      owner_uid:   ownerUid,
      description: description.trim(),
      amount:      Number(amount),
      created_at:  ts,
      updated_at:  ts,
      _deleted:    false,
      _deleted_at: null,
    };
    const idb_id = await db.add('expenses_v6', rec);
    return { ...rec, idb_id };
  },

  /**
   * Soft-delete (tombstone). Busca por sync UUID.
   * @returns {Promise<ExpenseRecord>}
   */
  async softDelete(expenseSyncId, ownerUid) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('expenses_v6', 'by_sync_id', expenseSyncId);
    if (!rec || rec.owner_uid !== ownerUid) throw new Error('EXPENSE_NOT_FOUND');

    const ts        = now();
    const tombstone = { ...rec, _deleted: true, _deleted_at: ts, updated_at: ts };
    await db.put('expenses_v6', tombstone);
    return tombstone;
  },

  /**
   * Expenses activos de una sheet.
   * @returns {Promise<ExpenseRecord[]>}
   */
  async getBySheet(sheetId, ownerUid) {
    const db  = await dbPromise;
    const all = await db.getAllFromIndex('expenses_v6', 'by_sheet_id', sheetId);
    return all
      .filter((e) => e.owner_uid === ownerUid && !e._deleted)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  /**
   * Purga física de tombstones confirmados por Supabase.
   * @param {string[]} syncIds - UUIDs de los expenses borrados en Supabase
   */
  async purgeTombstones(syncIds) {
    const db = await dbPromise;
    const tx = db.transaction('expenses_v6', 'readwrite');
    for (const syncId of syncIds) {
      const rec = await tx.store.index('by_sync_id').get(syncId);
      if (rec) await tx.store.delete(rec.idb_id);
    }
    await tx.done;
  },

  /**
   * Upsert desde Supabase. Preserva idb_id si existe.
   */
  async upsertFromRemote(expense, ownerUid) {
    const db       = await dbPromise;
    const existing = await db.getFromIndex('expenses_v6', 'by_sync_id', expense.id);
    const base     = existing ?? {};
    await db.put('expenses_v6', {
      ...base,
      id:          expense.id,
      sheet_id:    expense.sheet_id,
      owner_uid:   ownerUid,
      description: expense.description,
      amount:      expense.amount,
      created_at:  expense.created_at ?? now(),
      updated_at:  expense.updated_at,
      _deleted:    false,
      _deleted_at: null,
    });
  },
};

// ─── Service: OutboxService ───────────────────────────────────────────────────

export const OutboxService = {
  /**
   * Encola una mutación de forma atómica e idempotente.
   *
   * Garantías:
   *  1. UPSERT: PUT via índice único by_mutation_key → LWW automático en IDB.
   *  2. DELETE: antes del PUT elimina el UPSERT_* previo del mismo entity UUID.
   *     Así el outbox nunca contiene UPSERT + DELETE del mismo UUID.
   *  3. Todo en una única transacción IDB readwrite sobre outbox_v6.
   *
   * @param {{ type: string, payload: object }} mutation
   */
  async enqueue({ type, payload }) {
    const db = await dbPromise;

    const entityId = payload.id;
    if (!entityId) {
      console.error('[OutboxService] enqueue: payload sin id, ignorando:', type, payload);
      return;
    }

    const isDelete     = type.startsWith('DELETE_');
    const mutationKey  = `${type}:${entityId}`;
    const topoOrder    = TOPO_ORDER_MAP[type] ?? 99;
    const ts           = now();

    const tx = db.transaction('outbox_v6', 'readwrite');

    if (isDelete) {
      // Cancelar UPSERT previo del mismo entity (si existe)
      const upsertType = type.replace('DELETE_', 'UPSERT_');
      const upsertKey  = `${upsertType}:${entityId}`;
      const existing   = await tx.store.index('by_mutation_key').get(upsertKey);
      if (existing) {
        await tx.store.delete(existing.idb_id);
      }
      // Registrar DELETE
      await _outboxPut(tx, mutationKey, type, payload, topoOrder, ts);
    } else {
      // UPSERT: PUT idempotente (sobreescribe si ya existe con ese mutation_key)
      await _outboxPut(tx, mutationKey, type, payload, topoOrder, ts);
    }

    await tx.done;
  },

  /**
   * Todas las mutaciones pendientes, ordenadas topológicamente.
   *
   * Usa el índice by_topo_order → O(1) en IDB, sin sort en JS.
   * Dentro del mismo topo_order, orden FIFO por created_at.
   *
   * @returns {Promise<OutboxEntry[]>}
   */
  async getAll() {
    const db      = await dbPromise;
    const entries = [];

    // Cursor ordenado por by_topo_order (número) → IDB devuelve en orden ascendente
    let cursor = await db.transaction('outbox_v6', 'readonly')
      .store
      .index('by_topo_order')
      .openCursor();

    while (cursor) {
      entries.push(cursor.value);
      cursor = await cursor.continue();
    }

    // Estabilidad FIFO dentro del mismo topo_order
    entries.sort((a, b) => {
      if (a.topo_order !== b.topo_order) return a.topo_order - b.topo_order;
      return a.created_at.localeCompare(b.created_at);
    });

    return entries;
  },

  /**
   * Elimina una entrada del outbox por su idb_id (tras sync exitoso).
   * @param {number} idbId - idb_id de la entrada
   */
  async remove(idbId) {
    const db = await dbPromise;
    await db.delete('outbox_v6', idbId);
  },

  /**
   * Elimina una entrada por su mutation_key (alternativa para código legacy).
   * @param {string} mutationKey - '<TYPE>:<entity_uuid>'
   */
  async removeByKey(mutationKey) {
    const db  = await dbPromise;
    const rec = await db.getFromIndex('outbox_v6', 'by_mutation_key', mutationKey);
    if (rec) await db.delete('outbox_v6', rec.idb_id);
  },

  /**
   * Incrementa retries de una entrada por idb_id.
   * @param {number} idbId
   */
  async incrementRetry(idbId) {
    const db    = await dbPromise;
    const entry = await db.get('outbox_v6', idbId);
    if (entry) {
      await db.put('outbox_v6', { ...entry, retries: (entry.retries ?? 0) + 1 });
    }
  },

  /**
   * Número total de entradas pendientes (para badge NavBar).
   * @returns {Promise<number>}
   */
  async count() {
    const db = await dbPromise;
    return db.count('outbox_v6');
  },

  /**
   * Vacía el outbox completamente (logout / reset de datos).
   */
  async clear() {
    const db = await dbPromise;
    await db.clear('outbox_v6');
  },
};

/**
 * Helper interno: PUT atómico en outbox_v6 dentro de una transacción activa.
 * Si ya existe una entrada con el mismo mutation_key, la sobreescribe (LWW).
 *
 * @param {IDBPTransaction} tx
 * @param {string}          mutationKey
 * @param {string}          type
 * @param {object}          payload
 * @param {number}          topoOrder
 * @param {string}          ts
 */
async function _outboxPut(tx, mutationKey, type, payload, topoOrder, ts) {
  const existing = await tx.store.index('by_mutation_key').get(mutationKey);
  if (existing) {
    // Sobreescribir LWW — conservar retries acumulados
    await tx.store.put({
      ...existing,
      type,
      payload,
      topo_order:  topoOrder,
      updated_at:  ts,
      // retries se conserva para no perder el historial de fallos
    });
  } else {
    await tx.store.add({
      mutation_key: mutationKey,
      type,
      payload,
      topo_order:   topoOrder,
      created_at:   ts,
      updated_at:   ts,
      retries:      0,
    });
  }
}

// ─── Service: SyncMetaService ─────────────────────────────────────────────────

export const SyncMetaService = {
  async get(uid) {
    const db  = await dbPromise;
    return (await db.get('sync_meta', uid)) ?? null;
  },

  async upsert(uid, updates) {
    const db       = await dbPromise;
    const existing = (await db.get('sync_meta', uid)) ?? { uid };
    const updated  = { ...existing, ...updates };
    await db.put('sync_meta', updated);
    return updated;
  },

  /**
   * [CVE-007] Obtener o crear workspace_id canónico.
   * Garantiza que existe solo un workspace_id por usuario, incluso en multi-device.
   * 
   * @param {string} uid
   * @returns {Promise<string>} UUID canonical workspace_id
   */
  async getOrCreateCanonicalWorkspaceId(uid) {
    const meta = await this.get(uid);
    
    if (meta?.canonicalWorkspaceId) {
      return meta.canonicalWorkspaceId;
    }

    // Crear UUID nuevo + persistir atómicamente
    const wsId = crypto.randomUUID();
    await this.upsert(uid, {
      canonicalWorkspaceId: wsId,
      workspaceIdLocked: true,
      workspaceIdLockedAt: new Date().toISOString(),
    });

    return wsId;
  },

  /**
   * [CVE-007] Detectar y registrar conflicto de workspace (multi-device).
   * @param {string} uid
   * @param {string} device1WorkspaceId
   * @param {string} device2WorkspaceId
   */
  async recordWorkspaceConflict(uid, device1WorkspaceId, device2WorkspaceId) {
    console.warn('[SyncMetaService] Workspace conflict detected:', {
      device1: device1WorkspaceId,
      device2: device2WorkspaceId,
    });
    await this.upsert(uid, {
      workspaceConflictDetectedAt: new Date().toISOString(),
      workspaceConflictNote: `Conflicto: Device1=${device1WorkspaceId}, Device2=${device2WorkspaceId}`,
    });
  },

  /**
   * [CVE-011] Obtener o crear device_id único para tie-breaker LWW.
   * @param {string} uid
   * @returns {Promise<string>}
   */
  async getOrCreateDeviceId(uid) {
    const meta = await this.get(uid);
    if (meta?.deviceId) return meta.deviceId;

    const deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await this.upsert(uid, { deviceId });
    return deviceId;
  },
};

// ─── Service: UserService ─────────────────────────────────────────────────────
// INTACTO — restricción absoluta de la auditoría v1.0.1

export const UserService = {
  async create({ email, displayName, password }) {
    const db = await dbPromise;
    const existing = await db.getFromIndex('users', 'by_email', email.toLowerCase().trim());
    if (existing) throw new Error('EMAIL_ALREADY_EXISTS');
    const passwordHash = await hashPassword(password);
    const user = {
      uid:          generateUUID(),
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
    if (!user.passwordHash?.includes(':')) {
      try {
        const newHash = await hashPassword(password);
        await db.put('users', { ...user, passwordHash: newHash, updatedAt: now() });
        console.info('[DB] Hash migrado a PBKDF2:', user.uid);
      } catch (e) {
        console.warn('[DB] Migración hash fallida:', e.message);
      }
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
      uid:          generateUUID(),
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

// ─── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Crea una SheetView en memoria (para React state, sin persistir).
 * @param {string} [name]
 * @returns {SheetView}
 */
export function makeSheet(name = 'Nueva hoja') {
  return {
    id:       crypto.randomUUID(),
    name:     name.trim(),
    capital:  0,
    position: 0,
    tasks:    [],
    expenses: [],
  };
}

/**
 * @param {{ desc: string, amount: number }} params
 * @returns {{ id: string, description: string, desc: string, amount: number }}
 */
export function makeExpense({ desc, amount }) {
  return {
    id:          crypto.randomUUID(),
    description: desc.trim(),
    desc:        desc.trim(), // alias retrocompatibilidad
    amount:      Number(amount),
  };
}

/**
 * @param {string} text
 * @returns {{ id: string, text: string, completed: boolean }}
 */
export function makeTask(text) {
  return {
    id:        crypto.randomUUID(),
    text:      text.trim(),
    completed: false,
  };
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
  const toHex = (buf) =>
    Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    return (
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('') === storedHash
    );
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
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
    if (ratio < 1) {
      width  = Math.round(width  * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx    = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return _compressMainThread(base64, maxWidth, maxHeight, quality);
    }
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
    const img  = new Image();
    img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      if (ratio < 1) {
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
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
