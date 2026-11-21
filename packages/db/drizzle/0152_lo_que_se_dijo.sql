-- «Lo que se dijo» guardado con la atención (mesa del 20 nov 2026, «Clío en una consulta
-- conversada», ADR 0209): cada tramo del dictado o de la conversación, tal cual llegó.
CREATE TABLE "encounter_dictation_segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"transcript" text NOT NULL,
	"said_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"organized_at" timestamp with time zone,
	"unused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"turns" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_dictation_segment_transcript_check" CHECK (char_length("encounter_dictation_segment"."transcript") BETWEEN 1 AND 12000),
	CONSTRAINT "encounter_dictation_segment_unused_check" CHECK (jsonb_typeof("encounter_dictation_segment"."unused") = 'array')
);
--> statement-breakpoint
ALTER TABLE "encounter_dictation_segment" ADD CONSTRAINT "encounter_dictation_segment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_segment" ADD CONSTRAINT "encounter_dictation_segment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_segment" ADD CONSTRAINT "encounter_dictation_segment_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_dictation_segment_uidx" ON "encounter_dictation_segment" USING btree ("organization_id","encounter_id","segment_id");--> statement-breakpoint
CREATE INDEX "encounter_dictation_segment_said_idx" ON "encounter_dictation_segment" USING btree ("organization_id","encounter_id","said_at");--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════
-- public.encounter_dictation_segment
-- ═════════════════════════════════════════════════════════════════════════
-- Cada clínica ve solo lo suyo. La aplicación agrega el tramo y, al ordenarlo, anota cuándo
-- y lo que no se usó; en el repaso, los turnos. Lo dicho no se reescribe ni se borra (sale
-- solo con la atención descartada, por la cascada). Se escribe mientras la atención está en
-- borrador: firmada o anulada, lo que se dijo queda como quedó.
ALTER TABLE public.encounter_dictation_segment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.encounter_dictation_segment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.encounter_dictation_segment USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.encounter_dictation_segment FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.encounter_dictation_segment TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE (organized_at, unused, turns, updated_at) ON TABLE public.encounter_dictation_segment TO dentalagent_app;--> statement-breakpoint
CREATE FUNCTION public.encounter_dictation_segment_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.patient_id, NEW.encounter_id, NEW.segment_id, NEW.transcript, NEW.said_at, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM (OLD.organization_id, OLD.patient_id, OLD.encounter_id, OLD.segment_id, OLD.transcript, OLD.said_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Lo que se dijo no se reescribe' USING ERRCODE = '23514', CONSTRAINT = 'encounter_dictation_segment_guard';
  END IF;
  SELECT e.status INTO encounter_status FROM encounter e
    WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id;
  IF encounter_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Lo que se dijo se guarda mientras la atención está en borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_dictation_segment_guard';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER encounter_dictation_segment_draft_only BEFORE INSERT OR UPDATE ON public.encounter_dictation_segment FOR EACH ROW EXECUTE FUNCTION public.encounter_dictation_segment_guard();
