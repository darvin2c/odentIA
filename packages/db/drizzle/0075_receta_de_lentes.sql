CREATE SCHEMA "optical";
--> statement-breakpoint
CREATE TABLE "optical"."lens_prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"lenses" jsonb NOT NULL,
	"pupillary_distance" jsonb,
	"notes" text,
	"issued_on" date NOT NULL,
	"valid_until" date NOT NULL,
	"prescriber_user_id" text,
	"prescriber_name" text NOT NULL,
	"prescriber_registration" text,
	"photo_document_id" uuid,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lens_prescription_kind_check" CHECK ("optical"."lens_prescription"."kind" IN ('anteojos','contacto')),
	CONSTRAINT "lens_prescription_source_check" CHECK ("optical"."lens_prescription"."source" IN ('examen','externa')),
	CONSTRAINT "lens_prescription_source_encounter_check" CHECK (("optical"."lens_prescription"."source" = 'examen') = ("optical"."lens_prescription"."encounter_id" IS NOT NULL)),
	CONSTRAINT "lens_prescription_valid_check" CHECK ("optical"."lens_prescription"."valid_until" >= "optical"."lens_prescription"."issued_on"),
	CONSTRAINT "lens_prescription_void_check" CHECK (("optical"."lens_prescription"."voided_at" IS NULL) = ("optical"."lens_prescription"."void_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_prescriber_user_id_user_id_fk" FOREIGN KEY ("prescriber_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optical"."lens_prescription" ADD CONSTRAINT "lens_prescription_photo_fk" FOREIGN KEY ("organization_id","photo_document_id") REFERENCES "public"."patient_document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lens_prescription_patient_idx" ON "optical"."lens_prescription" USING btree ("organization_id","patient_id","issued_on");--> statement-breakpoint
CREATE UNIQUE INDEX "lens_prescription_encounter_kind_uidx" ON "optical"."lens_prescription" USING btree ("organization_id","encounter_id","kind") WHERE "optical"."lens_prescription"."encounter_id" IS NOT NULL AND "optical"."lens_prescription"."voided_at" IS NULL;--> statement-breakpoint

-- Las reglas de la receta de lentes de vistIA (ADR 0169). Lo de vistIA vive en su
-- esquema y el SQL a mano lo nombra sin esquema, como lo dental: el search_path lo
-- incluye. Vale para cada conexión nueva; set_config cubre esta misma.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, catalog, auth, admin, dental, optical', current_database());
END
$$;--> statement-breakpoint
SELECT set_config('search_path', 'public, catalog, auth, admin, dental, optical', false);--> statement-breakpoint
GRANT USAGE ON SCHEMA optical TO dentalagent_app;--> statement-breakpoint

-- De la clínica, con su RLS (ADR 0063).
ALTER TABLE optical.lens_prescription ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY optical.lens_prescription FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON optical.lens_prescription USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- Emitida, la receta no cambia: la aplicación solo la verifica (la externa) o la
-- anula, con su motivo. No se borra.
GRANT SELECT, INSERT ON TABLE optical.lens_prescription TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE (verified_at, verified_by, voided_at, voided_by, void_reason, updated_at) ON TABLE optical.lens_prescription TO dentalagent_app;
--> statement-breakpoint

-- Lo que dice la receta no cambia, ni para quien es dueño de la base: solo se
-- verifica (la externa, una vez: verificada no se desverifica) o se anula, una vez
-- y con su motivo. Anulada, ya nada cambia.
CREATE FUNCTION optical.lens_prescription_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  moving text[] := ARRAY['updated_at','verified_at','verified_by','voided_at','voided_by','void_reason'];
BEGIN
  IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL
    OR (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)
    OR ((NEW.verified_at, NEW.verified_by) IS DISTINCT FROM (OLD.verified_at, OLD.verified_by)
      AND (OLD.verified_at IS NOT NULL OR OLD.source <> 'externa' OR NEW.verified_at IS NULL OR NEW.verified_by IS NULL))
    OR (NEW.voided_at IS NOT NULL AND (NEW.voided_by IS NULL OR NEW.void_reason IS NULL))
    OR (NEW.voided_at IS NULL AND (NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL))
  THEN
    RAISE EXCEPTION 'Receta de lentes emitida: % no cambia', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER lens_prescription_immutable BEFORE UPDATE ON optical.lens_prescription FOR EACH ROW EXECUTE FUNCTION optical.lens_prescription_immutable();
