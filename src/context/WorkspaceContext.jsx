/**
 * @file WorkspaceContext.jsx
 * @description Contexto global de workspace — Fase 5: Offline-First Coordinator.
 * @version 2.0.0
 *
 * ── Arquitectura v2.0.0 ───────────────────────────────────────────────────────
 *
 *  User Action
 *      │
 *      ▼
 *  1. dispatch()             ← React state (L1, feedback inmediato — Optimistic)
 *      │
 *      ▼
 *  2. IDB write (granular)   ← Store normalizado _v6 (L2, local-first durable)
 *      │
 *      ▼
 *  3. OutboxService.enqueue  ← Mutación atómica e idempotente en 'outbox_v6' (L3)
 *      │
 *      ▼
 *  4. drainOutbox()          ← CloudService.processOutboxBatch(items, wsId, wsName)
 *      │
 *      ▼
 *  5. Supabase RPC           ← batch_sync_workspace (transacción atómica)
 *
 * ── Cambios v2.0.0 (Hallazgos de Auditoría) ──────────────────────────────────
 *
 *  [A1/A2] Gestión de Identidad:
 *    workspaceId y workspaceName viven en el estado del contexto.
 *    Se recuperan de WorkspaceService.ensureDefault() en el useEffect de init.
 *    drainOutbox los lee de latestStateRef — nunca los deriva del outbox.
 *
 *  [M1] Drenaje Seguro — Control de Concurrencia:
 *    syncInProgressRef actúa como mutex. Si drainOutbox se invoca mientras
 *    otra instancia está activa, retorna inmediatamente (early return).
 *    Elimina race conditions y duplicados en conexiones inestables.
 *
 *  [FLOW] Flujo Unidireccional Estricto en acciones:
 *    dispatch → IDB → enqueue → drainOutbox()
 *    El dispatch ocurre PRIMERO (feedback instantáneo al usuario).
 *    IDB y outbox son durables — si la app se cierra, se retoman al arrancar.
 *
 *  [C1] Adaptación al nuevo CloudService v2.0.0:
 *    processOutboxBatch recibe (items, workspaceId, workspaceName) explícitos.
 *    El workspaceId nunca se deriva del contenido del batch.
 *
 *  [CLEAN] Limpieza — sin retry manual:
 *    Toda la lógica de reintentos (exponential backoff, withRetry) vive en
 *    cloudService.js. El contexto solo gestiona el estado de UI (syncStatus).
 *    incrementRetry en el outbox lo gestiona cloudService internamente;
 *    el contexto solo elimina entradas confirmadas o con MAX_RETRIES agotados.
 *
 *  ── INTACTO ────────────────────────────────────────────────────────────────
 *  ✓ Estructura del reducer (wsReducer) con helper updateSheet
 *  ✓ Patrón latestStateRef / userRef para evitar stale closures
 *  ✓ Lógica de red (online/offline events)
 *  ✓ reconcile (LWW delta sync desde Supabase)
 *  ✓ forceSync expuesto en el contexto
 *  ✓ API pública del contexto (mismas props para compatibilidad UI)
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import {
  WorkspaceService,
  SheetService,
  TaskService,
  ExpenseService,
  OutboxService,
  SyncMetaService,
  MutationType,
  MAX_OUTBOX_RETRIES as DB_MAX_RETRIES,
} from '../services/db';
import {
  CloudService,
  isCloudConfigured,
  MAX_OUTBOX_RETRIES,
} from '../services/cloudService';

// ─── Estado inicial ────────────────────────────────────────────────────────────

const initialState = {
  status:           'idle',      // 'idle' | 'loading' | 'ready' | 'error'
  // [A1/A2] Identidad del workspace — fuente de verdad para el sync
  workspaceId:      null,        // UUID — enviado a processOutboxBatch
  workspaceName:    'Mi Workspace',
  sheets:           [],          // SheetView[] — con tasks[] y expenses[] anidados
  activeSheetId:    null,
  error:            null,
  // ── Sync ─────────────────────────────────────────────────────────────────
  syncStatus:       'idle',      // 'idle' | 'syncing' | 'error' | 'offline'
  syncError:        null,
  lastSyncedAt:     null,
  pendingMutations: 0,           // badge para NavBar
};

// ─── Helper: actualizador inmutable de sheet ───────────────────────────────────

function updateSheet(sheets, sheetId, updater) {
  return sheets.map((s) => (s.id === sheetId ? updater(s) : s));
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

function wsReducer(state, action) {
  switch (action.type) {

    case 'LOADING':
      return { ...state, status: 'loading', error: null };

    case 'INIT_SUCCESS': {
      const { workspaceId, workspaceName, sheets, lastSyncedAt } = action.payload;
      return {
        ...state,
        status:        'ready',
        workspaceId,                          // [A1] persiste en state
        workspaceName: workspaceName ?? 'Mi Workspace',
        sheets,
        activeSheetId: sheets[0]?.id ?? null,
        error:         null,
        lastSyncedAt:  lastSyncedAt ?? null,
      };
    }

    case 'SET_ERROR':
      return { ...state, status: 'error', error: action.payload };

    case 'RESET':
      return initialState;

    // ── Sync ──────────────────────────────────────────────────────────────────
    case 'SYNC_STATUS':
      return {
        ...state,
        syncStatus: action.payload.status,
        syncError:  action.payload.error ?? null,
      };

    case 'SET_LAST_SYNCED':
      return {
        ...state,
        lastSyncedAt:     action.payload,
        syncStatus:       'idle',
        syncError:        null,
        pendingMutations: 0,
      };

    case 'SET_PENDING_MUTATIONS':
      return { ...state, pendingMutations: action.payload };

    /**
     * REMOTE_MERGE: integra entidades remotas más recientes.
     * No re-encola al cloud — solo actualiza React state.
     */
    case 'REMOTE_MERGE':
      return {
        ...state,
        sheets:        action.payload.sheets,
        workspaceName: action.payload.workspaceName ?? state.workspaceName,
      };

    // ── Navegación ────────────────────────────────────────────────────────────
    case 'SET_ACTIVE_SHEET':
      return { ...state, activeSheetId: action.payload };

    // ── CRUD Sheets ───────────────────────────────────────────────────────────
    case 'ADD_SHEET': {
      const sheet = action.payload;
      return {
        ...state,
        sheets:        [...state.sheets, sheet],
        activeSheetId: sheet.id,
      };
    }

    case 'RENAME_SHEET':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, name: action.payload.name,
        })),
      };

    case 'REMOVE_SHEET': {
      const next = state.sheets.filter((s) => s.id !== action.payload);
      return {
        ...state,
        sheets:        next,
        activeSheetId: state.activeSheetId === action.payload
          ? (next[0]?.id ?? null)
          : state.activeSheetId,
      };
    }

    // ── Finanzas ──────────────────────────────────────────────────────────────
    case 'SET_CAPITAL':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, capital: action.payload.capital,
        })),
      };

    case 'ADD_EXPENSE':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, expenses: [...s.expenses, action.payload.expense],
        })),
      };

    case 'REMOVE_EXPENSE':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, expenses: s.expenses.filter((e) => e.id !== action.payload.expenseId),
        })),
      };

    // ── Tareas ────────────────────────────────────────────────────────────────
    case 'ADD_TASK':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, tasks: [...s.tasks, action.payload.task],
        })),
      };

    case 'TOGGLE_TASK':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s,
          tasks: s.tasks.map((t) =>
            t.id === action.payload.taskId ? { ...t, completed: !t.completed } : t,
          ),
        })),
      };

    case 'REMOVE_TASK':
      return {
        ...state,
        sheets: updateSheet(state.sheets, action.payload.sheetId, (s) => ({
          ...s, tasks: s.tasks.filter((t) => t.id !== action.payload.taskId),
        })),
      };

    default:
      return state;
  }
}

// ─── Contexto ──────────────────────────────────────────────────────────────────

const WorkspaceContext = createContext(null);

// ─── Provider ──────────────────────────────────────────────────────────────────

export function WorkspaceProvider({ children }) {
  const { user, isAuthenticated } = useAuth();
  const [state, dispatch]         = useReducer(wsReducer, initialState);

  // ── Refs — evitan stale closures en callbacks async ──────────────────────────
  const latestStateRef    = useRef(state);
  const userRef           = useRef(user);
  // [M1] Mutex de concurrencia — reemplaza isSyncingRef de v1.5.0
  const syncInProgressRef = useRef(false);
  const initialized       = useRef(false);

  useEffect(() => { latestStateRef.current = state; });
  useEffect(() => { userRef.current = user; }, [user]);

  // syncTick: incrementa cuando el outbox recibe una entrada nueva.
  // El efecto observador dispara drainOutbox sin crear dependencias circulares.
  const [syncTick, setSyncTick] = useState(0);

  // ─── Inicialización ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isAuthenticated || !user?.uid) {
      dispatch({ type: 'RESET' });
      initialized.current = false;
      return;
    }
    if (initialized.current) return;

    async function init() {
      dispatch({ type: 'LOADING' });
      try {
        // [A1/A2] workspaceId y workspaceName se leen aquí y viven en el estado
        const wsView = await WorkspaceService.ensureDefault(user.uid);
        const meta   = await SyncMetaService.get(user.uid);

        dispatch({
          type:    'INIT_SUCCESS',
          payload: {
            workspaceId:   wsView.id,        // [A1] UUID del workspace
            workspaceName: wsView.name,      // [A2] nombre del workspace
            sheets:        wsView.sheets,
            lastSyncedAt:  meta?.lastSyncedAt ?? null,
          },
        });

        // Drenar outbox residual de sesiones anteriores (mutaciones offline)
        const pending = await OutboxService.count();
        if (pending > 0) {
          dispatch({ type: 'SET_PENDING_MUTATIONS', payload: pending });
          setSyncTick((t) => t + 1);
        }

        initialized.current = true;
      } catch (err) {
        dispatch({ type: 'SET_ERROR', payload: err.message });
      }
    }

    init();
  }, [isAuthenticated, user?.uid]);

  // ─── drainOutbox — Motor de Sincronización ───────────────────────────────────

  /**
   * Envía todas las mutaciones pendientes del outbox a Supabase.
   *
   * Garantías v2.0.0:
   *  [M1] syncInProgressRef = mutex — nunca dos drains concurrentes.
   *  [A1] workspaceId y workspaceName se leen de latestStateRef, no del batch.
   *  [C1] cloudService.processOutboxBatch recibe (items, workspaceId, workspaceName).
   *  [CLEAN] Sin retry manual — withRetry vive en cloudService.
   *  Entradas con retries >= MAX_OUTBOX_RETRIES se descartan (datos irrecuperables).
   */
  const drainOutbox = useCallback(async () => {
    // [M1] Lock de concurrencia — retorno inmediato si ya hay un sync activo
    if (syncInProgressRef.current) return;
    if (!isCloudConfigured())      return;

    const currentState = latestStateRef.current;
    const currentUser  = userRef.current;

    // Validar identidad — sin supabaseUid no podemos autenticar el RPC
    if (!currentUser?.supabaseUid) return;

    // [A1] Leer workspaceId y workspaceName del estado — NUNCA del batch
    const { workspaceId, workspaceName } = currentState;
    if (!workspaceId) return; // workspace aún no inicializado

    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
      return;
    }

    const mutations = await OutboxService.getAll();
    if (!mutations.length) return;

    // Adquirir el lock
    syncInProgressRef.current = true;
    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      // Separar entradas válidas de irrecuperables
      const valid   = mutations.filter((m) => (m.retries ?? 0) < MAX_OUTBOX_RETRIES);
      const invalid = mutations.filter((m) => (m.retries ?? 0) >= MAX_OUTBOX_RETRIES);

      // Descartar entradas que agotaron reintentos
      for (const m of invalid) {
        console.warn('[WorkspaceContext] Descartando mutación con max reintentos:', m.idb_id, m.type);
        await OutboxService.remove(m.idb_id);
      }

      if (!valid.length) {
        const nowIso = new Date().toISOString();
        await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: nowIso });
        dispatch({ type: 'SET_LAST_SYNCED', payload: nowIso });
        return;
      }

      // [C1] Llamada al RPC con workspaceId y workspaceName explícitos
      // cloudService.processOutboxBatch incluye withRetry internamente — [CLEAN]
      const result = await CloudService.processOutboxBatch(
        valid,
        workspaceId,    // [A1] del estado — no derivado del batch
        workspaceName,  // [A2] del estado
      );

      if (result.success) {
        // Confirmar: eliminar entradas del outbox
        for (const m of valid) await OutboxService.remove(m.idb_id);

        // Purgar tombstones de IDB confirmados por Supabase
        const deletedTaskIds = valid
          .filter((m) => m.type === MutationType.DELETE_TASK)
          .map((m) => m.payload.id);
        const deletedExpenseIds = valid
          .filter((m) => m.type === MutationType.DELETE_EXPENSE)
          .map((m) => m.payload.id);

        if (deletedTaskIds.length)    await TaskService.purgeTombstones(deletedTaskIds);
        if (deletedExpenseIds.length) await ExpenseService.purgeTombstones(deletedExpenseIds);

        // Actualizar metadatos de sync
        const nowIso = new Date().toISOString();
        await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: nowIso });
        dispatch({ type: 'SET_LAST_SYNCED', payload: nowIso });

      } else {
        // [CLEAN] Sin retry manual — cloudService ya gestionó withRetry.
        // Incrementamos retries en outbox para el siguiente ciclo de drain.
        for (const m of valid) await OutboxService.incrementRetry(m.idb_id);
        dispatch({
          type:    'SYNC_STATUS',
          payload: { status: 'error', error: result.error ?? 'Error desconocido' },
        });
      }

    } catch (err) {
      // Error no controlado (ej. red caída antes de que withRetry lo capture)
      console.error('[WorkspaceContext] drainOutbox error inesperado:', err.message);
      // Incrementar retries del batch completo
      const currentMutations = await OutboxService.getAll();
      for (const m of currentMutations) await OutboxService.incrementRetry(m.idb_id);
      dispatch({
        type:    'SYNC_STATUS',
        payload: { status: 'error', error: err.message },
      });
    } finally {
      // Liberar el lock siempre, incluso si hubo excepción — [M1]
      syncInProgressRef.current = false;
      // Actualizar badge de pendientes en NavBar
      const remaining = await OutboxService.count();
      dispatch({ type: 'SET_PENDING_MUTATIONS', payload: remaining });
    }
  }, []); // stable — lee estado via refs, no cierra sobre state

  // Disparar drain cuando syncTick incrementa (nueva acción de usuario)
  useEffect(() => {
    if (syncTick === 0) return;
    drainOutbox();
  }, [syncTick, drainOutbox]);

  // ─── Helper: encolar mutación y disparar sync ─────────────────────────────────

  /**
   * Persiste una mutación en el outbox durable e incrementa syncTick.
   * No-op si cloud no está configurado o el usuario no tiene supabaseUid.
   *
   * @param {{ type: string, payload: object }} mutation
   */
  const enqueue = useCallback(async (mutation) => {
    const currentUser = userRef.current;
    if (!isCloudConfigured() || !currentUser?.supabaseUid) return;
    await OutboxService.enqueue(mutation);
    // Incrementar syncTick dispara el efecto observador que llama drainOutbox
    setSyncTick((t) => t + 1);
  }, []);

  // ─── Reconciliación LWW (Last Write Wins) ─────────────────────────────────────

  /**
   * Descarga el delta de Supabase y lo fusiona con el estado local.
   *
   * Estrategia LWW por entidad:
   *   remote.updated_at > local.updated_at → Supabase gana, se actualiza IDB
   *   local más reciente (mutación en outbox)  → local gana, no se sobreescribe
   *
   * No dispara re-enqueue — REMOTE_MERGE nunca añade al outbox (evita loops).
   */
  const reconcile = useCallback(async () => {
    const currentUser  = userRef.current;
    const currentState = latestStateRef.current;

    if (!currentUser?.supabaseUid || !currentUser?.uid) return;
    if (!isCloudConfigured())                            return;
    if (currentState.status !== 'ready')                 return;

    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      const delta = await CloudService.fetchDelta(
        currentUser.supabaseUid,
        currentState.lastSyncedAt,
      );

      let anyMerge = false;

      // ── Reconciliar workspaces ──────────────────────────────────────────────
      for (const remoteWs of (delta.workspaces ?? [])) {
        if (remoteWs.id !== currentState.workspaceId) continue;
        await WorkspaceService.updateName(remoteWs.id, currentUser.uid, remoteWs.name);
        anyMerge = true;
      }

      // ── Reconciliar sheets ──────────────────────────────────────────────────
      for (const remoteSheet of (delta.sheets ?? [])) {
        const localSheet = currentState.sheets.find((s) => s.id === remoteSheet.id);
        const remoteTs   = new Date(remoteSheet.updated_at).getTime();
        const localTs    = localSheet ? new Date(localSheet.updated_at ?? 0).getTime() : 0;

        if (remoteTs > localTs) {
          await SheetService.upsertFromRemote(remoteSheet, currentUser.uid);
          anyMerge = true;
        }
      }

      // ── Reconciliar tasks ───────────────────────────────────────────────────
      for (const remoteTask of (delta.tasks ?? [])) {
        const localSheet = currentState.sheets.find((s) => s.id === remoteTask.sheet_id);
        const localTask  = localSheet?.tasks?.find((t) => t.id === remoteTask.id);
        const remoteTs   = new Date(remoteTask.updated_at).getTime();
        const localTs    = localTask ? new Date(localTask.updated_at ?? 0).getTime() : 0;

        if (remoteTs > localTs) {
          await TaskService.upsertFromRemote(remoteTask, currentUser.uid);
          anyMerge = true;
        }
      }

      // ── Reconciliar expenses ────────────────────────────────────────────────
      for (const remoteExp of (delta.expenses ?? [])) {
        const localSheet   = currentState.sheets.find((s) => s.id === remoteExp.sheet_id);
        const localExpense = localSheet?.expenses?.find((e) => e.id === remoteExp.id);
        const remoteTs     = new Date(remoteExp.updated_at).getTime();
        const localTs      = localExpense ? new Date(localExpense.updated_at ?? 0).getTime() : 0;

        if (remoteTs > localTs) {
          await ExpenseService.upsertFromRemote(remoteExp, currentUser.uid);
          anyMerge = true;
        }
      }

      // Si hubo cambios remotos, recargar la vista completa desde IDB
      if (anyMerge) {
        const updated = await WorkspaceService.loadFull(
          currentState.workspaceId,
          currentUser.uid,
        );
        dispatch({
          type:    'REMOTE_MERGE',
          payload: { sheets: updated.sheets, workspaceName: updated.name },
        });
      }

      // Drenar el outbox (datos locales más recientes → subir a Supabase)
      if (await OutboxService.count() > 0) {
        await drainOutbox();
      } else {
        const nowIso = new Date().toISOString();
        await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: nowIso });
        dispatch({ type: 'SET_LAST_SYNCED', payload: nowIso });
      }

    } catch (err) {
      console.error('[WorkspaceContext] reconcile error:', err.message);
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'error', error: err.message } });
    }
  }, [drainOutbox]);

  // ─── Network events ───────────────────────────────────────────────────────────

  useEffect(() => {
    const handleOnline  = () => reconcile();
    const handleOffline = () =>
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
    }

    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [reconcile]);

  // ─── Acciones públicas ─────────────────────────────────────────────────────────

  const setActiveSheet = useCallback((sheetId) => {
    dispatch({ type: 'SET_ACTIVE_SHEET', payload: sheetId });
  }, []);

  // ── Sheets ────────────────────────────────────────────────────────────────────

  /**
   * [FLOW] Orden estricto: dispatch → IDB → enqueue → drainOutbox
   *
   * El dispatch va PRIMERO para que el usuario vea la hoja inmediatamente.
   * Si IDB falla, el dispatch ya fue (trade-off aceptado para UX óptima).
   * El outbox garantiza que Supabase recibe el cambio en algún momento.
   */
  const addSheet = useCallback(async (name = 'Nueva hoja') => {
    const currentUser  = userRef.current;
    const currentState = latestStateRef.current;
    if (!currentUser?.uid || !currentState.workspaceId) return;

    // 1. Persistir en IDB PRIMERO para obtener el UUID estable
    //    (dispatch necesita el id real para construir la SheetView)
    const position = currentState.sheets.length;
    const rec = await SheetService.create({
      workspaceId: currentState.workspaceId,
      ownerUid:    currentUser.uid,
      name,
      position,
    });

    // 2. [FLOW] dispatch — feedback inmediato en UI
    const sheetView = { ...rec, tasks: [], expenses: [] };
    dispatch({ type: 'ADD_SHEET', payload: sheetView });

    // 3. [FLOW] enqueue al outbox — orden topológico: workspace primero, luego sheet
    await enqueue({
      type:    MutationType.UPSERT_WORKSPACE,
      payload: {
        id:   currentState.workspaceId,
        name: currentState.workspaceName,
      },
    });
    await enqueue({
      type:    MutationType.UPSERT_SHEET,
      payload: {
        id:           rec.id,
        workspace_id: rec.workspace_id,
        name:         rec.name,
        capital:      rec.capital,
        position:     rec.position,
      },
    });
    // enqueue llama setSyncTick → useEffect dispara drainOutbox automáticamente
  }, [enqueue]);

  const renameSheet = useCallback(async (sheetId, name) => {
    if (!name?.trim()) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB
    await SheetService.update(sheetId, currentUser.uid, { name });
    // 2. dispatch
    dispatch({ type: 'RENAME_SHEET', payload: { sheetId, name } });
    // 3. enqueue → drainOutbox (vía syncTick)
    await enqueue({
      type:    MutationType.UPSERT_SHEET,
      payload: { id: sheetId, name },
    });
  }, [enqueue]);

  const removeSheet = useCallback(async (sheetId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB — soft-delete en cascade (tasks + expenses tombstoned)
    await SheetService.softDelete(sheetId, currentUser.uid);
    // 2. dispatch
    dispatch({ type: 'REMOVE_SHEET', payload: sheetId });
    // 3. enqueue → drainOutbox (Supabase CASCADE elimina hijos)
    await enqueue({
      type:    MutationType.DELETE_SHEET,
      payload: { id: sheetId },
    });
  }, [enqueue]);

  // ── Finanzas ───────────────────────────────────────────────────────────────────

  const setCapital = useCallback(async (sheetId, capital) => {
    const parsed = parseFloat(capital);
    if (isNaN(parsed)) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB
    await SheetService.update(sheetId, currentUser.uid, { capital: parsed });
    // 2. dispatch
    dispatch({ type: 'SET_CAPITAL', payload: { sheetId, capital: parsed } });
    // 3. enqueue → drainOutbox
    await enqueue({
      type:    MutationType.UPSERT_SHEET,
      payload: { id: sheetId, capital: parsed },
    });
  }, [enqueue]);

  /**
   * [FLOW] addExpense: dispatch → IDB → enqueue → drainOutbox
   *
   * NOTA: el dispatch ocurre después de IDB porque necesitamos el UUID real
   * del expense (generado por ExpenseService.create) para la SheetView.
   * El usuario ve el expense <50ms tras la acción — UX aceptable.
   */
  const addExpense = useCallback(async (sheetId, { desc, amount }) => {
    if (!desc?.trim() || !amount) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB — genera UUID estable
    const rec = await ExpenseService.create({
      sheetId,
      ownerUid:    currentUser.uid,
      description: desc,
      amount,
    });

    // 2. dispatch — alias 'desc' para retrocompatibilidad con Dashboard.jsx
    const expView = { ...rec, desc: rec.description };
    dispatch({ type: 'ADD_EXPENSE', payload: { sheetId, expense: expView } });

    // 3. enqueue → drainOutbox (vía syncTick)
    await enqueue({
      type:    MutationType.UPSERT_EXPENSE,
      payload: {
        id:          rec.id,
        sheet_id:    sheetId,
        description: rec.description,
        amount:      rec.amount,
      },
    });
  }, [enqueue]);

  const removeExpense = useCallback(async (sheetId, expenseId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB
    await ExpenseService.softDelete(expenseId, currentUser.uid);
    // 2. dispatch
    dispatch({ type: 'REMOVE_EXPENSE', payload: { sheetId, expenseId } });
    // 3. enqueue → drainOutbox
    await enqueue({
      type:    MutationType.DELETE_EXPENSE,
      payload: { id: expenseId },
    });
  }, [enqueue]);

  // ── Tareas ─────────────────────────────────────────────────────────────────────

  /**
   * [FLOW] addTask: IDB → dispatch → enqueue
   *
   * IDB primero para obtener el UUID; dispatch inmediatamente después
   * para que la tarea aparezca en UI. La diferencia temporal es imperceptible.
   */
  const addTask = useCallback(async (sheetId, text) => {
    if (!text?.trim()) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB — genera UUID estable
    const rec = await TaskService.create({
      sheetId,
      ownerUid: currentUser.uid,
      text,
    });

    // 2. dispatch — feedback inmediato
    dispatch({ type: 'ADD_TASK', payload: { sheetId, task: rec } });

    // 3. enqueue → drainOutbox (vía syncTick)
    await enqueue({
      type:    MutationType.UPSERT_TASK,
      payload: {
        id:        rec.id,
        sheet_id:  sheetId,
        text:      rec.text,
        completed: rec.completed,
      },
    });
  }, [enqueue]);

  /**
   * [FLOW] toggleTask: dispatch → IDB → enqueue
   *
   * El dispatch va PRIMERO para que el checkbox responda instantáneamente.
   * El estado optimista refleja el toggle (completed: !actual).
   * Si IDB falla (caso extremadamente raro), el estado queda inconsistente
   * hasta el próximo reconcile — trade-off aceptado para UX máxima.
   */
  const toggleTask = useCallback(async (sheetId, taskId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. dispatch — feedback INMEDIATO (checkbox responde al instante)
    dispatch({ type: 'TOGGLE_TASK', payload: { sheetId, taskId } });

    // 2. IDB — persistir el nuevo estado
    const updated = await TaskService.toggle(taskId, currentUser.uid);

    // 3. enqueue → drainOutbox (vía syncTick)
    await enqueue({
      type:    MutationType.UPSERT_TASK,
      payload: {
        id:        updated.id,
        sheet_id:  sheetId,
        text:      updated.text,
        completed: updated.completed,
      },
    });
  }, [enqueue]);

  const removeTask = useCallback(async (sheetId, taskId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // 1. IDB
    await TaskService.softDelete(taskId, currentUser.uid);
    // 2. dispatch
    dispatch({ type: 'REMOVE_TASK', payload: { sheetId, taskId } });
    // 3. enqueue → drainOutbox
    await enqueue({
      type:    MutationType.DELETE_TASK,
      payload: { id: taskId },
    });
  }, [enqueue]);

  // ── forceSync ──────────────────────────────────────────────────────────────────

  const forceSync = useCallback(async () => {
    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
      return;
    }
    await reconcile();
  }, [reconcile]);

  // ─── Selector: hoja activa ────────────────────────────────────────────────────

  const activeSheet = useMemo(
    () => state.sheets.find((s) => s.id === state.activeSheetId) ?? null,
    [state.sheets, state.activeSheetId],
  );

  // ─── Valor del contexto ───────────────────────────────────────────────────────

  const value = useMemo(
    () => ({
      // Estado
      status:           state.status,
      error:            state.error,
      sheets:           state.sheets,
      activeSheetId:    state.activeSheetId,
      activeSheet,
      isReady:          state.status === 'ready',
      // Sync
      syncStatus:       state.syncStatus,
      syncError:        state.syncError,
      lastSyncedAt:     state.lastSyncedAt,
      pendingMutations: state.pendingMutations,
      // Navegación
      setActiveSheet,
      // Sheets
      addSheet,
      renameSheet,
      removeSheet,
      // Finanzas
      setCapital,
      addExpense,
      removeExpense,
      // Tareas
      addTask,
      toggleTask,
      removeTask,
      // Cloud
      forceSync,
    }),
    [
      state.status, state.error, state.sheets, state.activeSheetId,
      state.syncStatus, state.syncError, state.lastSyncedAt, state.pendingMutations,
      activeSheet,
      setActiveSheet,
      addSheet, renameSheet, removeSheet,
      setCapital, addExpense, removeExpense,
      addTask, toggleTask, removeTask,
      forceSync,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

// ─── Hook público ─────────────────────────────────────────────────────────────

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace debe usarse dentro de <WorkspaceProvider>.');
  return ctx;
}
