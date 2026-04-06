/**
 * @file excelService.js
 * @description Servicio de exportación a Excel para TaskFlow Enterprise.
 *
 * Genera un archivo .xlsx con tres pestañas a partir de los datos de una Sheet:
 *   1. "Resumen"          → KPIs financieros (Capital, Gastos Totales, Balance)
 *   2. "Gastos"           → Listado detallado con descripción, importe y peso relativo
 *   3. "Tareas"           → Listado de tareas con estado (Pendiente / Completado)
 *
 * API pública:
 *   exportSheetToExcel(sheetData) → Promise<void>
 *     Genera el archivo y dispara la descarga en el navegador.
 *     Lanza si sheetData es inválido.
 *
 * Dependencia: librería `xlsx` (SheetJS Community Edition)
 *   - XLSX.utils.json_to_sheet  → convierte arrays de objetos a filas Excel
 *   - XLSX.utils.book_new       → crea el workbook vacío
 *   - XLSX.utils.book_append_sheet → añade una worksheet al workbook
 *   - XLSX.writeFile            → dispara la descarga automática en el browser
 */

import * as XLSX from 'xlsx';

// ─── Constantes de estilo ─────────────────────────────────────────────────────

/**
 * Anchos de columna por defecto (en caracteres).
 * SheetJS usa la unidad "wch" (width in characters).
 */
const COL_WIDTHS = {
  label:   { wch: 28 },  // columna de etiquetas / descripciones
  value:   { wch: 18 },  // columna de valores numéricos
  status:  { wch: 16 },  // columna de estado
  wide:    { wch: 48 },  // columna de texto largo (nombre de tarea)
  index:   { wch: 6  },  // columna de índice / nº
};

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Formatea un número como string de moneda legible en el Excel.
 * No se aplica formato de celda (requeriría xlsx-style), se usa string para
 * máxima compatibilidad con Excel / LibreOffice / Google Sheets.
 * @param {number} n
 * @returns {string}
 */
function formatEUR(n) {
  return new Intl.NumberFormat('es-ES', {
    style:                 'currency',
    currency:              'EUR',
    minimumFractionDigits: 2,
  }).format(n ?? 0);
}

/**
 * Genera el nombre de archivo dinámico con el nombre de la hoja y la fecha actual.
 * Sanitiza el nombre para eliminar caracteres no válidos en nombres de archivo.
 * @param {string} sheetName
 * @returns {string}  p.ej. "TaskFlow_Gastos_Enero_2025-01-15.xlsx"
 */
function buildFileName(sheetName) {
  const sanitized = sheetName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Hoja';
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `TaskFlow_${sanitized}_${date}.xlsx`;
}

/**
 * Aplica un array de anchos de columna a una worksheet.
 * @param {XLSX.WorkSheet} ws
 * @param {Array<{wch: number}>} colWidths
 */
function applyColWidths(ws, colWidths) {
  ws['!cols'] = colWidths;
}

// ─── Constructores de worksheets ──────────────────────────────────────────────

/**
 * Hoja 1: Resumen financiero de la sheet.
 *
 * Formato:
 *   | Concepto        | Valor      |
 *   | Capital inicial | € X,XX     |
 *   | Gastos totales  | € X,XX     |
 *   | Balance         | € X,XX     |
 *   | Nº de gastos    | N          |
 *   | Nº de tareas    | N          |
 *   | Completadas     | N          |
 *   | Pendientes      | N          |
 *   | Generado el     | fecha/hora |
 *
 * @param {import('../context/WorkspaceContext').Sheet} sheet
 * @returns {XLSX.WorkSheet}
 */
function buildResumenSheet(sheet) {
  const totalExpenses = sheet.expenses.reduce((acc, e) => acc + (e.amount ?? 0), 0);
  const balance       = (sheet.capital ?? 0) - totalExpenses;
  const tareasDone    = sheet.tasks.filter((t) => t.completed).length;
  const tareasPending = sheet.tasks.length - tareasDone;

  const rows = [
    { Concepto: 'Hoja',            Valor: sheet.name },
    { Concepto: '─────────────',   Valor: '─────────────' },
    { Concepto: 'Capital inicial', Valor: formatEUR(sheet.capital) },
    { Concepto: 'Gastos totales',  Valor: formatEUR(totalExpenses) },
    { Concepto: 'Balance',         Valor: formatEUR(balance) },
    { Concepto: '─────────────',   Valor: '─────────────' },
    { Concepto: 'Nº de gastos',    Valor: sheet.expenses.length },
    { Concepto: 'Nº de tareas',    Valor: sheet.tasks.length },
    { Concepto: 'Completadas',     Valor: tareasDone },
    { Concepto: 'Pendientes',      Valor: tareasPending },
    { Concepto: '─────────────',   Valor: '─────────────' },
    {
      Concepto: 'Generado el',
      Valor: new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date()),
    },
    { Concepto: 'Generado por',    Valor: 'TaskFlow Enterprise' },
  ];

  // XLSX.utils.json_to_sheet convierte el array de objetos directamente.
  // Las claves del primer objeto se usan como cabeceras de columna.
  const ws = XLSX.utils.json_to_sheet(rows);
  applyColWidths(ws, [COL_WIDTHS.label, COL_WIDTHS.value]);
  return ws;
}

/**
 * Hoja 2: Listado detallado de gastos.
 *
 * Formato:
 *   | #  | Descripción | Importe   | % del Capital |
 *   | 1  | Gasto A     | € X,XX    | X.XX%         |
 *
 * @param {import('../context/WorkspaceContext').Sheet} sheet
 * @returns {XLSX.WorkSheet}
 */
function buildGastosSheet(sheet) {
  const capital = sheet.capital ?? 0;

  if (sheet.expenses.length === 0) {
    // Hoja vacía con aviso — json_to_sheet sigue funcionando con array vacío
    const ws = XLSX.utils.json_to_sheet([
      { Mensaje: 'Esta hoja no tiene gastos registrados.' },
    ]);
    applyColWidths(ws, [COL_WIDTHS.wide]);
    return ws;
  }

  const rows = sheet.expenses.map((expense, idx) => ({
    '#':            idx + 1,
    'Descripción':  expense.desc,
    'Importe':      formatEUR(expense.amount),
    '% del Capital':
      capital > 0
        ? `${((expense.amount / capital) * 100).toFixed(2)}%`
        : 'N/A',
  }));

  // Fila de totales al final
  const totalExpenses = sheet.expenses.reduce((acc, e) => acc + (e.amount ?? 0), 0);
  rows.push({
    '#':             '─',
    'Descripción':   'TOTAL',
    'Importe':       formatEUR(totalExpenses),
    '% del Capital': capital > 0
      ? `${((totalExpenses / capital) * 100).toFixed(2)}%`
      : 'N/A',
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  applyColWidths(ws, [
    COL_WIDTHS.index,
    COL_WIDTHS.wide,
    COL_WIDTHS.value,
    COL_WIDTHS.value,
  ]);
  return ws;
}

/**
 * Hoja 3: Listado de tareas con estado.
 *
 * Formato:
 *   | #  | Tarea           | Estado     |
 *   | 1  | Tarea pendiente | Pendiente  |
 *   | 2  | Tarea hecha     | Completado |
 *
 * @param {import('../context/WorkspaceContext').Sheet} sheet
 * @returns {XLSX.WorkSheet}
 */
function buildTareasSheet(sheet) {
  if (sheet.tasks.length === 0) {
    const ws = XLSX.utils.json_to_sheet([
      { Mensaje: 'Esta hoja no tiene tareas registradas.' },
    ]);
    applyColWidths(ws, [COL_WIDTHS.wide]);
    return ws;
  }

  // Ordenar: pendientes primero, completadas al final
  const sorted = [...sheet.tasks].sort((a, b) => Number(a.completed) - Number(b.completed));

  const rows = sorted.map((task, idx) => ({
    '#':      idx + 1,
    'Tarea':  task.text,
    'Estado': task.completed ? '✓ Completado' : '○ Pendiente',
  }));

  // Fila de resumen
  const done    = sheet.tasks.filter((t) => t.completed).length;
  const pending = sheet.tasks.length - done;
  rows.push(
    { '#': '─', 'Tarea': '─────────────────', 'Estado': '─────────' },
    { '#': '',  'Tarea': `Total: ${sheet.tasks.length} tareas`, 'Estado': `${done} ✓ · ${pending} ○` },
  );

  const ws = XLSX.utils.json_to_sheet(rows);
  applyColWidths(ws, [COL_WIDTHS.index, COL_WIDTHS.wide, COL_WIDTHS.status]);
  return ws;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Exporta los datos de una Sheet a un archivo .xlsx y lo descarga en el navegador.
 *
 * Flujo:
 *   1. Validar sheetData
 *   2. Crear workbook vacío con XLSX.utils.book_new()
 *   3. Construir las tres worksheets
 *   4. Adjuntar cada worksheet al workbook con XLSX.utils.book_append_sheet()
 *   5. Descargar con XLSX.writeFile() — inyecta un <a download> y lo dispara
 *
 * @param {Object} sheetData - Objeto Sheet del WorkspaceContext
 * @param {string}   sheetData.name       - Nombre de la hoja
 * @param {number}   sheetData.capital    - Capital inicial
 * @param {Array}    sheetData.expenses   - [{id, desc, amount}]
 * @param {Array}    sheetData.tasks      - [{id, text, completed}]
 * @returns {Promise<void>}
 * @throws {Error} Si sheetData es inválido
 */
export async function exportSheetToExcel(sheetData) {
  // ── Validación de entrada ────────────────────────────────────────────────
  if (!sheetData || typeof sheetData !== 'object') {
    throw new Error('EXPORT_INVALID_DATA');
  }
  if (!Array.isArray(sheetData.expenses) || !Array.isArray(sheetData.tasks)) {
    throw new Error('EXPORT_INVALID_DATA');
  }

  // ── Construcción del workbook ────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // Hoja 1: Resumen
  const wsResumen = buildResumenSheet(sheetData);
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

  // Hoja 2: Gastos
  const wsGastos = buildGastosSheet(sheetData);
  XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

  // Hoja 3: Tareas
  const wsTareas = buildTareasSheet(sheetData);
  XLSX.utils.book_append_sheet(wb, wsTareas, 'Tareas');

  // ── Descarga ─────────────────────────────────────────────────────────────
  // XLSX.writeFile detecta el entorno browser y usa un Blob + URL.createObjectURL
  // para disparar la descarga sin pasar por el servidor.
  const fileName = buildFileName(sheetData.name);
  XLSX.writeFile(wb, fileName);
}