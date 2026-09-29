ALTER TABLE workspace_notification ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_notification FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON workspace_notification USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON workspace_notification TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON workspace_notification FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE workspace_notification ADD CONSTRAINT workspace_notification_href_check CHECK (href ~ '^/[^/]');
--> statement-breakpoint

-- Agenda / disponibilidad (slice Agenda): RLS por tenant y privilegios del
-- rol app para las tablas nuevas. El padre fusiona esto en la migración
-- conjunta generada desde packages/db/src/schema/availability.ts.
-- Orden de purga en seed-dev (antes de los padres appointment/patient/
-- contact/branch): waitlist_entry → schedule_block → professional_schedule.

ALTER TABLE "professional_schedule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "professional_schedule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "professional_schedule"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "schedule_block" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_block" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "schedule_block"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "waitlist_entry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "waitlist_entry"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Configuración reemplaza turnos y elimina bloqueos; la espera se cancela por
-- estado (nunca DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON "professional_schedule" TO dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "schedule_block" TO dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "waitlist_entry" TO dentalagent_app;
--> statement-breakpoint

-- Idempotencia de propuestas y de avisos (dedupeKey la gestiona workspaceNotification del padre).
CREATE UNIQUE INDEX IF NOT EXISTS agent_proposal_org_key_uidx
  ON agent_proposal (organization_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_revision_entry_version_uidx
  ON agent_knowledge_revision (entry_id, version);
--> statement-breakpoint

-- Automatizaciones: RLS por tenant + permisos del rol app.
-- El padre genera la migración conjunta; este archivo lista las sentencias
-- adicionales que esa migración debe incluir (drizzle no declara RLS).

ALTER TABLE "automation_rule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "automation_rule"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "automation_job" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "automation_job"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "automation_consent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "automation_consent"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "automation_link_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "automation_link_token"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "automation_rule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_job" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_consent" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_link_token" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON
  "automation_rule", "automation_job", "automation_consent", "automation_link_token"
  TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON
  "automation_rule", "automation_job", "automation_consent", "automation_link_token"
  FROM dentalagent_app;
--> statement-breakpoint

-- Nota: la semilla usa DELETE defensivo sobre automation_job con rol owner
-- (bypasea RLS); el rol app nunca borra: cancela/omite por estado.

-- Despertador durable del tick (pg_cron activo en infra): un único job por
-- minuto que encola wake-up sin PII en pgmq 'automation_ticks'. El worker
-- drena (coalescing) y ejecuta un solo tick con la hora de la DB. No se
-- programa cada envío en cron: los trabajos viven en automation_job.
DO $$ BEGIN PERFORM pgmq.create('automation_ticks'); EXCEPTION WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'automation-tick';
  PERFORM cron.schedule('automation-tick', '* * * * *', $job$SELECT pgmq.send('automation_ticks', '{}'::jsonb)$job$);
END $$;
--> statement-breakpoint

-- Restricciones SQL del dominio especialidades/formularios/consentimientos/órdenes.
-- El padre genera la migración Drizzle conjunta con todos los schemas; este
-- archivo declara el RLS, los grants del rol app y la inmutabilidad a nivel DB
-- (triggers condicionados, misma convención que el resto clínico: el servicio
-- ya lo garantiza y la DB lo blinda; el purge del seed por rol owner hace
-- DELETE directos y no toca estos triggers de UPDATE).
-- Convención: aislamiento por tenant vía app.org_id, igual que el resto clínico.

-- RLS por tenant en las 10 tablas (todas llevan organization_id).
ALTER TABLE "org_specialty" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org_specialty" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_specialty"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "professional_specialty" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "professional_specialty" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "professional_specialty"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "service_specialty" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_specialty" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "service_specialty"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "clinical_form_template" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_form_template" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "clinical_form_template"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "clinical_form_response" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_form_response" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "clinical_form_response"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "clinical_form_addendum" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "clinical_form_addendum"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "consent_template" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_template" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "consent_template"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "consent_document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "consent_document"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "consent_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consent_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "consent_event"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "clinical_order" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinical_order" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "clinical_order"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

-- Grants del rol app: CRUD de configuración y captura; SIN DELETE salvo
-- vínculos de asignación (professional_specialty, service_specialty), que el
-- servicio reescribe por completo al reasignar.
GRANT SELECT, INSERT, UPDATE ON
  "org_specialty",
  "clinical_form_template",
  "clinical_form_response",
  "consent_template",
  "consent_document",
  "clinical_order"
  TO dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "professional_specialty",
  "service_specialty"
  TO dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "clinical_form_addendum", "consent_event" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON
  "org_specialty",
  "clinical_form_template",
  "clinical_form_response",
  "clinical_form_addendum",
  "consent_template",
  "consent_document",
  "consent_event",
  "clinical_order"
  FROM dentalagent_app;
--> statement-breakpoint

-- Append-only reforzado: la historia y las adendas no se mutan.
REVOKE UPDATE, DELETE ON "clinical_form_addendum", "consent_event" FROM dentalagent_app;
--> statement-breakpoint

-- Inmutabilidad de versiones publicadas: una fila publicada/archivada nunca
-- se edita (las versiones nuevas son INSERT). Solo se permite el retiro
-- publicado → archivado sin tocar el contenido congelado.
CREATE OR REPLACE FUNCTION clinical_forms_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
      AND NEW.specialty_id IS NOT DISTINCT FROM OLD.specialty_id
      AND NEW.key IS NOT DISTINCT FROM OLD.key
      AND NEW.title IS NOT DISTINCT FROM OLD.title
      AND NEW.description IS NOT DISTINCT FROM OLD.description
      AND NEW.version IS NOT DISTINCT FROM OLD.version
      AND NEW.schema IS NOT DISTINCT FROM OLD.schema
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Plantilla publicada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Plantilla archivada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clinical_form_template_immutable ON "clinical_form_template";
--> statement-breakpoint
CREATE TRIGGER clinical_form_template_immutable
  BEFORE UPDATE ON "clinical_form_template"
  FOR EACH ROW EXECUTE FUNCTION clinical_forms_template_immutable();
--> statement-breakpoint

-- consent_template.body ocupa el lugar de clinical_form_template.schema.
CREATE OR REPLACE FUNCTION clinical_forms_consent_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
      AND NEW.specialty_id IS NOT DISTINCT FROM OLD.specialty_id
      AND NEW.key IS NOT DISTINCT FROM OLD.key
      AND NEW.title IS NOT DISTINCT FROM OLD.title
      AND NEW.body IS NOT DISTINCT FROM OLD.body
      AND NEW.version IS NOT DISTINCT FROM OLD.version
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento publicado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Consentimiento archivado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS consent_template_immutable ON "consent_template";
--> statement-breakpoint
CREATE TRIGGER consent_template_immutable
  BEFORE UPDATE ON "consent_template"
  FOR EACH ROW EXECUTE FUNCTION clinical_forms_consent_template_immutable();
--> statement-breakpoint

-- Respuesta finalizada inmutable: las correcciones son adendas (INSERT en
-- clinical_form_addendum), nunca UPDATE.
CREATE OR REPLACE FUNCTION clinical_forms_response_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalizado' THEN
    RAISE EXCEPTION 'Formulario finalizado inmutable (usar adenda) (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clinical_form_response_immutable ON "clinical_form_response";
--> statement-breakpoint
CREATE TRIGGER clinical_form_response_immutable
  BEFORE UPDATE ON "clinical_form_response"
  FOR EACH ROW EXECUTE FUNCTION clinical_forms_response_immutable();
--> statement-breakpoint

-- Consentimiento firmado inmutable salvo revocación: solo permite
-- firmado → revocado con motivo, sin alterar snapshot, contenido ni firma.
CREATE OR REPLACE FUNCTION clinical_forms_consent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'firmado' THEN
    IF NEW.status = 'revocado'
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
      AND NEW.template_id IS NOT DISTINCT FROM OLD.template_id
      AND NEW.template_version IS NOT DISTINCT FROM OLD.template_version
      AND NEW.body_snapshot IS NOT DISTINCT FROM OLD.body_snapshot
      AND NEW.title_snapshot IS NOT DISTINCT FROM OLD.title_snapshot
      AND NEW.patient_id IS NOT DISTINCT FROM OLD.patient_id
      AND NEW.encounter_id IS NOT DISTINCT FROM OLD.encounter_id
      AND NEW.plan_item_id IS NOT DISTINCT FROM OLD.plan_item_id
      AND NEW.procedure_ref IS NOT DISTINCT FROM OLD.procedure_ref
      AND NEW.signer_kind IS NOT DISTINCT FROM OLD.signer_kind
      AND NEW.signer_name IS NOT DISTINCT FROM OLD.signer_name
      AND NEW.signer_doc IS NOT DISTINCT FROM OLD.signer_doc
      AND NEW.representative_relation IS NOT DISTINCT FROM OLD.representative_relation
      AND NEW.signature_data IS NOT DISTINCT FROM OLD.signature_data
      AND NEW.signed_at IS NOT DISTINCT FROM OLD.signed_at
      AND NEW.author_user_id IS NOT DISTINCT FROM OLD.author_user_id
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento firmado inmutable (solo revocación) (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'revocado' THEN
    RAISE EXCEPTION 'Consentimiento revocado inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS consent_document_immutable ON "consent_document";
--> statement-breakpoint
CREATE TRIGGER consent_document_immutable
  BEFORE UPDATE ON "consent_document"
  FOR EACH ROW EXECUTE FUNCTION clinical_forms_consent_immutable();
--> statement-breakpoint

-- Invariantes financieras de Finance para la migración conjunta del padre.
-- Sin ADD COLUMN: el esquema generado ya contiene electronic_cents y
-- source_key/voided de commission_settlement_line. El padre añade RLS FORCE,
-- grants SELECT/INSERT/UPDATE y REVOKE DELETE en las 8 tablas; estos triggers
-- blindan además a nivel de fila que las actualizaciones sean solo las
-- acotadas (cierre, anulación, recálculo) y que nada se borre ni reabra.

-- FK diferida: cash_movement.expense_id → expense.id (expense se declara
-- después de cash_movement en el esquema y se evita el ciclo en código).
ALTER TABLE cash_movement
  ADD CONSTRAINT cash_movement_expense_fk
  FOREIGN KEY (expense_id) REFERENCES expense (id);
--> statement-breakpoint

-- El runtime no borra; el rol owner conserva el mantenimiento de datos semilla.
CREATE OR REPLACE FUNCTION finance_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finance: % no admite borrado, solo anulación', TG_TABLE_NAME;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Solo las columnas de TG_ARGV pueden cambiar; el resto es inmutable.
CREATE OR REPLACE FUNCTION finance_allow_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := TG_ARGV;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance: % no admite borrado, solo anulación', TG_TABLE_NAME;
  END IF;
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = TG_TABLE_NAME
  LOOP
    IF NOT (col = ANY (allowed)) THEN
      IF (row_to_json(OLD)->>col) IS DISTINCT FROM (row_to_json(NEW)->>col) THEN
        RAISE EXCEPTION 'finance: % es inmutable (%)', TG_TABLE_NAME, col;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Cierre una sola vez y turno cerrado inmutable (además del lock de servicio).
CREATE OR REPLACE FUNCTION finance_cash_shift_close() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cerrada' THEN
    RAISE EXCEPTION 'finance: turno cerrado inmutable';
  END IF;
  IF NEW.status <> 'cerrada' THEN
    RAISE EXCEPTION 'finance: el turno solo pasa a cerrada';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS cash_shift_no_delete ON cash_shift;
--> statement-breakpoint
CREATE TRIGGER cash_shift_no_delete BEFORE DELETE ON cash_shift
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_shift_close_once ON cash_shift;
--> statement-breakpoint
CREATE TRIGGER cash_shift_close_once BEFORE UPDATE ON cash_shift
  FOR EACH ROW EXECUTE FUNCTION finance_cash_shift_close();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_shift_immutable ON cash_shift;
--> statement-breakpoint
CREATE TRIGGER cash_shift_immutable BEFORE UPDATE ON cash_shift
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'status', 'closed_by', 'closed_at', 'expected_cents', 'electronic_cents',
    'counted_cents', 'difference_cents', 'close_notes');
--> statement-breakpoint

-- Movimientos: solo anulación; el resto (importe, dirección, turno, enlaces) fijo.
DROP TRIGGER IF EXISTS cash_movement_no_delete ON cash_movement;
--> statement-breakpoint
CREATE TRIGGER cash_movement_no_delete BEFORE DELETE ON cash_movement
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_movement_immutable ON cash_movement;
--> statement-breakpoint
CREATE TRIGGER cash_movement_immutable BEFORE UPDATE ON cash_movement
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at', 'voided_by', 'void_reason');
--> statement-breakpoint

-- Gastos: solo anulación.
DROP TRIGGER IF EXISTS expense_no_delete ON expense;
--> statement-breakpoint
CREATE TRIGGER expense_no_delete BEFORE DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_immutable ON expense;
--> statement-breakpoint
CREATE TRIGGER expense_immutable BEFORE UPDATE ON expense
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'voided_at', 'voided_by', 'void_reason', 'updated_at');
--> statement-breakpoint

-- Planes: el servicio recalcula estado y anula; el cargo/total/cuotas/moneda fijos.
DROP TRIGGER IF EXISTS installment_plan_no_delete ON installment_plan;
--> statement-breakpoint
CREATE TRIGGER installment_plan_no_delete BEFORE DELETE ON installment_plan
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS installment_plan_immutable ON installment_plan;
--> statement-breakpoint
CREATE TRIGGER installment_plan_immutable BEFORE UPDATE ON installment_plan
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'status', 'voided_at', 'voided_by', 'void_reason', 'updated_at');
--> statement-breakpoint

-- Cuotas: solo recálculo de avance (pagado/estado/fecha); plan y montos fijos.
DROP TRIGGER IF EXISTS installment_quota_no_delete ON installment_quota;
--> statement-breakpoint
CREATE TRIGGER installment_quota_no_delete BEFORE DELETE ON installment_quota
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS installment_quota_immutable ON installment_quota;
--> statement-breakpoint
CREATE TRIGGER installment_quota_immutable BEFORE UPDATE ON installment_quota
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'paid_cents', 'status', 'paid_at', 'updated_at');
--> statement-breakpoint

-- Reglas: tasa, vigencia y activo versionan; profesional/base/origen fijos.
DROP TRIGGER IF EXISTS commission_rule_no_delete ON commission_rule;
--> statement-breakpoint
CREATE TRIGGER commission_rule_no_delete BEFORE DELETE ON commission_rule
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_rule_immutable ON commission_rule;
--> statement-breakpoint
CREATE TRIGGER commission_rule_immutable BEFORE UPDATE ON commission_rule
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'rate_bps', 'is_active', 'valid_from', 'valid_to', 'updated_at');
--> statement-breakpoint

-- Liquidaciones y líneas: solo anulación conjunta (las líneas liberan fuentes).
DROP TRIGGER IF EXISTS commission_settlement_no_delete ON commission_settlement;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_no_delete BEFORE DELETE ON commission_settlement
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_settlement_immutable ON commission_settlement;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_immutable BEFORE UPDATE ON commission_settlement
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only(
    'status', 'voided_at', 'voided_by', 'void_reason', 'updated_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_settlement_line_no_delete ON commission_settlement_line;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_no_delete BEFORE DELETE ON commission_settlement_line
  FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_settlement_line_immutable ON commission_settlement_line;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_immutable BEFORE UPDATE ON commission_settlement_line
  FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at', 'voided_by', 'void_reason');
--> statement-breakpoint

-- Inventario: aislamiento por tenant, ledger inmutable y no-negativos.
-- El padre genera la migración Drizzle desde packages/db/src/schema/inventory.ts;
-- este archivo aporta lo que Drizzle no expresa: RLS, grants y revocaciones.
-- Tablas: supplier, warehouse, product, purchase_order, purchase_order_line,
-- product_lot, stock_movement. Todas con organization_id NOT NULL.

-- RLS: aislamiento por tenant (mismo patrón que agenda 0024).
ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "supplier"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "warehouse" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "warehouse" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "warehouse"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "product"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "purchase_order" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "purchase_order" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "purchase_order"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "purchase_order_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "purchase_order_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "purchase_order_line"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "product_lot" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product_lot" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "product_lot"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "stock_movement"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

-- Grants de aplicación.
GRANT SELECT, INSERT, UPDATE ON
  "supplier", "warehouse", "product", "purchase_order",
  "purchase_order_line", "product_lot"
  TO dentalagent_app;
--> statement-breakpoint

-- Ledger inmutable: el rol app inserta y lee, NUNCA edita ni borra.
-- Las correcciones son movimientos inversos de ajuste con su motivo.
GRANT SELECT, INSERT ON "stock_movement" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "stock_movement" FROM dentalagent_app;
--> statement-breakpoint

-- Reglas de dominio que el servicio ya valida (defensa en profundidad):
-- 1. El traslado exige almacén destino distinto del origen.
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_transfer_dest_check"
  CHECK (
    ("kind" <> 'traslado' AND "dest_warehouse_id" IS NULL)
    OR ("kind" = 'traslado' AND "dest_warehouse_id" IS NOT NULL AND "dest_warehouse_id" <> "warehouse_id")
  );
--> statement-breakpoint
-- 2. El consumo clínico siempre queda vinculado a un paciente.
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_consume_patient_check"
  CHECK (("kind" <> 'consumo') OR ("patient_id" IS NOT NULL));
--> statement-breakpoint
-- 3. Sin recepciones por encima de lo pedido.
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_received_cap_check"
  CHECK ("received_quantity" <= "quantity");
--> statement-breakpoint

-- Corte limpio contact.stage_id → opportunity (el padre lo aplica en la
-- migración conjunta; orden estricto: backfill primero, DROP después).
-- NOTA DROP: este archivo NO incluye el DROP (el padre mueve el DROP
-- generado por Drizzle a después del backfill al integrar).
--
-- 1. Tablas (Drizzle las crea; aquí solo checks/RLS/grants que TS no expresa).
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_amount_check"
  CHECK ("amount_cents" IS NULL OR "amount_cents" >= 0);
--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_status_check"
  CHECK ("status" IN ('open','won','lost'));
--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_close_check"
  CHECK (
    ("status" = 'open' AND "closed_at" IS NULL AND "close_reason" IS NULL)
    OR ("status" IN ('won','lost') AND "closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_action_check"
  CHECK ("action" IN (
    'opportunity.created','opportunity.updated','opportunity.moved',
    'opportunity.won','opportunity.lost','opportunity.reopened'
  ));
--> statement-breakpoint
--
ALTER TABLE "opportunity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opportunity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opportunity_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opportunity_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "opportunity_org_isolation" ON "opportunity"
  USING ("organization_id" = current_setting('app.org_id', true))
  WITH CHECK ("organization_id" = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "opportunity_event_org_isolation" ON "opportunity_event"
  USING ("organization_id" = current_setting('app.org_id', true))
  WITH CHECK ("organization_id" = current_setting('app.org_id', true));
--> statement-breakpoint
-- Rol app: oportunidades lectura/escritura parcial; eventos solo anexar/leer.
GRANT SELECT, INSERT, UPDATE ON "opportunity" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "opportunity" FROM dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "opportunity_event" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "opportunity_event" FROM dentalagent_app;
--> statement-breakpoint
--
-- 2. Backfill real: una oportunidad inicial por contacto con etapa (preserva
-- el embudo antiguo). Solo contactos sin oportunidades (re-ejecutable).
-- Hechos preservados en cierres migrados: closed_at = updated_at del
-- contacto (NO es la fecha real de cierre; el motivo lo declara explícito).
-- Moneda: la de org_profile; sin perfil rige el default existente ('PEN').
INSERT INTO "opportunity"
  ("organization_id", "contact_id", "patient_id", "pipeline_id", "stage_id",
   "title", "amount_cents", "currency", "status",
   "closed_at", "close_reason", "created_at", "updated_at")
SELECT
  c."organization_id",
  c."id",
  NULL,
  s."pipeline_id",
  s."id",
  LEFT('Seguimiento · ' || c."display_name", 200),
  NULL,
  COALESCE(op."currency", 'PEN'),
  CASE WHEN s."kind" = 'won' THEN 'won' WHEN s."kind" = 'lost' THEN 'lost' ELSE 'open' END,
  CASE WHEN s."kind" IN ('won', 'lost') THEN c."updated_at" ELSE NULL END,
  CASE WHEN s."kind" IN ('won', 'lost')
    THEN 'Migración de etapa comercial anterior (fecha de cierre real desconocida)'
    ELSE NULL END,
  c."created_at",
  now()
FROM "contact" AS c
JOIN "pipeline_stage" AS s
  ON s."id" = c."stage_id" AND s."organization_id" = c."organization_id"
LEFT JOIN "org_profile" AS op
  ON op."organization_id" = c."organization_id"
WHERE c."stage_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "opportunity" AS o
    WHERE o."organization_id" = c."organization_id" AND o."contact_id" = c."id"
  );
--> statement-breakpoint

-- Portal del paciente: restricciones adicionales + RLS para la migración conjunta.
-- Tablas drizzle: portal_link, portal_session, portal_access_log
-- (packages/db/src/schema/portal.ts). Estilo RLS: igual que 0024_agenda.sql.
-- Purge seed-dev (acotado por org, antes de patient/contact):
--   portal_access_log -> portal_session -> portal_link.

-- 1. Forma del alcance: drizzle no valida jsonb; el servicio sí, esto lo blinda en DB.
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_scope_check" CHECK (
  jsonb_typeof("scope") = 'object'
  AND "scope" ? 'appointments' AND "scope" ? 'budgets'
  AND "scope" ? 'account' AND "scope" ? 'documents'
  AND jsonb_typeof("scope" -> 'documents') = 'array'
);
--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_scope_check" CHECK (
  jsonb_typeof("scope") = 'object'
  AND "scope" ? 'appointments' AND "scope" ? 'budgets'
  AND "scope" ? 'account' AND "scope" ? 'documents'
  AND jsonb_typeof("scope" -> 'documents') = 'array'
);
--> statement-breakpoint

-- 2. Coherencia de estados: usado implica used_at; pendiente implica sin uso;
-- revocado conserva evidencia (puede tener used_at si se revocó tras canje).
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_used_check" CHECK (
  (("status" = 'usado') AND ("used_at" IS NOT NULL))
  OR (("status" = 'pendiente') AND ("used_at" IS NULL))
  OR ("status" = 'revocado')
);
--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_revoked_check" CHECK (
  ("status" <> 'revocado') = ("revoked_at" IS NULL)
);
--> statement-breakpoint

-- 3. RLS por tenant (FORCE como el resto del dominio).
ALTER TABLE "portal_link" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_link" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_link"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "portal_session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_session"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "portal_access_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portal_access_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "portal_access_log"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint

-- 4. Grants: la bitácora es append-only (sin UPDATE ni DELETE); enlaces y
-- sesiones se revocan por UPDATE, nunca se borran en caliente.
GRANT SELECT, INSERT, UPDATE ON "portal_link", "portal_session" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "portal_link", "portal_session" FROM dentalagent_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "portal_access_log" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "portal_access_log" FROM dentalagent_app;
--> statement-breakpoint

-- Buzones Gmail/Microsoft365: checks + RLS + grants que TS no expresa.
-- El padre lo aplica en la migración conjunta (Drizzle crea la tabla
-- mailbox_oauth_state desde packages/db/src/schema/mailbox.ts).
--
-- 1. Checks de frontera (state OAuth de un solo uso y corta duración).
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_provider_check"
  CHECK ("provider" IN ('gmail', 'microsoft365'));
--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_expiry_check"
  CHECK ("expires_at" > "created_at");
--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_verifier_check"
  CHECK (char_length("code_verifier") BETWEEN 43 AND 128);
--> statement-breakpoint
--
-- 2. RLS: aislamiento por organización. El callback OAuth lee/consume el
-- nonce con rol owner (sin GUC); el rol app solo inserta su propio inicio.
ALTER TABLE "mailbox_oauth_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "mailbox_oauth_state_org_isolation" ON "mailbox_oauth_state"
  USING ("organization_id" = current_setting('app.org_id', true))
  WITH CHECK ("organization_id" = current_setting('app.org_id', true));
--> statement-breakpoint
-- Rol app: insertar su inicio y leer su fila; el consumo (DELETE) y la
-- limpieza de caducados corren con rol owner. Sin UPDATE jamás.
GRANT SELECT, INSERT ON "mailbox_oauth_state" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "mailbox_oauth_state" FROM dentalagent_app;
--> statement-breakpoint
-- Limpieza de nonces caducados o huérfanos (rol owner, p. ej. pg_cron diario).
-- DELETE FROM "mailbox_oauth_state" WHERE "expires_at" < now() - interval '1 day';
--
-- 3. channel_connection (tabla existente, dueño Meta): filas email usan
-- channel='email', provider IN ('gmail','microsoft365'), external_id = dirección
-- del buzón y polling_offset = cursor (historyId Gmail / deltaLink M365).
-- Sin CHECK nuevo para no chocar con otros canales; unicidad global
-- (provider, external_id) ya impide el mismo buzón en dos orgs (409 MAILBOX_TAKEN).
--
-- 4. Purge seed (el padre purga ORG_A/ORG_B; sin TRUNCATE global):
-- mailbox_oauth_state es solo runtime (TTL 10 min): nada que purgar.
-- La fila ejemplo de seed-mailbox vive en channel_connection y la purga su
-- dueño con el resto de conexiones. Orden seguro si hiciera falta:
-- mailbox_oauth_state -> channel_connection -> organization / "user".
--
-- 5. Tablas append-only de este slice: ninguna (el nonce se borra al consumir;
-- la conexión se borra al desconectar; el historial vive en audit_event).
-- Permisos especiales: settings.write (conectar/probar/desconectar),
-- conversations.read (ver metadatos); la UI no expone tokens jamás.

-- Restricciones SQL del slice WebChat (chat web embebible propio).
-- El padre genera la migración Drizzle conjunta; este archivo declara lo que
-- debe incluir además de la tabla `webchat_rate_limit` (schema propio en
-- packages/db/src/schema/webchat.ts, barrel pendiente del padre).
--
-- El slice NO crea tablas de dominio nuevas: reutiliza channel_connection,
-- contact, contact_identity, conversation, message e inbound_event con sus
-- policies RLS existentes (aislamiento por organización vía app.org_id).
-- La config del widget va cifrada (AES-256-GCM) en channel_connection.config_encrypted,
-- igual que el resto de conexiones: sin columnas nuevas, sin vías laterales.

-- 1. Coherencia proveedor/canal del chat propio.
ALTER TABLE "channel_connection"
  ADD CONSTRAINT "channel_connection_webchat_channel_chk"
  CHECK ("provider" <> 'web_chat' OR "channel" = 'webchat');
--> statement-breakpoint

-- 2. Rate limit del widget: tabla operativa SIN RLS (igual que inbound_event).
-- El enforcement es por clave (conexión + ámbito) desde ownerDb; el ledger de
-- dedupe ya existente sigue igual. Acceso solo rol owner/app runtime.
-- (Sin policy RLS a propósito: documentado como inbound_event.)

-- 3. Purge del seed: el seed webchat solo inserta en tablas existentes
-- (channel_connection proveedor web_chat, contact/contact_identity canal
-- webchat, conversation, message). El purge por org del padre las cubre si
-- filtra por organization_id; NO añadir TRUNCATE global ni cascadas nuevas.
-- webchat_rate_limit es efímera (ventanas de 60 s): no requiere purge de seed.

-- 4. Limpieza de cubetas vencidas (respaldo por si el delete oportunista de
-- checkWebchatRateLimit no alcanza; pg_cron del padre si lo desea):
-- DELETE FROM "webchat_rate_limit" WHERE "window_start" < now() - interval '1 hour';

ALTER TABLE "agent_knowledge_entry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_knowledge_entry" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_knowledge_entry" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_knowledge_entry" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_knowledge_revision" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_knowledge_revision" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_knowledge_revision" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_policy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_policy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_policy" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_policy" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_policy" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_proposal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_proposal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_proposal" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_proposal" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_proposal" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_handoff" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_handoff" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_handoff" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_handoff" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_handoff" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_run_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_run_ledger" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_run_ledger" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_run_ledger" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "cash_shift" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_shift" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "cash_shift" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cash_shift" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "cash_shift" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "cash_movement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_movement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "cash_movement" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cash_movement" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "cash_movement" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "expense" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "expense" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "expense" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "expense" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "expense" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "installment_plan" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "installment_plan" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "installment_plan" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "installment_plan" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "installment_plan" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "installment_quota" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "installment_quota" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "installment_quota" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "installment_quota" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "installment_quota" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "commission_rule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commission_rule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "commission_rule" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "commission_rule" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "commission_rule" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "commission_settlement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commission_settlement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "commission_settlement" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "commission_settlement" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "commission_settlement" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commission_settlement_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "commission_settlement_line" USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "commission_settlement_line" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "commission_settlement_line" FROM dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE ON agent_knowledge_revision, agent_run_ledger FROM dentalagent_app;
--> statement-breakpoint
REVOKE ALL ON webchat_rate_limit FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE contact DROP COLUMN stage_id;
--> statement-breakpoint
