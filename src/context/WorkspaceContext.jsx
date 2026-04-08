/**
 * @file WorkspaceContext.jsx
 * @description Contexto global de hojas de trabajo — Fase 4: Cloud Sync Engine.
 *
 * ── Arquitectura de persistencia ─────────────────────────────────────────────
 *
 *  User Action
 *      │
 *      ▼
 *  dispatch()        ← React state (L1, inmediato, nunca bloquea)
 *      │
 *      ▼
 *  IDB write         ← debounced 600ms (L2, local-first source of truth)
 *      │
 *      ▼
 *  Sync Queue        ← Set de workspaceIds pendientes de push
 *      │
 *      ▼
 *  CloudService      ← background push a Supabase (con retry exponencial)
 *
 * ── Patrones implementados ────────────────────────────────────────────────────
 *
 *  Write-Behind Cache:
 *    Las escrituras locales son síncronas; el push a Supabase es asíncrono
 *    y se ejecuta en background sin bloquear la UI.
 *
 *  Sync Queue (Map<workspaceId, WorkspaceSnapshot>):
 *    Cada acción de usuario añade un snapshot al Map. El drain lee
 *    desde `latestStateRef` para garantizar que siempre se sube el
 *    estado más reciente, evitando race conditions con stale closures.
 *
 *  Reconciliation on Reconnect:
 *    Al recuperar conectividad, fetch delta (since lastSyncedAt).
 *    Remote wins si remote.updated_at > local.workspaceUpdatedAt.
 *    REMOTE_MERGE actualiza React state + IDB sin re-encolar para cloud.
 *
 *  Network Resiliency:
 *    navigator.onLine + 'online'/'offline' events.
 *    syncStatus: 'idle' | 'syncing' | 'error' | 'offline'
 *    forceSync() expuesto para triggers manuales desde UI.
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
import { WorkspaceService, SyncMetaService, makeExpense, makeSheet, makeTask } from '../services/db';
import { CloudService, isCloudConfigured } from '../services/cloudService';

// ─── Estado inicial y Reducer ─────────────────────────────────────────────────

const initialState = {
  status:              'idle',   // 'idle' | 'loading' | 'ready' | 'error'
  workspaceId:         null,
  workspaceName:       'Mi Workspace',
  workspaceUpdatedAt:  null,     // ISO — para comparar con remote.updated_at
  sheets:              [],
  activeSheetId:       null,
  error:               null,
  // ── Sync state ──────────────────────────────────────────────────────────
  syncStatus:          'idle',   // 'idle' | 'syncing' | 'error' | 'offline'
  syncError:           null,
  lastSyncedAt:        null,     // ISO del último sync exitoso
};

function wsReducer(state, action) {
  switch (action.type) {

    // ── Ciclo de carga ──────────────────────────────────────────────────────
    case 'LOADING':
      return { ...state, status: 'loading', error: null };

    case 'INIT_SUCCESS': {
      const { workspaceId, workspaceName, workspaceUpdatedAt, sheets, lastSyncedAt } = action.payload;
      return {
        ...state,
        status: 'ready',
        workspaceId,
        workspaceName:       workspaceName ?? 'Mi Workspace',
        workspaceUpdatedAt:  workspaceUpdatedAt ?? null,
        sheets,
        activeSheetId:       sheets[0]?.id ?? null,
        error:               null,
        lastSyncedAt:        lastSyncedAt ?? null,
      };
    }

    case 'SET_ERROR':
      return { ...state, status: 'error', error: action.payload };

    case 'RESET':
      return initialState;

    // ── Sync state ──────────────────────────────────────────────────────────
    case 'SYNC_STATUS':
      return {
        ...state,
        syncStatus: action.payload.status,
        syncError:  action.payload.error ?? null,
      };

    case 'SET_LAST_SYNCED':
      return { ...state, lastSyncedAt: action.payload, syncStatus: 'idle', syncError: null };

    /**
     * REMOTE_MERGE: integra datos remotos más recientes.
     * Solo actualiza sheets (y nombre si cambió).
     * NO incrementa syncTick → no re-encola para cloud push (evita loop).
     */
    case 'REMOTE_MERGE':
      return {
        ...state,
        sheets:             action.payload.sheets,
        workspaceName:      action.payload.name ?? state.workspaceName,
        workspaceUpdatedAt: action.payload.updatedAt ?? state.workspaceUpdatedAt,
      };

    // ── Navegación de tabs ──────────────────────────────────────────────────
    case 'SET_ACTIVE_SHEET':
      return { ...state, activeSheetId: action.payload };

    // ── CRUD de Sheets ──────────────────────────────────────────────────────
    case 'ADD_SHEET': {
      const sheet = makeSheet(action.payload);
      return {
        ...state,
        sheets:        [...state.sheets, sheet],
        activeSheetId: sheet.id,
      };
    }

    case 'RENAME_SHEET':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, name: action.payload.name }
            : s,
        ),
      };

    case 'REMOVE_SHEET': {
      const next = state.sheets.filter((s) => s.id !== action.payload);
      return {
        ...state,
        sheets: next,
        activeSheetId:
          state.activeSheetId === action.payload
            ? (next[0]?.id ?? null)
            : state.activeSheetId,
      };
    }

    // ── Finanzas ────────────────────────────────────────────────────────────
    case 'SET_CAPITAL':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, capital: action.payload.capital }
            : s,
        ),
      };

    case 'ADD_EXPENSE':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, expenses: [...s.expenses, makeExpense(action.payload.expense)] }
            : s,
        ),
      };

    case 'REMOVE_EXPENSE':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, expenses: s.expenses.filter((e) => e.id !== action.payload.expenseId) }
            : s,
        ),
      };

    // ── Tareas ──────────────────────────────────────────────────────────────
    case 'ADD_TASK':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, tasks: [...s.tasks, makeTask(action.payload.text)] }
            : s,
        ),
      };

    case 'TOGGLE_TASK':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? {
                ...s,
                tasks: s.tasks.map((t) =>
                  t.id === action.payload.taskId
                    ? { ...t, completed: !t.completed }
                    : t,
                ),
              }
            : s,
        ),
      };

    case 'REMOVE_TASK':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, tasks: s.tasks.filter((t) => t.id !== action.payload.taskId) }
            : s,
        ),
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
  const [state, dispatch] = useReducer(wsReducer, initialState);

  // ── Refs ────────────────────────────────────────────────────────────────────

  // Siempre apunta al estado React más reciente — evita stale closures en async callbacks
  const latestStateRef = useRef(state);
  useEffect(() => { latestStateRef.current = state; });

  // Ref al user para evitar cerrar sobre el estado del efecto
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // Write-behind queue: Map<workspaceId, true> — solo necesitamos el ID
  // Se usa Map en lugar de Set para extensibilidad futura (multi-workspace)
  const syncQueueRef = useRef(new Map());

  // Mutex — evita ejecuciones concurrentes del drain
  const isSyncingRef = useRef(false);

  // Ref para el timer de debounce de IDB
  const persistTimerRef = useRef(null);

  // Flag de inicialización — evita re-fetch en re-renders de AuthContext
  const initialized = useRef(false);

  // ── syncTick: dispara el drainQueue effect ──────────────────────────────────
  // Es un contador, no datos. Cambiarlo re-ejecuta el drain sin incluirlo en deps.
  const [syncTick, setSyncTick] = useState(0);

  // ─── Helpers de enqueueing ──────────────────────────────────────────────────

  /**
   * Añade el workspace activo a la sync queue y dispara el drain.
   * Llamado desde cada acción que muta datos locales.
   * NO-OP si cloud no está configurado o el usuario no tiene supabaseUid.
   */
  const enqueue = useCallback(() => {
    const currentState = latestStateRef.current;
    const currentUser  = userRef.current;
    if (!currentState.workspaceId || !currentUser?.supabaseUid) return;
    if (!isCloudConfigured()) return;
    syncQueueRef.current.set(currentState.workspaceId, true);
    setSyncTick((t) => t + 1);
  }, []);

  // ─── IDB: Carga inicial ─────────────────────────────────────────────────────

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
        const ws   = await WorkspaceService.ensureDefault(user.uid);
        const meta = await SyncMetaService.get(user.uid);

        dispatch({
          type:    'INIT_SUCCESS',
          payload: {
            workspaceId:        ws.id,
            workspaceName:      ws.name,
            workspaceUpdatedAt: ws.updatedAt ?? null,
            sheets:             ws.sheets,
            lastSyncedAt:       meta?.lastSyncedAt ?? null,
          },
        });
        initialized.current = true;
      } catch (err) {
        dispatch({ type: 'SET_ERROR', payload: err.message });
      }
    }

    init();
  }, [isAuthenticated, user?.uid]);

  // ─── IDB: Write-Behind debounced 600ms ─────────────────────────────────────

  useEffect(() => {
    if (state.status !== 'ready' || !state.workspaceId || !user?.uid) return;

    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(async () => {
      try {
        await WorkspaceService.saveSheets(state.workspaceId, user.uid, state.sheets);
      } catch (err) {
        console.error('[WorkspaceContext] IDB write error:', err.message);
      }
    }, 600);

    return () => clearTimeout(persistTimerRef.current);
  }, [state.sheets, state.workspaceId, state.status, user?.uid]);

  // ─── Cloud: Drain Queue ─────────────────────────────────────────────────────

  /**
   * Procesa la sync queue: empuja cada workspace pendiente a Supabase.
   *
   * Garantías de atomicidad:
   *  - Fallo en cloud push → el workspace PERMANECE en la queue (retry en el próximo tick)
   *  - IDB ya tiene los datos — la escritura cloud nunca afecta el estado local
   *  - isSyncingRef previene ejecuciones solapadas
   */
  const drainQueue = useCallback(async () => {
    if (isSyncingRef.current) return;
    if (syncQueueRef.current.size === 0) return;
    if (!isCloudConfigured()) return;

    const currentUser = userRef.current;
    if (!currentUser?.supabaseUid) return;

    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
      return;
    }

    isSyncingRef.current = true;
    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      for (const [wsId] of syncQueueRef.current) {
        const { sheets, workspaceName } = latestStateRef.current;

        await CloudService.upsertWorkspace(
          { id: wsId, name: workspaceName, sheets },
          currentUser.supabaseUid,
        );

        // Solo eliminar del queue si el push fue exitoso
        syncQueueRef.current.delete(wsId);
      }

      const now = new Date().toISOString();
      await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: now });
      dispatch({ type: 'SET_LAST_SYNCED', payload: now });

    } catch (err) {
      // El workspace permanece en la queue — se reintentará en el próximo tick
      console.error('[WorkspaceContext] Cloud push error:', err.message);
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'error', error: err.message } });
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // Drain se ejecuta cada vez que syncTick cambia (enqueue lo incrementa)
  useEffect(() => {
    if (syncTick === 0) return;
    drainQueue();
  }, [syncTick, drainQueue]);

  // ─── Network Resiliency: online / offline events ───────────────────────────

  /**
   * Reconcilia datos locales con Supabase al recuperar conectividad.
   *
   * Estrategia de resolución de conflictos (Last-Write-Wins por timestamp):
   *  - Remote updated_at > local workspaceUpdatedAt → REMOTE_MERGE (remote gana)
   *  - Local más reciente → el queue ya lo tiene → se sube al reconectar
   *  - Sin datos remotos en el delta → nada que hacer
   *
   * "Initial Hydration" (nuevo dispositivo / browser limpio):
   *  Si lastSyncedAt es null, fetchRemoteWorkspaces devuelve TODOS los registros.
   *  Esto permite que un usuario con datos en Supabase los recupere en un nuevo browser.
   */
  const reconcile = useCallback(async () => {
    const currentUser  = userRef.current;
    const currentState = latestStateRef.current;

    if (!currentUser?.supabaseUid || !currentUser?.uid) return;
    if (!isCloudConfigured()) return;
    if (currentState.status !== 'ready') return;

    dispatch({ type: 'SYNC_STATUS', payload: { status: 'syncing' } });

    try {
      const remoteList = await CloudService.fetchRemoteWorkspaces(
        currentUser.supabaseUid,
        currentState.lastSyncedAt,  // null → full fetch (initial hydration)
      );

      for (const remote of remoteList) {
        // Buscar el workspace local por idb_id
        if (remote.idb_id !== currentState.workspaceId) {
          // Workspace de otro dispositivo que no existe localmente → crear en IDB
          // (Fase 4: soporte single-workspace. Multi-workspace en Fase 5)
          continue;
        }

        const remoteTime = new Date(remote.updated_at).getTime();
        const localTime  = currentState.workspaceUpdatedAt
          ? new Date(currentState.workspaceUpdatedAt).getTime()
          : 0;

        if (remoteTime > localTime) {
          // Remote es más reciente — merge sin re-encolar (no hay cambio local)
          dispatch({
            type:    'REMOTE_MERGE',
            payload: {
              sheets:    remote.sheets,
              name:      remote.name,
              updatedAt: remote.updated_at,
            },
          });

          // Persistir en IDB para que el state refleje la fuente de verdad
          await WorkspaceService.saveSheets(
            currentState.workspaceId,
            currentUser.uid,
            remote.sheets,
          );
        }
        // else: local es más reciente → ya está en la queue → se subirá ahora
      }

      // Después de reconciliar, drenar la queue (datos locales más recientes → subir)
      if (syncQueueRef.current.size > 0) {
        await drainQueue();
      } else {
        const now = new Date().toISOString();
        await SyncMetaService.upsert(currentUser.uid, { lastSyncedAt: now });
        dispatch({ type: 'SET_LAST_SYNCED', payload: now });
      }

    } catch (err) {
      console.error('[WorkspaceContext] Reconciliation error:', err.message);
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'error', error: err.message } });
    }
  }, [drainQueue]);

  useEffect(() => {
    const handleOnline  = () => reconcile();
    const handleOffline = () => dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    // Inicializar estado de red al montar
    if (!navigator.onLine) {
      dispatch({ type: 'SYNC_STATUS', payload: { status: 'offline' } });
    }

    return () => {
      // Limpieza de listeners — evita memory leaks
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [reconcile]);

  // ─── Acciones públicas ──────────────────────────────────────────────────────

  const setActiveSheet = useCallback((sheetId) => {
    dispatch({ type: 'SET_ACTIVE_SHEET', payload: sheetId });
  }, []);

  // ── Sheets ──────────────────────────────────────────────────────────────────

  const addSheet = useCallback((name = 'Nueva hoja') => {
    dispatch({ type: 'ADD_SHEET', payload: name });
    enqueue();
  }, [enqueue]);

  const renameSheet = useCallback((sheetId, name) => {
    if (!name?.trim()) return;
    dispatch({ type: 'RENAME_SHEET', payload: { sheetId, name } });
    enqueue();
  }, [enqueue]);

  const removeSheet = useCallback((sheetId) => {
    dispatch({ type: 'REMOVE_SHEET', payload: sheetId });
    enqueue();
  }, [enqueue]);

  // ── Finanzas ────────────────────────────────────────────────────────────────

  const setCapital = useCallback((sheetId, capital) => {
    const parsed = parseFloat(capital);
    if (isNaN(parsed)) return;
    dispatch({ type: 'SET_CAPITAL', payload: { sheetId, capital: parsed } });
    enqueue();
  }, [enqueue]);

  const addExpense = useCallback((sheetId, { desc, amount }) => {
    if (!desc?.trim() || !amount) return;
    dispatch({ type: 'ADD_EXPENSE', payload: { sheetId, expense: { desc, amount } } });
    enqueue();
  }, [enqueue]);

  const removeExpense = useCallback((sheetId, expenseId) => {
    dispatch({ type: 'REMOVE_EXPENSE', payload: { sheetId, expenseId } });
    enqueue();
  }, [enqueue]);

  // ── Tareas ──────────────────────────────────────────────────────────────────

  const addTask = useCallback((sheetId, text) => {
    if (!text?.trim()) return;
    dispatch({ type: 'ADD_TASK', payload: { sheetId, text } });
    enqueue();
  }, [enqueue]);

  const toggleTask = useCallback((sheetId, taskId) => {
    dispatch({ type: 'TOGGLE_TASK', payload: { sheetId, taskId } });
    enqueue();
  }, [enqueue]);

  const removeTask = useCallback((sheetId, taskId) => {
    dispatch({ type: 'REMOVE_TASK', payload: { sheetId, taskId } });
    enqueue();
  }, [enqueue]);

  // ── forceSync: trigger manual ────────────────────────────────────────────────

  /**
   * Fuerza una reconciliación completa seguida de drain del queue.
   * Expuesto en el contexto para que NavBar pueda ofrecer un botón de sync manual.
   */
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
      // Estado local
      status:       state.status,
      error:        state.error,
      sheets:       state.sheets,
      activeSheetId: state.activeSheetId,
      activeSheet,
      isReady:      state.status === 'ready',
      // Estado de sync
      syncStatus:   state.syncStatus,
      syncError:    state.syncError,
      lastSyncedAt: state.lastSyncedAt,
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
      state.syncStatus, state.syncError, state.lastSyncedAt,
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