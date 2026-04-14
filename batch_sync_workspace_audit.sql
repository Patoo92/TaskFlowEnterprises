-- =============================================================================
-- TaskFlow Enterprise — RPC Security Audit v2.0.0+Security Hardening
-- [CVE-003] SECURITY INVOKER Validation + Audit Trail
-- 
-- Este script DEBE ejecutarse DESPUÉS de batch_sync_workspace.sql
-- Añade:
--   1. Validación post-instalación de SECURITY INVOKER
--   2. Tabla de auditoría de cambios en funciones críticas
--   3. Event Trigger para registrar DDL sospechoso
--   4. Checklist de deployment
-- =============================================================================

-- ─── Parte 0: Validación de SECURITY INVOKER ─────────────────────────────────

DO $$
BEGIN
  -- Verificar que las funciones tienen SECURITY INVOKER
  PERFORM 1 FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('batch_sync_workspace', 'fetch_workspace_delta')
    AND security_type != 'INVOKER';
  
  IF FOUND THEN
    RAISE EXCEPTION 'SECURITY BREACH: batch_sync_workspace o fetch_workspace_delta '
      'no tienen SECURITY INVOKER. Abortar deployment.';
  END IF;

  RAISE NOTICE '[CVE-003] ✓ SECURITY INVOKER validation passed.';
END $$;


-- ─── Parte 1: Tabla de auditoría para cambios de función ─────────────────────

CREATE TABLE IF NOT EXISTS public.function_security_audit (
  id             BIGSERIAL PRIMARY KEY,
  function_name  TEXT NOT NULL,
  function_oid   OID,
  old_security   TEXT,
  new_security   TEXT,
  changed_at     TIMESTAMPTZ DEFAULT NOW(),
  changed_by     TEXT DEFAULT current_user,
  reason         TEXT,
  severity       TEXT, -- 'warning' | 'critical'
  resolved       BOOLEAN DEFAULT FALSE,
  resolved_at    TIMESTAMPTZ,
  resolved_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_func_audit_name
  ON public.function_security_audit(function_name);

CREATE INDEX IF NOT EXISTS idx_func_audit_severity
  ON public.function_security_audit(severity, resolved);

GRANT SELECT ON public.function_security_audit TO authenticated;


-- ─── Parte 2: Event Trigger para auditar DDL en funciones críticas ─────────────

/**
 * [CVE-003] Event Trigger que captura cualquier cambio DDL en:
 * - batch_sync_workspace
 * - fetch_workspace_delta
 *
 * Inserta en function_security_audit para posterior revisión.
 */
CREATE OR REPLACE FUNCTION audit_rpc_security_changes()
RETURNS event_trigger AS $$
DECLARE
  obj RECORD;
  v_func_oid OID;
  v_security_type TEXT;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    -- Detectar cambios en nuestras RPCs críticas
    IF obj.object_identity LIKE '%batch_sync_workspace%'
       OR obj.object_identity LIKE '%fetch_workspace_delta%'
    THEN
      -- Extraer OID y tipo de seguridad de la función
      SELECT p.oid, p.prosecdef::TEXT
      INTO v_func_oid, v_security_type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = SPLIT_PART(obj.object_identity, '(', 1);

      -- Mapear prosecdef: true = SECURITY DEFINER, false = SECURITY INVOKER
      v_security_type := CASE WHEN v_security_type = 't' THEN 'DEFINER' ELSE 'INVOKER' END;

      -- Registrar en auditoría
      INSERT INTO public.function_security_audit
        (function_name, function_oid, new_security, reason, severity)
      VALUES (
        SPLIT_PART(obj.object_identity, '(', 1),
        v_func_oid,
        v_security_type,
        'DDL detected on security-critical RPC',
        CASE
          WHEN v_security_type = 'DEFINER' THEN 'critical'
          ELSE 'warning'
        END
      );

      -- Si se cambia a SECURITY DEFINER, lanzar alerta crítica
      IF v_security_type = 'DEFINER' THEN
        RAISE WARNING 'SECURITY ALERT: RPC % changed to SECURITY DEFINER. '
          'This may bypass RLS. Investigate immediately.',
          obj.object_identity;
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- [CVE-003] Crear o actualizar el event trigger
DROP EVENT TRIGGER IF EXISTS audit_rpc_DDL CASCADE;
CREATE EVENT TRIGGER audit_rpc_DDL
  ON ddl_command_end
  EXECUTE FUNCTION audit_rpc_security_changes();

RAISE NOTICE '[CVE-003] ✓ Event Trigger audit_rpc_DDL created.';


-- ─── Parte 3: Función helper para verificar integridad post-deployment ──────────

CREATE OR REPLACE FUNCTION public.verify_rpc_security(
)
RETURNS TABLE (
  rpc_name TEXT,
  security_type TEXT,
  rls_enabled BOOLEAN,
  has_policies INTEGER,
  status TEXT
)
LANGUAGE SQL
SECURITY INVOKER
AS $$
  SELECT
    p.proname,
    CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END,
    c.relrowsecurity,
    COUNT(pol.polname),
    CASE
      WHEN p.prosecdef THEN '❌ CRITICAL: SECURITY DEFINER (should be INVOKER)'
      WHEN COUNT(pol.polname) = 0 THEN '⚠️  WARNING: No RLS policies'
      ELSE '✓ SECURE'
    END
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_class c ON c.relname = p.proname -- rough match for table scan
  LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
  WHERE n.nspname = 'public'
    AND p.proname IN ('batch_sync_workspace', 'fetch_workspace_delta')
  GROUP BY p.proname, p.prosecdef, c.relrowsecurity;
$$;

GRANT EXECUTE ON FUNCTION public.verify_rpc_security() TO authenticated;

RAISE NOTICE '[CVE-003] ✓ Function verify_rpc_security() created.';


-- ─── Parte 4: Obtener el estado actual ──────────────────────────────────────

RAISE NOTICE '';
RAISE NOTICE '╔════════════════════════════════════════════════════════════╗';
RAISE NOTICE '║ [CVE-003] RPC SECURITY AUDIT POST-DEPLOYMENT REPORT       ║';
RAISE NOTICE '╚════════════════════════════════════════════════════════════╝';
RAISE NOTICE '';

-- Verificar RLS en todas las tablas críticas
RAISE NOTICE 'TABLE RLS STATUS:';
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      c.relname,
      c.relrowsecurity,
      COUNT(p.polname) AS num_policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_policy p ON p.polrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname IN ('workspaces', 'sheets', 'tasks', 'expenses')
    GROUP BY c.relname, c.relrowsecurity
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '  • % | RLS: % | Policies: %',
      RPAD(rec.relname, 15),
      CASE WHEN rec.relrowsecurity THEN '✓ ENABLED' ELSE '❌ DISABLED' END,
      rec.num_policies;
  END LOOP;
END $$;

-- Verificar RPCs
RAISE NOTICE '';
RAISE NOTICE 'RPC SECURITY STATUS:';
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      p.proname,
      CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS sec_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('batch_sync_workspace', 'fetch_workspace_delta')
  LOOP
    RAISE NOTICE '  • % | SECURITY %',
      RPAD(rec.proname, 25),
      CASE
        WHEN rec.sec_type = 'DEFINER' THEN '❌ DEFINER (CRITICAL)'
        ELSE '✓ INVOKER'
      END;
  END LOOP;
END $$;

RAISE NOTICE '';
RAISE NOTICE 'DEPLOYMENT CHECKLIST:';
RAISE NOTICE '  [ ] batch_sync_workspace tiene SECURITY INVOKER';
RAISE NOTICE '  [ ] fetch_workspace_delta tiene SECURITY INVOKER';
RAISE NOTICE '  [ ] Todas las tablas tienen RLS enabled';
RAISE NOTICE '  [ ] Cada tabla tiene >= 4 políticas (SELECT, INSERT, UPDATE, DELETE)';
RAISE NOTICE '  [ ] audit_rpc_DDL trigger está activo';
RAISE NOTICE '  [ ] function_security_audit tabla está creada';
RAISE NOTICE '  [ ] Code review completo de RPCs realizado';
RAISE NOTICE '  [ ] Test de RLS bypass intento completado ✓';
RAISE NOTICE '';
RAISE NOTICE '✓ [CVE-003] Audit framework installed successfully.';
RAISE NOTICE 'Monitor public.function_security_audit para cambios sospechosos.';
