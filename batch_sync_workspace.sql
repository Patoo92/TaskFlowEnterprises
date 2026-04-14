-- =============================================================================
-- TaskFlow Enterprise — RPC batch_sync_workspace v2.0.0
-- DBA Senior Refactor: SECURITY INVOKER + RLS + Strict Validation + 3NF Upserts
--
-- INSTRUCCIONES:
--   Ejecutar este script completo en el SQL Editor de Supabase.
--   Requiere que las tablas workspaces, sheets, tasks, expenses existan.
--   Si no existen, el bloque CREATE TABLE al inicio las crea.
-- =============================================================================


-- =============================================================================
-- PARTE 0: DDL — Crear tablas si no existen (idempotente con IF NOT EXISTS)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.workspaces (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL DEFAULT 'Mi Workspace',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sheets (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    owner_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL DEFAULT 'Hoja',
    capital      NUMERIC     NOT NULL DEFAULT 0,
    position     INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tasks (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id    UUID        NOT NULL REFERENCES public.sheets(id) ON DELETE CASCADE,
    owner_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    text        TEXT        NOT NULL DEFAULT '',
    completed   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.expenses (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id    UUID        NOT NULL REFERENCES public.sheets(id) ON DELETE CASCADE,
    owner_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    description TEXT        NOT NULL DEFAULT '',
    amount      NUMERIC     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices de rendimiento (idempotentes)
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id    ON public.workspaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_sheets_workspace_id    ON public.sheets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sheets_owner_id        ON public.sheets(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sheet_id         ON public.tasks(sheet_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_id         ON public.tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_expenses_sheet_id      ON public.expenses(sheet_id);
CREATE INDEX IF NOT EXISTS idx_expenses_owner_id      ON public.expenses(owner_id);


-- =============================================================================
-- PARTE 1: RLS — Habilitar y definir políticas por tabla
--
-- SECURITY INVOKER (ver Parte 2) hace que las queries de la función
-- se ejecuten como el usuario autenticado → las políticas RLS aplican
-- automáticamente sin necesidad de filtros manuales WHERE owner_id = auth.uid().
-- =============================================================================

-- ── workspaces ────────────────────────────────────────────────────────────────
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas previas para evitar conflictos en re-ejecución
DROP POLICY IF EXISTS "workspace_owner_select"  ON public.workspaces;
DROP POLICY IF EXISTS "workspace_owner_insert"  ON public.workspaces;
DROP POLICY IF EXISTS "workspace_owner_update"  ON public.workspaces;
DROP POLICY IF EXISTS "workspace_owner_delete"  ON public.workspaces;

-- SELECT: solo ver los propios
CREATE POLICY "workspace_owner_select"
    ON public.workspaces FOR SELECT
    USING (owner_id = auth.uid());

-- INSERT: solo crear con tu propio owner_id
CREATE POLICY "workspace_owner_insert"
    ON public.workspaces FOR INSERT
    WITH CHECK (owner_id = auth.uid());

-- UPDATE: solo modificar los propios
CREATE POLICY "workspace_owner_update"
    ON public.workspaces FOR UPDATE
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

-- DELETE: solo eliminar los propios
CREATE POLICY "workspace_owner_delete"
    ON public.workspaces FOR DELETE
    USING (owner_id = auth.uid());


-- ── sheets ────────────────────────────────────────────────────────────────────
ALTER TABLE public.sheets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sheet_owner_select"  ON public.sheets;
DROP POLICY IF EXISTS "sheet_owner_insert"  ON public.sheets;
DROP POLICY IF EXISTS "sheet_owner_update"  ON public.sheets;
DROP POLICY IF EXISTS "sheet_owner_delete"  ON public.sheets;

CREATE POLICY "sheet_owner_select"
    ON public.sheets FOR SELECT
    USING (owner_id = auth.uid());

CREATE POLICY "sheet_owner_insert"
    ON public.sheets FOR INSERT
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "sheet_owner_update"
    ON public.sheets FOR UPDATE
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "sheet_owner_delete"
    ON public.sheets FOR DELETE
    USING (owner_id = auth.uid());


-- ── tasks ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "task_owner_select"  ON public.tasks;
DROP POLICY IF EXISTS "task_owner_insert"  ON public.tasks;
DROP POLICY IF EXISTS "task_owner_update"  ON public.tasks;
DROP POLICY IF EXISTS "task_owner_delete"  ON public.tasks;

CREATE POLICY "task_owner_select"
    ON public.tasks FOR SELECT
    USING (owner_id = auth.uid());

CREATE POLICY "task_owner_insert"
    ON public.tasks FOR INSERT
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "task_owner_update"
    ON public.tasks FOR UPDATE
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "task_owner_delete"
    ON public.tasks FOR DELETE
    USING (owner_id = auth.uid());


-- ── expenses ──────────────────────────────────────────────────────────────────
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_owner_select"  ON public.expenses;
DROP POLICY IF EXISTS "expense_owner_insert"  ON public.expenses;
DROP POLICY IF EXISTS "expense_owner_update"  ON public.expenses;
DROP POLICY IF EXISTS "expense_owner_delete"  ON public.expenses;

CREATE POLICY "expense_owner_select"
    ON public.expenses FOR SELECT
    USING (owner_id = auth.uid());

CREATE POLICY "expense_owner_insert"
    ON public.expenses FOR INSERT
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "expense_owner_update"
    ON public.expenses FOR UPDATE
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY "expense_owner_delete"
    ON public.expenses FOR DELETE
    USING (owner_id = auth.uid());


-- =============================================================================
-- PARTE 2: RPC — batch_sync_workspace v2.0.0
--
-- CAMBIOS CLAVE vs versión anterior:
--
--  [S1] SECURITY INVOKER (era SECURITY DEFINER):
--       La función ahora corre como el usuario autenticado que la llama.
--       Las políticas RLS de arriba aplican automáticamente.
--       Ya no necesitamos WHERE owner_id = v_owner_id en cada DML.
--       NOTA: si una query viola RLS, PostgreSQL lanza "permission denied"
--       en lugar de insertar silenciosamente en datos ajenos.
--
--  [V1] Validaciones estrictas con jsonb_build_object para debug cliente:
--       El cliente recibe { "code": "INVALID_WORKSPACE_ID", "detail": "…" }
--       en lugar de un mensaje crudo de PostgreSQL.
--
--  [3NF] Upserts correctos con ON CONFLICT (id):
--       - workspace_id en sheets siempre viene del parámetro canónico.
--       - Casteos explícitos: ::UUID, ::NUMERIC, ::BOOLEAN, ::INTEGER.
--       - WHERE en sheets valida que workspace_id coincida (FK integridad).
--
--  [DEL] Deletes por lote con unnest() en lugar de IN (subquery):
--       Más eficiente con arrays JSONB grandes y evita inyección de tipos.
--
--  [RET] Retorna JSONB con diagnóstico completo en lugar de VOID.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.batch_sync_workspace(
    p_workspace  JSONB,
    p_sheets     JSONB  DEFAULT '[]'::JSONB,
    p_tasks      JSONB  DEFAULT '[]'::JSONB,
    p_expenses   JSONB  DEFAULT '[]'::JSONB,
    p_deleted    JSONB  DEFAULT '{"sheet_ids":[],"task_ids":[],"expense_ids":[]}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
-- search_path vacío previene hijacking de nombres de funciones/tablas
SET search_path = ''
AS $$
DECLARE
    -- El uid del usuario autenticado que ejecuta la función.
    -- Con SECURITY INVOKER, auth.uid() devuelve el usuario real de la sesión JWT.
    v_caller_uid    UUID    := auth.uid();

    -- Workspace
    v_ws_id         UUID;
    v_ws_name       TEXT;

    -- Contadores para el diagnóstico de retorno
    v_sheets_upserted    INTEGER := 0;
    v_tasks_upserted     INTEGER := 0;
    v_expenses_upserted  INTEGER := 0;
    v_sheets_deleted     INTEGER := 0;
    v_tasks_deleted      INTEGER := 0;
    v_expenses_deleted   INTEGER := 0;
BEGIN

    -- =========================================================================
    -- BLOQUE 0: Validaciones de seguridad y entrada
    -- =========================================================================

    -- [V-01] Sesión activa obligatoria
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE   = 'PT401',
            MESSAGE   = 'UNAUTHORIZED',
            DETAIL    = 'No existe sesión de Supabase activa. Autentica antes de llamar al RPC.',
            HINT      = 'Verifica que el cliente envía el JWT de acceso en la cabecera Authorization.';
    END IF;

    -- [V-02] p_workspace no puede ser NULL ni vacío
    IF p_workspace IS NULL OR p_workspace = '{}'::JSONB THEN
        RAISE EXCEPTION USING
            ERRCODE   = 'PT400',
            MESSAGE   = 'MISSING_WORKSPACE_PAYLOAD',
            DETAIL    = 'El parámetro p_workspace es NULL o un objeto vacío.',
            HINT      = 'Asegúrate de pasar { "id": "<UUID>", "name": "…" } en p_workspace.';
    END IF;

    -- [V-03] Extraer y validar workspace id
    --   Intentamos el cast a UUID de forma segura capturando la excepción
    --   de conversión, que PostgreSQL lanza como invalid_text_representation.
    BEGIN
        v_ws_id := (p_workspace ->> 'id')::UUID;
    EXCEPTION WHEN invalid_text_representation OR SQLSTATE '22P02' THEN
        RAISE EXCEPTION USING
            ERRCODE   = 'PT400',
            MESSAGE   = 'INVALID_WORKSPACE_ID_FORMAT',
            DETAIL    = format(
                'p_workspace.id no es un UUID válido. Valor recibido: %s',
                COALESCE(p_workspace ->> 'id', 'NULL')
            ),
            HINT      = 'El campo id debe ser un UUID v4 en formato estándar (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
    END;

    IF v_ws_id IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE   = 'PT400',
            MESSAGE   = 'NULL_WORKSPACE_ID',
            DETAIL    = format(
                'p_workspace.id evaluó a NULL. Payload recibido: %s',
                p_workspace::TEXT
            ),
            HINT      = 'El campo id es obligatorio en p_workspace. No envíes undefined o null.';
    END IF;

    -- [V-04] Nombre del workspace (con fallback seguro)
    v_ws_name := NULLIF(TRIM(COALESCE(p_workspace ->> 'name', '')), '');
    IF v_ws_name IS NULL THEN
        v_ws_name := 'Mi Workspace';
    END IF;


    -- =========================================================================
    -- BLOQUE 1: Upsert del Workspace
    --
    -- Con SECURITY INVOKER + RLS:
    --   - INSERT: la política "workspace_owner_insert" valida owner_id = auth.uid()
    --   - UPDATE: la política "workspace_owner_update" impide tocar workspaces ajenos
    --
    -- ON CONFLICT (id) DO UPDATE solo actualiza si la fila existe Y pasa RLS.
    -- Si el workspace pertenece a otro usuario, la UPDATE no afecta filas
    -- (RLS filtra la fila de la cláusula WHERE implícita) → silencioso y seguro.
    -- =========================================================================

    INSERT INTO public.workspaces (id, owner_id, name, updated_at)
    VALUES (v_ws_id, v_caller_uid, v_ws_name, NOW())
    ON CONFLICT (id) DO UPDATE
        SET name       = EXCLUDED.name,
            updated_at = NOW();
    -- RLS garantiza: solo se actualiza si owner_id = auth.uid()


    -- =========================================================================
    -- BLOQUE 2: Upsert de Sheets
    --
    -- Validaciones por fila:
    --   - id: UUID válido y no nulo (filas malformadas se omiten con WHERE)
    --   - workspace_id: siempre forzado al v_ws_id canónico del parámetro
    --   - capital: NUMERIC con COALESCE a 0
    --   - position: INTEGER con COALESCE a 0
    --
    -- ON CONFLICT (id): si la sheet ya existe, actualiza solo los campos mutables.
    -- La FK workspace_id → workspaces(id) garantiza integridad referencial.
    -- =========================================================================

    WITH sheet_input AS (
        SELECT
            (s ->> 'id')::UUID                                AS id,
            v_ws_id                                           AS workspace_id,
            v_caller_uid                                      AS owner_id,
            NULLIF(TRIM(COALESCE(s ->> 'name', '')), '')      AS name,
            COALESCE((s ->> 'capital')::NUMERIC,   0)         AS capital,
            COALESCE((s ->> 'position')::INTEGER,  0)         AS position
        FROM jsonb_array_elements(p_sheets) AS s
        -- Omitir filas con id nulo o name vacío (defensa ante payloads corruptos)
        WHERE (s ->> 'id') IS NOT NULL
          AND (s ->> 'id') <> ''
          AND NULLIF(TRIM(COALESCE(s ->> 'name', '')), '') IS NOT NULL
    ),
    upserted AS (
        INSERT INTO public.sheets
            (id, workspace_id, owner_id, name, capital, position, updated_at)
        SELECT id, workspace_id, owner_id, name, capital, position, NOW()
        FROM sheet_input
        ON CONFLICT (id) DO UPDATE
            SET name         = EXCLUDED.name,
                capital      = EXCLUDED.capital,
                position     = EXCLUDED.position,
                updated_at   = NOW()
        -- Nota: workspace_id no se actualiza en conflicto para preservar FK.
        -- Si necesitas mover una sheet de workspace, usa una mutación explícita.
        RETURNING id
    )
    SELECT COUNT(*) INTO v_sheets_upserted FROM upserted;


    -- =========================================================================
    -- BLOQUE 3: Upsert de Tasks
    --
    -- Validaciones por fila:
    --   - id y sheet_id deben ser UUID válidos
    --   - completed: BOOLEAN con COALESCE a FALSE
    --   - text: COALESCE a ''
    --
    -- La FK sheet_id → sheets(id) + RLS de sheets garantiza que solo se
    -- insertan tasks en sheets que el usuario posee.
    -- =========================================================================

    WITH task_input AS (
        SELECT
            (t ->> 'id')::UUID                                          AS id,
            (t ->> 'sheet_id')::UUID                                    AS sheet_id,
            v_caller_uid                                                AS owner_id,
            COALESCE(t ->> 'text', '')                                  AS text,
            COALESCE((t ->> 'completed')::BOOLEAN, FALSE)               AS completed
        FROM jsonb_array_elements(p_tasks) AS t
        WHERE (t ->> 'id')       IS NOT NULL AND (t ->> 'id')       <> ''
          AND (t ->> 'sheet_id') IS NOT NULL AND (t ->> 'sheet_id') <> ''
    ),
    upserted AS (
        INSERT INTO public.tasks
            (id, sheet_id, owner_id, text, completed, updated_at)
        SELECT id, sheet_id, owner_id, text, completed, NOW()
        FROM task_input
        ON CONFLICT (id) DO UPDATE
            SET text       = EXCLUDED.text,
                completed  = EXCLUDED.completed,
                updated_at = NOW()
        RETURNING id
    )
    SELECT COUNT(*) INTO v_tasks_upserted FROM upserted;


    -- =========================================================================
    -- BLOQUE 4: Upsert de Expenses
    --
    -- Validaciones por fila:
    --   - id y sheet_id: UUID válidos
    --   - amount: NUMERIC con COALESCE a 0, protegido contra NaN/Inf via CASE
    --   - description: COALESCE a ''
    -- =========================================================================

    WITH expense_input AS (
        SELECT
            (e ->> 'id')::UUID                                          AS id,
            (e ->> 'sheet_id')::UUID                                    AS sheet_id,
            v_caller_uid                                                AS owner_id,
            COALESCE(e ->> 'description', '')                           AS description,
            -- Protección extra: si el string no es numérico válido, usar 0
            CASE
                WHEN (e ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN (e ->> 'amount')::NUMERIC
                ELSE 0
            END                                                         AS amount
        FROM jsonb_array_elements(p_expenses) AS e
        WHERE (e ->> 'id')       IS NOT NULL AND (e ->> 'id')       <> ''
          AND (e ->> 'sheet_id') IS NOT NULL AND (e ->> 'sheet_id') <> ''
    ),
    upserted AS (
        INSERT INTO public.expenses
            (id, sheet_id, owner_id, description, amount, updated_at)
        SELECT id, sheet_id, owner_id, description, amount, NOW()
        FROM expense_input
        ON CONFLICT (id) DO UPDATE
            SET description = EXCLUDED.description,
                amount      = EXCLUDED.amount,
                updated_at  = NOW()
        RETURNING id
    )
    SELECT COUNT(*) INTO v_expenses_upserted FROM upserted;


    -- =========================================================================
    -- BLOQUE 5: Deletes (operados solo sobre registros propios via RLS)
    --
    -- unnest() sobre el array JSONB es más eficiente que jsonb_array_elements
    -- cuando el set es grande, y evita subqueries correlacionadas.
    --
    -- IMPORTANTE: Las FK ON DELETE CASCADE en la DDL se encargan de eliminar
    -- las tasks/expenses cuando se elimina una sheet. Sin embargo, enviamos
    -- los deletes de hijos explícitamente por si en el futuro se cambia el CASCADE.
    --
    -- El DELETE de sheet_ids va al FINAL para garantizar que primero se
    -- procesaron los deletes de hijos (tasks, expenses) y no hay FK violation
    -- si se desactiva el CASCADE.
    -- =========================================================================

    -- DELETE expenses
    WITH del_expense_ids AS (
        SELECT (e)::UUID AS id
        FROM jsonb_array_elements_text(
            COALESCE(p_deleted -> 'expense_ids', '[]'::JSONB)
        ) AS e
        WHERE e IS NOT NULL AND e <> ''
    ),
    deleted AS (
        DELETE FROM public.expenses
        WHERE id = ANY(SELECT id FROM del_expense_ids)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_expenses_deleted FROM deleted;

    -- DELETE tasks
    WITH del_task_ids AS (
        SELECT (t)::UUID AS id
        FROM jsonb_array_elements_text(
            COALESCE(p_deleted -> 'task_ids', '[]'::JSONB)
        ) AS t
        WHERE t IS NOT NULL AND t <> ''
    ),
    deleted AS (
        DELETE FROM public.tasks
        WHERE id = ANY(SELECT id FROM del_task_ids)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_tasks_deleted FROM deleted;

    -- DELETE sheets (al final — CASCADE elimina hijos restantes)
    WITH del_sheet_ids AS (
        SELECT (s)::UUID AS id
        FROM jsonb_array_elements_text(
            COALESCE(p_deleted -> 'sheet_ids', '[]'::JSONB)
        ) AS s
        WHERE s IS NOT NULL AND s <> ''
    ),
    deleted AS (
        DELETE FROM public.sheets
        WHERE id = ANY(SELECT id FROM del_sheet_ids)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_sheets_deleted FROM deleted;


    -- =========================================================================
    -- RETORNO: JSONB de diagnóstico
    --
    -- El cliente puede inspeccionar cuántas filas se procesaron para validar
    -- que el batch llegó completo. Si un contador es menor al esperado,
    -- significa que algunas filas fallaron silenciosamente la validación.
    -- =========================================================================

    RETURN jsonb_build_object(
        'success',            TRUE,
        'workspace_id',       v_ws_id,
        'processed_at',       NOW(),
        'upserted', jsonb_build_object(
            'sheets',   v_sheets_upserted,
            'tasks',    v_tasks_upserted,
            'expenses', v_expenses_upserted
        ),
        'deleted', jsonb_build_object(
            'sheets',   v_sheets_deleted,
            'tasks',    v_tasks_deleted,
            'expenses', v_expenses_deleted
        )
    );

EXCEPTION
    -- Re-raise con contexto adicional para diagnóstico desde el cliente.
    -- El cliente recibirá el message + detail en el campo error.message de Supabase.
    WHEN OTHERS THEN
        RAISE EXCEPTION USING
            ERRCODE = SQLSTATE,
            MESSAGE = format('batch_sync_workspace falló: %s', SQLERRM),
            DETAIL  = format(
                'SQLSTATE: %s | workspace_id: %s | caller: %s',
                SQLSTATE,
                COALESCE(v_ws_id::TEXT, 'no resuelto'),
                COALESCE(v_caller_uid::TEXT, 'no autenticado')
            );
END;
$$;


-- =============================================================================
-- PARTE 3: RPC — fetch_workspace_delta v2.0.0
--
-- Descarga las entidades modificadas desde p_since (ISO timestamp).
-- Si p_since IS NULL → snapshot completo (hydration inicial).
--
-- SECURITY INVOKER: RLS filtra automáticamente por owner_id = auth.uid().
-- No necesita parámetro supabaseUid — auth.uid() lo provee el JWT.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fetch_workspace_delta(
    p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_caller_uid UUID := auth.uid();
    v_since      TIMESTAMPTZ := COALESCE(p_since, '1970-01-01T00:00:00Z'::TIMESTAMPTZ);
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PT401',
            MESSAGE = 'UNAUTHORIZED',
            DETAIL  = 'No existe sesión activa.';
    END IF;

    RETURN jsonb_build_object(
        'fetched_at', NOW(),
        'since',      v_since,

        'workspaces', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',         w.id,
                    'name',       w.name,
                    'owner_id',   w.owner_id,
                    'updated_at', w.updated_at
                )
            ), '[]'::JSONB)
            FROM public.workspaces w
            WHERE w.owner_id   = v_caller_uid
              AND w.updated_at > v_since
        ),

        'sheets', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',           s.id,
                    'workspace_id', s.workspace_id,
                    'owner_id',     s.owner_id,
                    'name',         s.name,
                    'capital',      s.capital,
                    'position',     s.position,
                    'updated_at',   s.updated_at
                )
            ), '[]'::JSONB)
            FROM public.sheets s
            WHERE s.owner_id   = v_caller_uid
              AND s.updated_at > v_since
        ),

        'tasks', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',         t.id,
                    'sheet_id',   t.sheet_id,
                    'owner_id',   t.owner_id,
                    'text',       t.text,
                    'completed',  t.completed,
                    'updated_at', t.updated_at
                )
            ), '[]'::JSONB)
            FROM public.tasks t
            WHERE t.owner_id   = v_caller_uid
              AND t.updated_at > v_since
        ),

        'expenses', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',          e.id,
                    'sheet_id',    e.sheet_id,
                    'owner_id',    e.owner_id,
                    'description', e.description,
                    'amount',      e.amount,
                    'updated_at',  e.updated_at
                )
            ), '[]'::JSONB)
            FROM public.expenses e
            WHERE e.owner_id   = v_caller_uid
              AND e.updated_at > v_since
        )
    );
END;
$$;


-- =============================================================================
-- PARTE 4: Permisos de ejecución
--
-- Con SECURITY INVOKER NO concedemos EXECUTE a PUBLIC (todos los usuarios).
-- Solo los usuarios autenticados (rol 'authenticated' de Supabase) pueden
-- llamar a las funciones. Los anónimos (rol 'anon') quedan bloqueados.
-- =============================================================================

-- Revocar acceso público (previene llamadas anónimas sin JWT)
REVOKE ALL ON FUNCTION public.batch_sync_workspace(JSONB, JSONB, JSONB, JSONB, JSONB)
    FROM PUBLIC;

REVOKE ALL ON FUNCTION public.fetch_workspace_delta(TIMESTAMPTZ)
    FROM PUBLIC;

-- Conceder solo a usuarios autenticados
GRANT EXECUTE ON FUNCTION public.batch_sync_workspace(JSONB, JSONB, JSONB, JSONB, JSONB)
    TO authenticated;

GRANT EXECUTE ON FUNCTION public.fetch_workspace_delta(TIMESTAMPTZ)
    TO authenticated;


-- =============================================================================
-- PARTE 5: Verificación post-instalación
--
-- Ejecuta este SELECT para confirmar que todo quedó correctamente configurado.
-- Deberías ver 4 filas con rls_enabled = true y al menos 4 políticas por tabla.
-- =============================================================================

SELECT
    c.relname                                          AS tabla,
    c.relrowsecurity                                   AS rls_enabled,
    COUNT(p.polname)                                   AS num_politicas,
    STRING_AGG(p.polname, ', ' ORDER BY p.polname)     AS politicas
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname IN ('workspaces', 'sheets', 'tasks', 'expenses')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
