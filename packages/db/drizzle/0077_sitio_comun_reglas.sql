-- Reglas del sitio común (0074, ADR 0079). Un sitio tiene sistema y código
-- juntos, o ninguno; qué códigos valen lo decide el producto en el servicio
-- (ADR 0036: lo que cambia no va en checks).
ALTER TABLE encounter_procedure ADD CONSTRAINT encounter_procedure_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE treatment_plan_item ADD CONSTRAINT treatment_plan_item_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE treatment_budget_item ADD CONSTRAINT treatment_budget_item_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE encounter_diagnosis ADD CONSTRAINT encounter_diagnosis_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE clinical_note ADD CONSTRAINT clinical_note_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE imaging_measurement ADD CONSTRAINT imaging_measurement_site_check CHECK ((site_system IS NULL) = (site_code IS NULL));--> statement-breakpoint
ALTER TABLE patient_document_context ADD CONSTRAINT patient_document_context_site_check CHECK ((site_system IS NULL) = (cardinality(site_codes) = 0));--> statement-breakpoint

-- Los nombres que PostgreSQL puso a la tabla renombrada siguen al nombre nuevo.
ALTER TABLE encounter_site RENAME CONSTRAINT encounter_tooth_pkey TO encounter_site_pkey;--> statement-breakpoint
ALTER TABLE encounter_site RENAME CONSTRAINT encounter_tooth_id_not_null TO encounter_site_id_not_null;--> statement-breakpoint
ALTER TABLE encounter_site RENAME CONSTRAINT encounter_tooth_organization_id_not_null TO encounter_site_organization_id_not_null;--> statement-breakpoint
ALTER TABLE encounter_site RENAME CONSTRAINT encounter_tooth_encounter_id_not_null TO encounter_site_encounter_id_not_null;--> statement-breakpoint
ALTER TABLE encounter_site RENAME CONSTRAINT encounter_tooth_created_at_not_null TO encounter_site_created_at_not_null;--> statement-breakpoint
ALTER POLICY draft_teeth_delete ON encounter_site RENAME TO draft_sites_delete;
