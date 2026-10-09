-- Ciclo de la atención (ADR 0002): cita que la motiva, estados borrador,
-- finalizada y anulada, firma con colegiatura, anulación de actos en borrador,
-- diagnóstico como entidad y hallazgo del odontograma tratado.
CREATE TABLE "professional_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"signature_name" text,
	"professional_title" text DEFAULT 'Cirujano dentista' NOT NULL,
	"registration_body" text DEFAULT 'COP' NOT NULL,
	"registration_number" text,
	"specialty_registration" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_profile_lengths_check" CHECK (length("professional_profile"."professional_title") between 1 and 120 and length("professional_profile"."registration_body") between 1 and 40 and ("professional_profile"."registration_number" is null or length("professional_profile"."registration_number") between 1 and 20) and ("professional_profile"."signature_name" is null or length("professional_profile"."signature_name") between 1 and 200) and ("professional_profile"."specialty_registration" is null or length("professional_profile"."specialty_registration") between 1 and 40))
);
--> statement-breakpoint
CREATE TABLE "encounter_diagnosis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"cie10_code" text NOT NULL,
	"diagnosis_type" text,
	"tooth_number" smallint,
	"surfaces" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"status" text DEFAULT 'activo' NOT NULL,
	"resolved_at" timestamp with time zone,
	"legacy_note_id" uuid,
	"created_by" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_diagnosis_type_check" CHECK (("encounter_diagnosis"."diagnosis_type" IS NULL AND "encounter_diagnosis"."legacy_note_id" IS NOT NULL) OR "encounter_diagnosis"."diagnosis_type" IN ('presuntivo','definitivo','repetido')),
	CONSTRAINT "encounter_diagnosis_status_check" CHECK ("encounter_diagnosis"."status" IN ('activo','resuelto')),
	CONSTRAINT "encounter_diagnosis_void_check" CHECK (("encounter_diagnosis"."voided_at" IS NULL) = ("encounter_diagnosis"."void_reason" IS NULL)),
	CONSTRAINT "encounter_diagnosis_origin_check" CHECK ("encounter_diagnosis"."encounter_id" IS NOT NULL OR "encounter_diagnosis"."legacy_note_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "encounter" DROP CONSTRAINT "encounter_status_check";--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
-- Las atenciones existentes conservan su hora real: inicio al abrir y fin al cerrar.
UPDATE "encounter" SET "started_at" = "created_at", "ended_at" = CASE WHEN "finalized_at" >= "created_at" THEN "finalized_at" END;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "signer_name" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "signer_title" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "signer_registration" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "resolved_by_plan_item_id" uuid;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_cie10_code_cie10_code_code_fk" FOREIGN KEY ("cie10_code") REFERENCES "public"."cie10_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_legacy_note_id_clinical_note_id_fk" FOREIGN KEY ("legacy_note_id") REFERENCES "public"."clinical_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "professional_profile_org_user_uidx" ON "professional_profile" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "encounter_diagnosis_org_patient_idx" ON "encounter_diagnosis" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "encounter_diagnosis_encounter_idx" ON "encounter_diagnosis" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_diagnosis_legacy_note_uidx" ON "encounter_diagnosis" USING btree ("legacy_note_id") WHERE legacy_note_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_resolved_by_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("resolved_by_plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_appointment_active_uidx" ON "encounter" USING btree ("organization_id","appointment_id") WHERE appointment_id IS NOT NULL AND status <> 'anulada';--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_void_check" CHECK (("encounter"."status" = 'anulada') = ("encounter"."voided_at" IS NOT NULL) AND ("encounter"."voided_at" IS NULL) = ("encounter"."void_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_end_check" CHECK ("encounter"."ended_at" IS NULL OR "encounter"."ended_at" >= "encounter"."started_at");--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_status_check" CHECK ("encounter"."status" IN ('borrador','finalizada','anulada'));--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_void_check" CHECK (("encounter_procedure"."voided_at" IS NULL) = ("encounter_procedure"."void_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "professional_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "professional_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "professional_profile"
  USING (organization_id = nullif(current_setting('app.org_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter_diagnosis"
  USING (organization_id = nullif(current_setting('app.org_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- El diagnóstico es historia clínica: se anula, nunca se borra.
REVOKE DELETE, TRUNCATE ON "encounter_diagnosis" FROM dentalagent_app;--> statement-breakpoint
-- El hallazgo original sigue intacto; además de anularse, ahora puede quedar tratado.
GRANT UPDATE ("resolved_at", "resolved_by", "resolved_by_plan_item_id") ON "odontogram_entry" TO dentalagent_app;--> statement-breakpoint
-- Diagnósticos históricos: cada nota de evolución con código CIE-10 pasa a ser
-- un diagnóstico de su atención; la nota se conserva como estaba.
INSERT INTO "encounter_diagnosis" ("organization_id", "patient_id", "encounter_id", "cie10_code", "diagnosis_type", "tooth_number", "note", "legacy_note_id", "created_by", "created_at", "updated_at")
SELECT "organization_id", "patient_id", "encounter_id", "diagnosis_code", "diagnosis_type", "tooth_number", "note", "id", "author_user_id", "created_at", "created_at"
FROM "clinical_note"
WHERE "diagnosis_code" IS NOT NULL AND "kind" = 'evolucion';--> statement-breakpoint
-- Finalizada y anulada son historia: no se reescriben. Las correcciones de una
-- atención finalizada son adendas.
CREATE OR REPLACE FUNCTION guard_finalized_encounter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('finalizada', 'anulada') AND (NEW.status, NEW.organization_id, NEW.patient_id, NEW.dentist_user_id, NEW.branch_id,
      NEW.appointment_id, NEW.reason, NEW.evolution, NEW.indications, NEW.next_step, NEW.examination, NEW.next_appointment_at,
      NEW.started_at, NEW.ended_at, NEW.finalized_at, NEW.finalized_by, NEW.signer_name, NEW.signer_title, NEW.signer_registration,
      NEW.voided_at, NEW.voided_by, NEW.void_reason)
    IS DISTINCT FROM (OLD.status, OLD.organization_id, OLD.patient_id, OLD.dentist_user_id, OLD.branch_id,
      OLD.appointment_id, OLD.reason, OLD.evolution, OLD.indications, OLD.next_step, OLD.examination, OLD.next_appointment_at,
      OLD.started_at, OLD.ended_at, OLD.finalized_at, OLD.finalized_by, OLD.signer_name, OLD.signer_title, OLD.signer_registration,
      OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
    RAISE EXCEPTION 'Una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'encounter_finalized_immutable';
  END IF;
  IF OLD.status = 'borrador' AND NEW.status = 'finalizada' AND (NEW.signer_name IS NULL OR NEW.signer_registration IS NULL) THEN
    RAISE EXCEPTION 'Cerrar una atención exige la firma del profesional con su colegiatura' USING ERRCODE = '23514', CONSTRAINT = 'encounter_signature_required';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Procedimientos y diagnósticos se registran o se anulan solo mientras su
-- atención está en borrador; el estado clínico del diagnóstico (activo o
-- resuelto) sigue la evolución del paciente y puede cambiar después.
CREATE FUNCTION guard_draft_encounter_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS NOT DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
    IF TG_TABLE_NAME = 'encounter_procedure' THEN
      RAISE EXCEPTION 'Un procedimiento registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'resolved_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'resolved_at' - 'updated_at') THEN
      RAISE EXCEPTION 'Un diagnóstico registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'La anulación es definitiva' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  IF NEW.encounter_id IS NULL THEN
    RAISE EXCEPTION 'Los diagnósticos nuevos se registran en una atención' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  SELECT status INTO current_status FROM encounter WHERE id = NEW.encounter_id AND organization_id = NEW.organization_id;
  IF current_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'La atención no está en borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER encounter_procedure_draft_only BEFORE INSERT OR UPDATE ON encounter_procedure FOR EACH ROW EXECUTE FUNCTION guard_draft_encounter_child();--> statement-breakpoint
CREATE TRIGGER encounter_diagnosis_draft_only BEFORE INSERT OR UPDATE ON encounter_diagnosis FOR EACH ROW EXECUTE FUNCTION guard_draft_encounter_child();
