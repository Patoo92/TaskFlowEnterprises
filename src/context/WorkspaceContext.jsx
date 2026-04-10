/**
 * @file WorkspaceContext.jsx
 * @description Contexto global de hojas de trabajo — Fase 5: Outbox Pattern + Delta Sync.
 * @version 1.5.0
 *
 * ── Arquitectura de persistencia v1.5 ────────────────────────────────────────
 *
 *  User Action
 *      │
 *      ▼
 *  dispatch()            ← React state (L1, inmediato)
 *      │
 *      ▼
 *  IDB write (atomic)    ← Store normalizado correcto (L2, local-first)
 *      │
 *      ▼
 *  OutboxService.enqueue ← Mutación atómica en store 'outbox' (L3, durable)
 *      │
 *      ▼
 *  drainOutbox()         ← CloudService.processOutboxBatch (orden topológico)
 *      │
 *      ▼
 *  Supabase RPC          ← batch_sync_workspace (transacción atómica)
 *
 * ── Cambios v1.5.0 ────────────────────────────────────────────────────────────
 *
 *  [CTX-01] Outbox durable: syncQueueRef reemplazado por OutboxService.
 *    Cada mutación se persiste en IDB antes de intentar el sync cloud.
 *    Si la app se cierra antes del sync, el outbox se drena al siguiente inicio.
 *
 *  [CTX-02] Operaciones IDB granulares:
 *    Ya no se llama a WorkspaceService.saveSheets() (full snapshot).
 *    Cada acción escribe solo en el store específico:
 *      addTask → TaskService.create
 *      toggleTask → TaskService.toggle
 *      removeTask → TaskService.softDelete
 *      addExpense → ExpenseService.create
 *      removeExpense → ExpenseService.softDelete
 *      addSheet → SheetService.create
 *      renameSheet → SheetService.update
 *      setCapital → SheetService.update
 *      removeSheet → SheetService.softDelete
 *
 *  [CTX-03] drainOutbox con orden topológico garantizado:
 *    OutboxService.getAll() devuelve mutaciones ordenadas por MUTATION_TOPO_ORDER.
 *    Esto evita FK violations al insertar hijos antes que padres.
 *
 *  [CTX-04] Reconciliación LWW (Last Write Wins) con datos normalizados:
 *    La reconciliación recibe el delta normalizado de fetch_workspace_delta
 *    y aplica upsert entity-by-entity en IDB, comparando updated_at.
 *    Remote gana solo si remote.updated_at > local.updated_at.
 *
 *  [CTX-05] Carga inicial desde stores normalizados:
 *    WorkspaceService.ensureDefault() carga y migra datos legacy si existen.
 *    El estado React se construye desde WorkspaceView (join en IDB).
 *
 *  ── INTACTO ────────────────────────────────────────────────────────────────
 *  ✓ Estructura del reducer (wsReducer) con helper updateSheet
 *  ✓ Patrón latestStateRef / userRef para evitar stale closures
 *  ✓ Lógica de red (online/offline events)
 *  ✓ forceSync expuesto en contexto
 *  ✓ API pública del contexto (mismas props que v1.0.x para compatibilidad UI)
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
import { useAuth }  from './AuthContext';
import {
  WorkspaceService,
  SheetService,
  TaskService,
  ExpenseService,
  OutboxService,
  SyncMetaService,
  MutationType,
  MUTATION_TOPO_ORDER,
  makeSheet,
  makeTask,
  makeExpense,
} from '../services/db';
import { CloudService, isCloudConfigured, MAX_OUTBOX_RETRIES } from '../services/cloudService';

// ─── Estado inicial ───────────────────────────────────────────────────────────

const initialState = {
  status:             'idle',    // 'idle' | 'loading' | 'ready' | 'error'
  workspaceId:        null,
  workspaceName:      'Mi Workspace',
  sheets:             [],        // SheetView[] — incluye tasks[] y expenses[] anidados
  activeSheetId:      null,
  error:              null,
  // ── Sync ────────────────────────────────────────────────────────────────
  syncStatus:         'idle',    // 'idle' | 'syncing' | 'error' | 'offline'
  syncError:          null,
  lastSyncedAt:       null,
  pendingMutations:   0,         // badge para NavBar
};

// ─── Helper: actualizador inmutable de sheet ──────────────────────────────────

function updateSheet(sheets, sheetId, updater) {
  return sheets.map((s) => (s.id === sheetId ? updater(s) : s));
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

function wsReducer(state, action) {
  switch (action.type) {

    case 'LOADING':
      return { ...state, status: 'loading', error: null };

    case 'INIT_SUCCESS': {
      const { workspaceId, workspaceName, sheets, lastSyncedAt } = action.payload;
      return {
        ...state,
        status:        'ready',
        workspaceId,
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

    // ── Sync ────────────────────────────────────────────────────────────────
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
     * NO re-encola al cloud — solo actualiza React state.
     * El caller ya persistió en IDB antes de dispatchar.
     */
    case 'REMOTE_MERGE':
      return {
        ...state,
        sheets:        action.payload.sheets,
        workspaceName: action.payload.workspaceName ?? state.workspaceName,
      };

    // ── Navegación ──────────────────────────────────────────────────────────
    case 'SET_ACTIVE_SHEET':
      return { ...state, activeSheetId: action.payload };

    // ── CRUD Sheets ─────────────────────────────────────────────────────────
    case 'ADD_SHEET': {
      const sheet = action.payload; // SheetView completo creado por IDB
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

    // ── Finanzas ────────────────────────────────────────────────────────────
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

    // ── Tareas ──────────────────────────────────────────────────────────────
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

// ─── Contexto ─────────────────────────────────────────────────────────────────

const WorkspaceContext = createContext(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function WorkspaceProvider({ children }) {
  const { user, isAuthenticated } = useAuth();
  const [state, dispatch]         = useReducer(wsReducer, initialState);

  // ── Refs (evitan stale closures en callbacks async) ─────────────────────────
  const latestStateRef   = useRef(state);
  const userRef          = useRef(user);
  const isSyncingRef     = useRef(false);    // mutex drain
  const initialized      = useRef(false);

  useEffect(() => { latestStateRef.current = state; });
  useEffect(() => { userRef.current = user; }, [user]);

  // syncTick: entero que incrementa cuando el outbox recibe una nueva entrada.
  // El efecto que lo observa dispara drainOutbox sin incluirlo en deps circulares.
  const [syncTick, setSyncTick] = useState(0);

  // ─── Carga inicial ──────────────────────────────────────────────────────────

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
        // ensureDefault migra datos legacy si existen y devuelve WorkspaceView
        const wsView = await WorkspaceService.ensureDefault(user.uid);
        const meta   = await SyncMetaService.get(user.uid);

        dispatch({
          type:    'INIT_SUCCESS',
          payload: {
            workspaceId:   wsView.id,
            workspaceName: wsView.name,
            sheets:        wsView.sheets,    // SheetView[] ya con tasks/expenses
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

  // ─── Drain del outbox (Sync Engine) ────────────────────────────────────────

  /**
   * Procesa todas las mutaciones pendientes del outbox en orden topológico.
   *
   * Garantías:
   *  1. isSyncingRef = mutex — nunca dos drains concurrentes.
   *  2. Cada entrada se elimina del outbox solo tras confirmación de Supabase.
   *  3. Fallo en batch → el batch completo permanece en outbox para retry.
   *  4. Entradas con retries >= MAX_OUTBOX_RETRIES se descartan (datos inválidos).
   *  5. Orden topológico: UPSERT_WORKSPACE → UPSERT_SHEET → UPSERT_TASK/EXPENSE
   *                       → DELETE_EXPENSE → DELETE_TASK → DELETE_SHEET
   *     Esto garantiza que el padre existe en Supabase antes de insertar el hijo.
   */
  const drainOutbox = useCallback(async () => {
    if (isSyncingRef.current)   return;
    if (!isCloudConfigured())   return;

    const currentUser = userRef.current;
    if (!currentUser?.supabaseUid) return;

    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
      return;
    }

    const mutations = await OutboxService.getAll();
    if (!mutations.length) return;

    isSyncingRef.current = true;
    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      // Filtrar entradas con demasiados reintentos
      const valid    = mutations.filter((m) => (m.retries ?? 0) < MAX_OUTBOX_RETRIES);
      const invalid  = mutations.filter((m) => (m.retries ?? 0) >= MAX_OUTBOX_RETRIES);

      // Descartar entradas irrecuperables (datos corruptos o schema incompatible)
      for (const m of invalid) {
        console.warn('[WorkspaceContext] Descartando mutación con max reintentos:', m.id);
        await OutboxService.remove(m.id);
      }

      if (!valid.length) {
        dispatch({ type: 'SET_LAST_SYNCED', payload: new Date().toISOString() });
        return;
      }

      // Enviar el batch al RPC (transacción atómica en Supabase)
      const result = await CloudService.processOutboxBatch(valid, currentUser.supabaseUid);

      if (result.success) {
        // Confirmar: eliminar entradas del outbox
        for (const m of valid) await OutboxService.remove(m.id);

        // Purgar tombstones de IDB que ya fueron confirmados por Supabase
        const deletedTaskIds    = valid.filter((m) => m.type === MutationType.DELETE_TASK)
                                       .map((m) => m.payload.id);
        const deletedExpenseIds = valid.filter((m) => m.type === MutationType.DELETE_EXPENSE)
                                       .map((m) => m.payload.id);

        if (deletedTaskIds.length)    await TaskService.purgeTombstones(deletedTaskIds);
        if (deletedExpenseIds.length) await ExpenseService.purgeTombstones(deletedExpenseIds);

        // Actualizar metadatos de sync
        const nowIso = new Date().toISOString();
        await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: nowIso });
        dispatch({ type: 'SET_LAST_SYNCED', payload: nowIso });

      } else {
        // Incrementar reintentos para todas las entradas fallidas
        for (const m of valid) await OutboxService.incrementRetry(m.id);
        dispatch({ type: 'SYNC_STATUS', payload: { status: 'error', error: result.error } });
      }

    } catch (err) {
      console.error('[WorkspaceContext] drainOutbox error:', err.message);
      // Incrementar reintentos de todo el batch (el RPC falló, no datos individuales)
      const mutations2 = await OutboxService.getAll();
      for (const m of mutations2) await OutboxService.incrementRetry(m.id);
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'error', error: err.message } });
    } finally {
      isSyncingRef.current = false;
      // Actualizar badge de pendientes
      const remaining = await OutboxService.count();
      dispatch({ type: 'SET_PENDING_MUTATIONS', payload: remaining });
    }
  }, []);

  // Ejecutar drain cuando syncTick cambia (acción de usuario) o al recuperar red
  useEffect(() => {
    if (syncTick === 0) return;
    drainOutbox();
  }, [syncTick, drainOutbox]);

  // ─── Helper: encolar mutación y disparar sync ───────────────────────────────

  /**
   * Persiste una mutación en el outbox durable e incrementa syncTick.
   * NO-OP si cloud no está configurado o el usuario no tiene supabaseUid.
   * @param {{ type: string, payload: object }} mutation
   */
  const enqueue = useCallback(async (mutation) => {
    const currentUser  = userRef.current;
    if (!isCloudConfigured() || !currentUser?.supabaseUid) return;
    await OutboxService.enqueue(mutation);
    setSyncTick((t) => t + 1);
  }, []);

  // ─── Reconciliación LWW (Last Write Wins) ──────────────────────────────────

  /**
   * Descarga el delta de Supabase y lo fusiona con el estado local.
   *
   * Estrategia LWW por entidad:
   *   - Si remote.updated_at > local.updated_at → Supabase gana, se actualiza IDB
   *   - Si local es más reciente (hay mutación en outbox) → local gana, no se sobreescribe
   *
   * No dispara re-enqueue — REMOTE_MERGE nunca añade al outbox (evita loops).
   */
  const reconcile = useCallback(async () => {
    const currentUser  = userRef.current;
    const currentState = latestStateRef.current;

    if (!currentUser?.supabaseUid || !currentUser?.uid) return;
    if (!isCloudConfigured()) return;
    if (currentState.status !== 'ready')  return;

    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      // Fetch delta normalizado desde Supabase
      const delta = await CloudService.fetchDelta(
        currentUser.supabaseUid,
        currentState.lastSyncedAt,
      );

      let anyMerge = false;

      // ── Reconciliar workspaces ────────────────────────────────────────────
      for (const remoteWs of (delta.workspaces ?? [])) {
        if (remoteWs.id !== currentState.workspaceId) continue;
        await WorkspaceService.updateName(remoteWs.id, currentUser.uid, remoteWs.name);
        anyMerge = true;
      }

      // ── Reconciliar sheets ────────────────────────────────────────────────
      for (const remoteSheet of (delta.sheets ?? [])) {
        const localSheet = currentState.sheets.find((s) => s.id === remoteSheet.id);
        const remoteTs   = new Date(remoteSheet.updated_at).getTime();
        const localTs    = localSheet ? new Date(localSheet.updated_at ?? 0).getTime() : 0;

        if (remoteTs > localTs) {
          await SheetService.upsertFromRemote(remoteSheet, currentUser.uid);
          anyMerge = true;
        }
      }

      // ── Reconciliar tasks ─────────────────────────────────────────────────
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

      // ── Reconciliar expenses ──────────────────────────────────────────────
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

      // Drenar el outbox (datos locales más recientes → subir)
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

  // ─── Network events ─────────────────────────────────────────────────────────

  useEffect(() => {
    const handleOnline  = () => reconcile();
    const handleOffline = () => dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });

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

  // ─── Acciones públicas ──────────────────────────────────────────────────────

  const setActiveSheet = useCallback((sheetId) => {
    dispatch({ type: 'SET_ACTIVE_SHEET', payload: sheetId });
  }, []);

  // ── Sheets ──────────────────────────────────────────────────────────────────

  const addSheet = useCallback(async (name = 'Nueva hoja') => {
    const currentUser  = userRef.current;
    const currentState = latestStateRef.current;
    if (!currentUser?.uid || !currentState.workspaceId) return;

    const position = currentState.sheets.length;
    // 1. Escribir en IDB (operación granular)
    const rec = await SheetService.create({
      workspaceId: currentState.workspaceId,
      ownerId:     currentUser.uid,
      name,
      position,
    });

    // 2. Optimistic update en React (inmediato)
    const sheetView = { ...rec, tasks: [], expenses: [] };
    dispatch({ type: 'ADD_SHEET', payload: sheetView });

    // 3. Encolar mutación en outbox (durable)
    await enqueue({
      type:    MutationType.UPSERT_WORKSPACE,
      payload: { id: currentState.workspaceId, name: currentState.workspaceName },
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
  }, [enqueue]);

  const renameSheet = useCallback(async (sheetId, name) => {
    if (!name?.trim()) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    await SheetService.update(sheetId, currentUser.uid, { name });
    dispatch({ type: 'RENAME_SHEET', payload: { sheetId, name } });
    await enqueue({ type: MutationType.UPSERT_SHEET, payload: { id: sheetId, name } });
  }, [enqueue]);

  const removeSheet = useCallback(async (sheetId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    // softDelete propaga tombstone a tasks/expenses de la sheet
    await SheetService.softDelete(sheetId, currentUser.uid);
    dispatch({ type: 'REMOVE_SHEET', payload: sheetId });
    // Supabase CASCADE elimina tasks/expenses — solo necesitamos DELETE_SHEET
    await enqueue({ type: MutationType.DELETE_SHEET, payload: { id: sheetId } });
  }, [enqueue]);

  // ── Finanzas ─────────────────────────────────────────────────────────────────

  const setCapital = useCallback(async (sheetId, capital) => {
    const parsed = parseFloat(capital);
    if (isNaN(parsed)) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    await SheetService.update(sheetId, currentUser.uid, { capital: parsed });
    dispatch({ type: 'SET_CAPITAL', payload: { sheetId, capital: parsed } });
    await enqueue({ type: MutationType.UPSERT_SHEET, payload: { id: sheetId, capital: parsed } });
  }, [enqueue]);

  const addExpense = useCallback(async (sheetId, { desc, amount }) => {
    if (!desc?.trim() || !amount) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    const rec = await ExpenseService.create({
      sheetId,
      ownerId:     currentUser.uid,
      description: desc,
      amount,
    });
    // Adaptar nomenclatura para compatibilidad con Dashboard.jsx (usa `desc`)
    const expView = { ...rec, desc: rec.description };
    dispatch({ type: 'ADD_EXPENSE', payload: { sheetId, expense: expView } });
    await enqueue({
      type:    MutationType.UPSERT_EXPENSE,
      payload: { id: rec.id, sheet_id: sheetId, description: rec.description, amount: rec.amount },
    });
  }, [enqueue]);

  const removeExpense = useCallback(async (sheetId, expenseId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    await ExpenseService.softDelete(expenseId, currentUser.uid);
    dispatch({ type: 'REMOVE_EXPENSE', payload: { sheetId, expenseId } });
    await enqueue({ type: MutationType.DELETE_EXPENSE, payload: { id: expenseId } });
  }, [enqueue]);

  // ── Tareas ───────────────────────────────────────────────────────────────────

  const addTask = useCallback(async (sheetId, text) => {
    if (!text?.trim()) return;
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    const rec = await TaskService.create({ sheetId, ownerId: currentUser.uid, text });
    dispatch({ type: 'ADD_TASK', payload: { sheetId, task: rec } });
    await enqueue({
      type:    MutationType.UPSERT_TASK,
      payload: { id: rec.id, sheet_id: sheetId, text: rec.text, completed: rec.completed },
    });
  }, [enqueue]);

  const toggleTask = useCallback(async (sheetId, taskId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    const updated = await TaskService.toggle(taskId, currentUser.uid);
    dispatch({ type: 'TOGGLE_TASK', payload: { sheetId, taskId } });
    await enqueue({
      type:    MutationType.UPSERT_TASK,
      payload: { id: updated.id, sheet_id: sheetId, text: updated.text, completed: updated.completed },
    });
  }, [enqueue]);

  const removeTask = useCallback(async (sheetId, taskId) => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return;

    await TaskService.softDelete(taskId, currentUser.uid);
    dispatch({ type: 'REMOVE_TASK', payload: { sheetId, taskId } });
    await enqueue({ type: MutationType.DELETE_TASK, payload: { id: taskId } });
  }, [enqueue]);

  // ── forceSync ────────────────────────────────────────────────────────────────

  const forceSync = useCallback(async () => {
    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
      return;
    }
    await reconcile();
  }, [reconcile]);

  // ─── Selector: hoja activa ──────────────────────────────────────────────────

  const activeSheet = useMemo(
    () => state.sheets.find((s) => s.id === state.activeSheetId) ?? null,
    [state.sheets, state.activeSheetId],
  );

  // ─── Valor del contexto ─────────────────────────────────────────────────────

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