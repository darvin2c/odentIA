ALTER TABLE "patient_document" ADD COLUMN "portal_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_document" ADD COLUMN "portal_hidden_by" text;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_portal_hidden_by_user_id_fk" FOREIGN KEY ("portal_hidden_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_portal_hidden_check" CHECK (("patient_document"."portal_hidden_at" IS NULL) = ("patient_document"."portal_hidden_by" IS NULL));--> statement-breakpoint
-- La aplicación oculta o vuelve a mostrar un archivo en el portal del paciente; nada más de la fila.
GRANT UPDATE(portal_hidden_at) ON TABLE public.patient_document TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE(portal_hidden_by) ON TABLE public.patient_document TO dentalagent_app;
