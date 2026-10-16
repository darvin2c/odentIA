-- Un plan, una sección (ADR 0034; fase 3, paso 3).
--
-- 1. Salen las alternativas del plan (decisión 2): sumaban las dos opciones y
--    la persona nunca las veía. Las reemplazan las opciones del presupuesto.
--    No hay datos reales: se borran las columnas y la tabla.
ALTER TABLE "treatment_plan_item" DROP COLUMN IF EXISTS "option_group_id";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" DROP COLUMN IF EXISTS "is_recommended";--> statement-breakpoint
DROP TABLE IF EXISTS "treatment_option_group";--> statement-breakpoint
-- 2. Sale «histórico»: era de datos que nunca existieron. Lo que quedara así
--    se lee como anulado.
UPDATE "treatment_budget" SET "status" = 'cancelado' WHERE "status" = 'historico';--> statement-breakpoint
ALTER TABLE "treatment_budget" DROP CONSTRAINT "treatment_budget_status_check";--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_status_check" CHECK ("treatment_budget"."status" IN ('borrador','presentado','aceptado','parcial','rechazado','pospuesto','cancelado','sustituido'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treatment_budget_org_id_uidx" ON "treatment_budget" USING btree ("organization_id","id");--> statement-breakpoint
-- 3. Un solo borrador por persona (decisión 12): crece con cada atención. Si
--    hubiera más de uno, los demás se anulan (sus tratamientos vuelven a quedar
--    sin presupuesto y entran al que queda la próxima vez).
UPDATE "treatment_plan_item" i SET "budget_id" = NULL
  FROM "treatment_budget" b
  WHERE b."id" = i."budget_id" AND b."organization_id" = i."organization_id"
    AND b."status" = 'borrador' AND b."supersedes_budget_id" IS NULL
    AND EXISTS (SELECT 1 FROM "treatment_budget" o WHERE o."organization_id" = b."organization_id"
      AND o."patient_id" = b."patient_id" AND o."status" = 'borrador' AND o."supersedes_budget_id" IS NULL
      AND (o."created_at", o."id") > (b."created_at", b."id"));--> statement-breakpoint
UPDATE "treatment_budget" b SET "status" = 'cancelado', "updated_at" = now()
  WHERE b."status" = 'borrador' AND b."supersedes_budget_id" IS NULL
    AND EXISTS (SELECT 1 FROM "treatment_budget" o WHERE o."organization_id" = b."organization_id"
      AND o."patient_id" = b."patient_id" AND o."status" = 'borrador' AND o."supersedes_budget_id" IS NULL
      AND (o."created_at", o."id") > (b."created_at", b."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_one_draft_uidx" ON "treatment_budget" USING btree ("organization_id","patient_id") WHERE status = 'borrador' AND supersedes_budget_id IS NULL;--> statement-breakpoint
-- 4. Dos o tres opciones en un mismo presupuesto (decisión 13). Todo
--    presupuesto tiene al menos una: la de siempre, recomendada.
CREATE TABLE "treatment_budget_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"decision" text DEFAULT 'pendiente' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_budget_option_position_check" CHECK ("treatment_budget_option"."position" BETWEEN 1 AND 3),
	CONSTRAINT "treatment_budget_option_decision_check" CHECK ("treatment_budget_option"."decision" IN ('pendiente','elegida','no_elegida'))
);
--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_budget_fk" FOREIGN KEY ("organization_id","budget_id") REFERENCES "public"."treatment_budget"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_org_budget_id_uidx" ON "treatment_budget_option" USING btree ("organization_id","budget_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_position_uidx" ON "treatment_budget_option" USING btree ("budget_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_recommended_uidx" ON "treatment_budget_option" USING btree ("budget_id") WHERE is_recommended;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_chosen_uidx" ON "treatment_budget_option" USING btree ("budget_id") WHERE decision = 'elegida';--> statement-breakpoint
CREATE INDEX "treatment_budget_option_org_patient_idx" ON "treatment_budget_option" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "treatment_budget_option" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "treatment_budget_option"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- La opción de siempre para cada presupuesto que ya existe: elegida si ya se
-- decidió, pendiente si no.
INSERT INTO "treatment_budget_option" ("organization_id", "patient_id", "budget_id", "position", "is_recommended", "decision", "created_by", "created_at", "updated_at")
  SELECT "organization_id", "patient_id", "id", 1, true,
    CASE WHEN "status" IN ('aceptado','parcial','rechazado','pospuesto') THEN 'elegida' ELSE 'pendiente' END,
    "created_by", "created_at", "updated_at"
  FROM "treatment_budget";--> statement-breakpoint
-- La línea pasa a ser de una opción. El relleno de la columna nueva no es un
-- cambio de lo cotizado: la guarda de líneas entregadas se suspende solo para él.
ALTER TABLE "treatment_budget_item" ADD COLUMN "option_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" DISABLE TRIGGER "treatment_budget_item_guard_trigger";--> statement-breakpoint
UPDATE "treatment_budget_item" l SET "option_id" = o."id"
  FROM "treatment_budget_option" o
  WHERE o."budget_id" = l."budget_id" AND o."organization_id" = l."organization_id";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ENABLE TRIGGER "treatment_budget_item_guard_trigger";--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ALTER COLUMN "option_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_option_fk" FOREIGN KEY ("organization_id","budget_id","option_id") REFERENCES "public"."treatment_budget_option"("organization_id","budget_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "treatment_budget_item_budget_plan_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_item_option_plan_uidx" ON "treatment_budget_item" USING btree ("option_id","plan_item_id");--> statement-breakpoint
-- La guarda de líneas: la opción es parte de la identidad de la línea.
CREATE OR REPLACE FUNCTION treatment_budget_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las líneas de un presupuesto entregado no se borran';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan líneas a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.plan_id,NEW.budget_id,NEW.option_id,NEW.plan_item_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.plan_id,OLD.budget_id,OLD.option_id,OLD.plan_item_id) THEN
      RAISE EXCEPTION 'La identidad de la línea de presupuesto es inmutable';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (to_jsonb(NEW)-'decision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'decision'-'updated_at') THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite cambios de decisión';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- La guarda de opciones: se agregan, se quitan, se reordenan y se recomienda
-- solo en borrador; entregado, cada opción solo cambia su decisión.
CREATE OR REPLACE FUNCTION treatment_budget_option_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO budget_status FROM treatment_budget WHERE id = OLD.budget_id AND organization_id = OLD.organization_id;
    IF budget_status IS DISTINCT FROM 'borrador' THEN
      RAISE EXCEPTION 'Las opciones de un presupuesto entregado no se quitan';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan opciones a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.budget_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.budget_id) THEN
      RAISE EXCEPTION 'La opción no cambia de presupuesto';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (NEW.position, NEW.is_recommended) IS DISTINCT FROM (OLD.position, OLD.is_recommended) THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite elegir una opción';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "treatment_budget_option_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "treatment_budget_option" FOR EACH ROW EXECUTE FUNCTION treatment_budget_option_guard();
--> statement-breakpoint
-- 5. La decisión del tratamiento conoce «no elegida»: estaba solo en una
--    opción que la persona no eligió; no es un «no».
ALTER TABLE "treatment_plan_item" DROP CONSTRAINT "treatment_plan_item_decision_status_check";--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_decision_status_check" CHECK ("treatment_plan_item"."decision_status" IN ('pendiente','aceptado','pospuesto','rechazado','reemplazado','no_elegida'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treatment_plan_item_org_patient_id_uidx" ON "treatment_plan_item" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
-- 6. Agendar lo aceptado: la cita sabe qué tratamientos son y su atención los
--    trae. Mismo paciente en la cita y en el tratamiento. Es historia: la
--    aplicación no la reescribe ni la borra.
CREATE TABLE "appointment_plan_item" (
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_plan_item_appointment_id_plan_item_id_pk" PRIMARY KEY("appointment_id","plan_item_id")
);
--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_plan_item_plan_item_idx" ON "appointment_plan_item" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_plan_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "appointment_plan_item"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "appointment_plan_item" FROM dentalagent_app;
--> statement-breakpoint
-- 7. Agente: la respuesta de la persona a su presupuesto se anota con una
--    propuesta que espera su sí (decisiones 4 y 5), como una cita propuesta.
ALTER TABLE "agent_proposal" DROP CONSTRAINT "agent_proposal_action_check";--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_action_check" CHECK ("agent_proposal"."action" in ('reservar_cita','reprogramar_cita','cancelar_cita','enviar_mensaje','mover_oportunidad','crear_oportunidad','actualizar_seguimiento','cerrar_oportunidad','decidir_presupuesto'));
