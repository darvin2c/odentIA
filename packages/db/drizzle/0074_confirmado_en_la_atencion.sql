-- La atención en que se confirmó lo firmado por enlace: del mismo paciente y la misma clínica.
-- La aplicación ya tiene GRANT UPDATE sobre toda consent_document (0001): la columna no pide otro.
ALTER TABLE "consent_document" ADD COLUMN "informed_encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_informed_encounter_fk" FOREIGN KEY ("organization_id","patient_id","informed_encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;