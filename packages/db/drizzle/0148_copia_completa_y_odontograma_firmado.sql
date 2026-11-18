-- La copia de la historia por su enlace (cada descarga registrada) y el odontograma firmado
-- como papel emitido, una vez y con su huella (mesa del 18 nov).
CREATE UNIQUE INDEX "patient_data_request_org_id_uidx" ON "patient_data_request" USING btree ("organization_id","id");--> statement-breakpoint
CREATE TABLE "patient_record_download" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"data_request_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issued_paper" DROP CONSTRAINT "issued_paper_type_check";--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD COLUMN "copy_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD COLUMN "copy_failed_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_record_download" ADD CONSTRAINT "patient_record_download_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_download" ADD CONSTRAINT "patient_record_download_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_download" ADD CONSTRAINT "patient_record_download_request_fk" FOREIGN KEY ("organization_id","data_request_id") REFERENCES "public"."patient_data_request"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_record_download_org_request_idx" ON "patient_record_download" USING btree ("organization_id","data_request_id");--> statement-breakpoint
CREATE INDEX "patient_record_download_org_patient_idx" ON "patient_record_download" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "issued_paper" ADD CONSTRAINT "issued_paper_type_check" CHECK ("issued_paper"."document_type" in ('prescription','order','medical_leave','attention_sheet','signed_odontogram'));
--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════
-- public.patient_record_download
-- ═════════════════════════════════════════════════════════════════════════
-- Cada vez que quien pidió la copia la bajó desde su enlace (mesa del 18 nov). Es la
-- traza de quién se llevó la historia: la aplicación solo la agrega y la lee, nunca la
-- cambia ni la borra (tampoco `erase_person_data`, como `clinical_access_log`).
ALTER TABLE public.patient_record_download ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.patient_record_download FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.patient_record_download USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.patient_record_download TO dentalagent_app;
