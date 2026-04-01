/**
 * @file WorkspaceContext.jsx
 * @description Contexto global para la gestión de hojas de trabajo (sheets).
 *
 * Modelo de datos (embebido en workspace IDB):
 *   Workspace { id, ownerId, sheets: Sheet[] }
 *   Sheet     { id, name, capital, expenses: Expense[], tasks: Task[] }
 *   Expense   { id, desc, amount }
 *   Task      { id, text, completed }
 *
 * Flujo de escritura:
 *   Acción de usuario → dispatch (actualiza estado React) →
 *   useEffect reacciona al cambio de sheets → WorkspaceService.saveSheets()
 *
 * El throttle en la persistencia evita writes en cada keystroke del input capital.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { useAuth } from './AuthContext';
import { WorkspaceService, makeExpense, makeSheet, makeTask } from '../services/db';

// ─── Estado inicial y Reducer ─────────────────────────────────────────────────

/** @typedef {'idle'|'loading'|'ready'|'error'} WorkspaceStatus */

const initialState = {
  status: 'idle',
  workspaceId: null,       // ID del workspace activo en IDB
  sheets: [],              // Sheet[]
  activeSheetId: null,     // ID de la tab seleccionada
  error: null,
};

function wsReducer(state, action) {
  switch (action.type) {
    // ── Ciclo de carga ──────────────────────────────────────────────────────
    case 'LOADING':
      return { ...state, status: 'loading', error: null };

    case 'INIT_SUCCESS': {
      const { workspaceId, sheets } = action.payload;
      return {
        status: 'ready',
        workspaceId,
        sheets,
        activeSheetId: sheets[0]?.id ?? null,
        error: null,
      };
    }

    case 'SET_ERROR':
      return { ...state, status: 'error', error: action.payload };

    case 'RESET':
      return initialState;

    // ── Navegación de tabs ──────────────────────────────────────────────────
    case 'SET_ACTIVE_SHEET':
      return { ...state, activeSheetId: action.payload };

    // ── CRUD de Sheets ──────────────────────────────────────────────────────
    case 'ADD_SHEET': {
      const sheet = makeSheet(action.payload);
      return {
        ...state,
        sheets: [...state.sheets, sheet],
        activeSheetId: sheet.id,
      };
    }

    case 'RENAME_SHEET':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, name: action.payload.name }
            : s
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
            : s
        ),
      };

    case 'ADD_EXPENSE':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, expenses: [...s.expenses, makeExpense(action.payload.expense)] }
            : s
        ),
      };

    case 'REMOVE_EXPENSE':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, expenses: s.expenses.filter((e) => e.id !== action.payload.expenseId) }
            : s
        ),
      };

    // ── Tareas ──────────────────────────────────────────────────────────────
    case 'ADD_TASK':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, tasks: [...s.tasks, makeTask(action.payload.text)] }
            : s
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
                    : t
                ),
              }
            : s
        ),
      };

    case 'REMOVE_TASK':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.payload.sheetId
            ? { ...s, tasks: s.tasks.filter((t) => t.id !== action.payload.taskId) }
            : s
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

  // Ref para el timer de throttle en persistencia
  const persistTimer = useRef(null);
  // Ref para saber si ya cargamos (evitar re-fetch en re-renders de AuthContext)
  const initialized = useRef(false);

  // ── Carga inicial desde IDB ───────────────────────────────────────────────
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
        const ws = await WorkspaceService.ensureDefault(user.uid);
        dispatch({
          type: 'INIT_SUCCESS',
          payload: { workspaceId: ws.id, sheets: ws.sheets },
        });
        initialized.current = true;
      } catch (err) {
        dispatch({ type: 'SET_ERROR', payload: err.message });
      }
    }

    init();
  }, [isAuthenticated, user?.uid]);

  // ── Persistencia reactiva (throttled 600ms) ───────────────────────────────
  // Solo persiste cuando el estado está `ready` y hay un workspace cargado.
  useEffect(() => {
    if (state.status !== 'ready' || !state.workspaceId || !user?.uid) return;

    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(async () => {
      try {
        await WorkspaceService.saveSheets(state.workspaceId, user.uid, state.sheets);
      } catch (err) {
        console.error('[WorkspaceContext] Error al persistir sheets:', err.message);
      }
    }, 600);

    return () => clearTimeout(persistTimer.current);
  }, [state.sheets, state.workspaceId, state.status, user?.uid]);

  // ── Acción: hoja activa ───────────────────────────────────────────────────
  const setActiveSheet = useCallback((sheetId) => {
    dispatch({ type: 'SET_ACTIVE_SHEET', payload: sheetId });
  }, []);

  // ── Acciones: sheets ──────────────────────────────────────────────────────
  const addSheet = useCallback((name = 'Nueva hoja') => {
    dispatch({ type: 'ADD_SHEET', payload: name });
  }, []);

  const renameSheet = useCallback((sheetId, name) => {
    if (!name?.trim()) return;
    dispatch({ type: 'RENAME_SHEET', payload: { sheetId, name } });
  }, []);

  const removeSheet = useCallback((sheetId) => {
    dispatch({ type: 'REMOVE_SHEET', payload: sheetId });
  }, []);

  // ── Acciones: finanzas ────────────────────────────────────────────────────
  const setCapital = useCallback((sheetId, capital) => {
    const parsed = parseFloat(capital);
    if (isNaN(parsed)) return;
    dispatch({ type: 'SET_CAPITAL', payload: { sheetId, capital: parsed } });
  }, []);

  const addExpense = useCallback((sheetId, { desc, amount }) => {
    if (!desc?.trim() || !amount) return;
    dispatch({ type: 'ADD_EXPENSE', payload: { sheetId, expense: { desc, amount } } });
  }, []);

  const removeExpense = useCallback((sheetId, expenseId) => {
    dispatch({ type: 'REMOVE_EXPENSE', payload: { sheetId, expenseId } });
  }, []);

  // ── Acciones: tareas ──────────────────────────────────────────────────────
  const addTask = useCallback((sheetId, text) => {
    if (!text?.trim()) return;
    dispatch({ type: 'ADD_TASK', payload: { sheetId, text } });
  }, []);

  const toggleTask = useCallback((sheetId, taskId) => {
    dispatch({ type: 'TOGGLE_TASK', payload: { sheetId, taskId } });
  }, []);

  const removeTask = useCallback((sheetId, taskId) => {
    dispatch({ type: 'REMOVE_TASK', payload: { sheetId, taskId } });
  }, []);

  // ── Selector: hoja activa ─────────────────────────────────────────────────
  const activeSheet = useMemo(
    () => state.sheets.find((s) => s.id === state.activeSheetId) ?? null,
    [state.sheets, state.activeSheetId]
  );

  // ── Valor del contexto ────────────────────────────────────────────────────
  const value = useMemo(
    () => ({
      // Estado
      status: state.status,
      error: state.error,
      sheets: state.sheets,
      activeSheetId: state.activeSheetId,
      activeSheet,
      isReady: state.status === 'ready',
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
    }),
    [
      state.status, state.error, state.sheets, state.activeSheetId,
      activeSheet,
      setActiveSheet,
      addSheet, renameSheet, removeSheet,
      setCapital, addExpense, removeExpense,
      addTask, toggleTask, removeTask,
    ]
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