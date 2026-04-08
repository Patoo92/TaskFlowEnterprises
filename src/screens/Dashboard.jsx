/**
 * @file Dashboard.jsx
 * @description Panel principal de TaskFlow Enterprise (Fase 2).
 *
 * Secciones:
 *  ┌─ TabBar ─────────────────────────────────────────────┐
 *  │  [Hoja 1] [Hoja 2] … [+]                            │
 *  └──────────────────────────────────────────────────────┘
 *  ┌─ FinancePanel ──────────────┐ ┌─ TaskPanel ──────────┐
 *  │  Capital inicial            │ │  Input nueva tarea   │
 *  │  Lista de gastos            │ │  Lista con checkbox  │
 *  │  Balance (useMemo)          │ │                      │
 *  └─────────────────────────────┘ └──────────────────────┘
 *
 * Toda la lógica de datos se delega a useWorkspace().
 * Los cálculos financieros están memoizados para no recalcular en cada render.
 */

import {
  memo,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Check,
  ChevronDown,
  DollarSign,
  FileSpreadsheet,
  Loader2,
  Minus,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { exportSheetToExcel } from '../services/excelService';

// ─── Helpers de formato ───────────────────────────────────────────────────────

const formatCurrency = (n) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(n);

// ─── Subcomponentes ───────────────────────────────────────────────────────────

// ── TabBar ────────────────────────────────────────────────────────────────────

const TabBar = memo(function TabBar({ sheets, activeSheetId, onSelect, onAdd, onRemove }) {
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const { renameSheet } = useWorkspace();

  const startRename = useCallback((sheet) => {
    setRenamingId(sheet.id);
    setRenameValue(sheet.name);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSheet(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, renameSheet]);

  return (
    <div className="flex items-center gap-1 px-5 border-b border-white/[0.06] overflow-x-auto scrollbar-none">
      {sheets.map((sheet) => (
        <div key={sheet.id} className="relative flex-shrink-0 group">
          {renamingId === sheet.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
              className="
                h-10 px-3 text-xs font-mono bg-[#161b22] border border-emerald-500/40
                text-white rounded-t-md outline-none w-32
              "
            />
          ) : (
            <button
              onClick={() => onSelect(sheet.id)}
              onDoubleClick={() => startRename(sheet)}
              className={`
                relative h-10 px-4 text-xs font-mono whitespace-nowrap
                border-b-2 transition-all duration-150
                ${activeSheetId === sheet.id
                  ? 'text-emerald-400 border-emerald-500 bg-emerald-500/5'
                  : 'text-white/40 border-transparent hover:text-white/70 hover:bg-white/[0.03]'
                }
              `}
            >
              {sheet.name}
            </button>
          )}

          {/* Botón eliminar (solo visible al hover, solo si hay > 1 sheet) */}
          {sheets.length > 1 && renamingId !== sheet.id && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(sheet.id); }}
              className="
                absolute -top-0.5 -right-0.5 opacity-0 group-hover:opacity-100
                w-4 h-4 rounded-full bg-[#0d1117] border border-white/10
                flex items-center justify-center
                text-white/30 hover:text-red-400
                transition-all duration-150 z-10
              "
            >
              <X size={8} />
            </button>
          )}
        </div>
      ))}

      {/* Botón Nueva hoja */}
      <button
        onClick={onAdd}
        className="
          flex-shrink-0 h-10 px-3 flex items-center gap-1.5
          text-white/30 hover:text-emerald-400
          transition-colors duration-150 font-mono text-xs
        "
        title="Nueva hoja"
      >
        <Plus size={13} />
        <span className="hidden sm:block">Nueva</span>
      </button>
    </div>
  );
});

// ── FinancePanel ──────────────────────────────────────────────────────────────

/** Estado local del formulario de gastos */
const expenseInit = { desc: '', amount: '' };
function expenseReducer(state, action) {
  switch (action.type) {
    case 'SET': return { ...state, [action.field]: action.value };
    case 'RESET': return expenseInit;
    default: return state;
  }
}

const FinancePanel = memo(function FinancePanel({ sheet }) {
  const { setCapital, addExpense, removeExpense } = useWorkspace();
  const [expForm, dispatchExp] = useReducer(expenseReducer, expenseInit);
  const amountRef = useRef(null);

  // ── Cálculos memoizados ──────────────────────────────────────────────────
  const totalExpenses = useMemo(
    () => sheet.expenses.reduce((acc, e) => acc + e.amount, 0),
    [sheet.expenses]
  );

  const balance = useMemo(
    () => sheet.capital - totalExpenses,
    [sheet.capital, totalExpenses]
  );

  const balanceRatio = useMemo(
    () => (sheet.capital > 0 ? Math.min((totalExpenses / sheet.capital) * 100, 100) : 0),
    [sheet.capital, totalExpenses]
  );

  const handleAddExpense = useCallback(() => {
    const amount = parseFloat(expForm.amount);
    if (!expForm.desc.trim() || isNaN(amount) || amount <= 0) return;
    addExpense(sheet.id, { desc: expForm.desc, amount });
    dispatchExp({ type: 'RESET' });
  }, [sheet.id, expForm, addExpense]);

  const handleExpenseKey = useCallback((e) => {
    if (e.key === 'Enter') handleAddExpense();
  }, [handleAddExpense]);

  return (
    <div className="flex flex-col gap-5">
      {/* Capital inicial */}
      <div>
        <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest mb-2">
          Capital inicial
        </label>
        <div className="flex items-center gap-2 bg-[#161b22] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-emerald-500/40 transition-colors">
          <DollarSign size={14} className="text-emerald-500/60 shrink-0" />
          <input
            type="number"
            min="0"
            step="0.01"
            value={sheet.capital || ''}
            onChange={(e) => setCapital(sheet.id, e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-sm font-mono text-white outline-none placeholder:text-white/20"
          />
        </div>
      </div>

      {/* Resumen financiero */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Capital', value: formatCurrency(sheet.capital), color: 'text-white/80', Icon: TrendingUp },
          { label: 'Gastos', value: formatCurrency(totalExpenses), color: 'text-red-400', Icon: TrendingDown },
          {
            label: 'Balance',
            value: formatCurrency(balance),
            color: balance >= 0 ? 'text-emerald-400' : 'text-red-400',
            Icon: balance >= 0 ? TrendingUp : TrendingDown,
          },
        ].map(({ label, value, color, Icon }) => (
          <div key={label} className="bg-[#161b22] border border-white/[0.06] rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Icon size={11} className={`${color} opacity-70`} />
              <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{label}</span>
            </div>
            <p className={`text-sm font-mono font-bold ${color} leading-none`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Barra de progreso de gasto */}
      {sheet.capital > 0 && (
        <div>
          <div className="flex justify-between text-[10px] font-mono text-white/25 mb-1.5">
            <span>Consumo del capital</span>
            <span>{balanceRatio.toFixed(1)}%</span>
          </div>
          <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                balanceRatio > 90 ? 'bg-red-500' : balanceRatio > 65 ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${balanceRatio}%` }}
            />
          </div>
        </div>
      )}

      {/* Formulario agregar gasto */}
      <div>
        <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest mb-2">
          Registrar gasto
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Descripción"
            value={expForm.desc}
            onChange={(e) => dispatchExp({ type: 'SET', field: 'desc', value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') amountRef.current?.focus(); }}
            className="
              flex-1 bg-[#161b22] border border-white/[0.08] rounded-lg
              px-3 py-2 text-xs font-mono text-white outline-none
              placeholder:text-white/20 focus:border-emerald-500/40 transition-colors
            "
          />
          <input
            ref={amountRef}
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={expForm.amount}
            onChange={(e) => dispatchExp({ type: 'SET', field: 'amount', value: e.target.value })}
            onKeyDown={handleExpenseKey}
            className="
              w-24 bg-[#161b22] border border-white/[0.08] rounded-lg
              px-3 py-2 text-xs font-mono text-white outline-none
              placeholder:text-white/20 focus:border-emerald-500/40 transition-colors
            "
          />
          <button
            onClick={handleAddExpense}
            className="
              w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20
              text-emerald-400 hover:bg-emerald-500/20 transition-colors
              flex items-center justify-center shrink-0
            "
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Lista de gastos */}
      {sheet.expenses.length > 0 && (
        <div className="space-y-1.5">
          <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest">
            Gastos ({sheet.expenses.length})
          </label>
          <div className="space-y-1 max-h-56 overflow-y-auto pr-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
            {sheet.expenses.map((exp) => (
              <div
                key={exp.id}
                className="
                  flex items-center justify-between
                  bg-[#161b22] border border-white/[0.06] rounded-lg
                  px-3 py-2 group
                "
              >
                <span className="text-xs font-mono text-white/70 truncate flex-1 mr-3">
                  {exp.desc}
                </span>
                <span className="text-xs font-mono text-red-400 shrink-0 mr-3">
                  -{formatCurrency(exp.amount)}
                </span>
                <button
                  onClick={() => removeExpense(sheet.id, exp.id)}
                  className="
                    opacity-0 group-hover:opacity-100 transition-opacity
                    text-white/20 hover:text-red-400
                  "
                >
                  <Minus size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

// ── TaskPanel ─────────────────────────────────────────────────────────────────

const TaskPanel = memo(function TaskPanel({ sheet }) {
  const { addTask, toggleTask, removeTask } = useWorkspace();
  const [text, setText] = useState('');

  const pending = useMemo(() => sheet.tasks.filter((t) => !t.completed), [sheet.tasks]);
  const done = useMemo(() => sheet.tasks.filter((t) => t.completed), [sheet.tasks]);

  const handleAdd = useCallback(() => {
    if (!text.trim()) return;
    addTask(sheet.id, text);
    setText('');
  }, [sheet.id, text, addTask]);

  return (
    <div className="flex flex-col gap-5 h-full">
      {/* Input */}
      <div>
        <label className="block text-[10px] font-mono text-white/30 uppercase tracking-widest mb-2">
          Nueva tarea
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Describe la tarea..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            className="
              flex-1 bg-[#161b22] border border-white/[0.08] rounded-lg
              px-3 py-2 text-xs font-mono text-white outline-none
              placeholder:text-white/20 focus:border-emerald-500/40 transition-colors
            "
          />
          <button
            onClick={handleAdd}
            className="
              w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20
              text-emerald-400 hover:bg-emerald-500/20 transition-colors
              flex items-center justify-center shrink-0
            "
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Stats */}
      {sheet.tasks.length > 0 && (
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span className="text-white/40">
            {done.length}/{sheet.tasks.length} completadas
          </span>
          <div className="flex-1 h-px bg-white/[0.06]" />
          <span className="text-emerald-400/60">{pending.length} pendientes</span>
        </div>
      )}

      {/* Lista pendientes */}
      {pending.length > 0 && (
        <div className="space-y-1.5">
          {pending.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              sheetId={sheet.id}
              onToggle={toggleTask}
              onRemove={removeTask}
            />
          ))}
        </div>
      )}

      {/* Lista completadas */}
      {done.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest">
            Completadas
          </p>
          {done.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              sheetId={sheet.id}
              onToggle={toggleTask}
              onRemove={removeTask}
            />
          ))}
        </div>
      )}

      {sheet.tasks.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center py-10 opacity-30">
          <Check size={28} className="text-white/20 mb-3" />
          <p className="text-xs font-mono text-white/30">Sin tareas. ¡Añade una!</p>
        </div>
      )}
    </div>
  );
});

const TaskItem = memo(function TaskItem({ task, sheetId, onToggle, onRemove }) {
  return (
    <div
      className={`
        flex items-center gap-3 px-3 py-2.5 rounded-lg border group
        transition-all duration-150
        ${task.completed
          ? 'bg-emerald-500/5 border-emerald-500/10'
          : 'bg-[#161b22] border-white/[0.06] hover:border-white/10'
        }
      `}
    >
      {/* Checkbox custom */}
      <button
        onClick={() => onToggle(sheetId, task.id)}
        className={`
          w-4 h-4 rounded border flex items-center justify-center shrink-0
          transition-all duration-150
          ${task.completed
            ? 'bg-emerald-500 border-emerald-500'
            : 'border-white/20 hover:border-emerald-500/50'
          }
        `}
      >
        {task.completed && <Check size={10} className="text-[#0d1117]" strokeWidth={3} />}
      </button>

      <span
        className={`
          flex-1 text-xs font-mono leading-relaxed transition-all duration-150
          ${task.completed ? 'line-through text-white/25' : 'text-white/75'}
        `}
      >
        {task.text}
      </span>

      <button
        onClick={() => onRemove(sheetId, task.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-white/15 hover:text-red-400"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
});

// ── ExportButton ──────────────────────────────────────────────────────────────

/**
 * Botón de exportación a Excel para la hoja activa.
 * Estados: idle → exporting (spinner) → idle
 * Errores capturados internamente para no romper el flujo del dashboard.
 */
const ExportButton = memo(function ExportButton({ sheet }) {
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (exporting || !sheet) return;
    setExporting(true);
    try {
      await exportSheetToExcel(sheet);
    } catch (err) {
      console.error('[ExportButton] Error al exportar:', err.message);
    } finally {
      setExporting(false);
    }
  }, [sheet, exporting]);

  return (
    <button
      onClick={handleExport}
      disabled={exporting || !sheet}
      title={exporting ? 'Exportando...' : 'Exportar hoja a Excel'}
      className={`
        flex items-center gap-1.5 px-3 py-1.5 rounded-lg
        border text-xs font-mono
        transition-all duration-150
        disabled:cursor-not-allowed
        ${exporting
          ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400/60'
          : 'border-white/[0.08] hover:border-emerald-500/30 bg-transparent hover:bg-emerald-500/5 text-white/40 hover:text-emerald-400'
        }
      `}
    >
      {exporting ? (
        <>
          <Loader2 size={12} className="animate-spin" />
          <span>Exportando...</span>
        </>
      ) : (
        <>
          <FileSpreadsheet size={12} />
          <span>Exportar Excel</span>
        </>
      )}
    </button>
  );
});

// ── Skeleton de carga ─────────────────────────────────────────────────────────

const DashboardSkeleton = memo(function DashboardSkeleton() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="h-10 border-b border-white/[0.06] flex items-center px-5 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 w-20 bg-white/[0.04] rounded" />
        ))}
      </div>
      <div className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="h-3 w-24 bg-white/[0.04] rounded" />
          <div className="h-10 bg-white/[0.04] rounded-lg" />
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-white/[0.04] rounded-lg" />)}
          </div>
        </div>
        <div className="space-y-4">
          <div className="h-3 w-24 bg-white/[0.04] rounded" />
          <div className="h-10 bg-white/[0.04] rounded-lg" />
          {[1, 2, 3].map((i) => <div key={i} className="h-10 bg-white/[0.04] rounded-lg" />)}
        </div>
      </div>
    </div>
  );
});

// ─── Dashboard principal ──────────────────────────────────────────────────────

function Dashboard() {
  const {
    sheets,
    activeSheetId,
    activeSheet,
    isReady,
    status,
    setActiveSheet,
    addSheet,
    removeSheet,
  } = useWorkspace();

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-red-400 font-mono text-sm">Error al cargar el workspace.</p>
      </div>
    );
  }

  if (!isReady) return <DashboardSkeleton />;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Barra de tabs ────────────────────────────────────────────────── */}
      <TabBar
        sheets={sheets}
        activeSheetId={activeSheetId}
        onSelect={setActiveSheet}
        onAdd={() => addSheet()}
        onRemove={removeSheet}
      />

      {/* ── Contenido de la hoja activa ───────────────────────────────────── */}
      {activeSheet ? (
        <div className="flex-1 overflow-y-auto p-6">
          {/* Header de hoja */}
          <div className="flex items-start justify-between gap-4 mb-6">
            <div className="min-w-0">
              <h2 className="text-base font-mono font-bold text-white truncate">
                {activeSheet.name}
              </h2>
              <p className="text-[11px] font-mono text-white/25 mt-0.5">
                Doble clic en la pestaña para renombrar · {activeSheet.tasks.length} tareas · {activeSheet.expenses.length} gastos
              </p>
            </div>
            {/* Barra de herramientas de la hoja */}
            <div className="flex items-center gap-2 shrink-0 pt-0.5">
              <ExportButton sheet={activeSheet} />
            </div>
          </div>

          {/* Grid bicolumna */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Finanzas */}
            <div className="bg-[#0d1117] border border-white/[0.06] rounded-xl p-5">
              <div className="flex items-center gap-2 mb-5">
                <TrendingUp size={13} className="text-emerald-400" />
                <h3 className="text-xs font-mono font-bold text-white/70 uppercase tracking-widest">
                  Finanzas
                </h3>
              </div>
              <FinancePanel sheet={activeSheet} />
            </div>

            {/* Tareas */}
            <div className="bg-[#0d1117] border border-white/[0.06] rounded-xl p-5 flex flex-col">
              <div className="flex items-center gap-2 mb-5">
                <Check size={13} className="text-emerald-400" />
                <h3 className="text-xs font-mono font-bold text-white/70 uppercase tracking-widest">
                  Tareas
                </h3>
              </div>
              <TaskPanel sheet={activeSheet} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center opacity-30">
          <ChevronDown size={24} className="text-white/20 mb-3" />
          <p className="text-xs font-mono text-white/30">Crea una hoja para comenzar</p>
        </div>
      )}
    </div>
  );
}

export default memo(Dashboard);