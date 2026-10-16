-- Claves compuestas de la fase 3 (revisión final): lo que nombra otra fila
-- clínica la nombra dentro de la misma organización y del mismo paciente, para
-- que ni un error del servicio cruce clínicas ni personas.
--
-- 1. El odontograma firmado al cerrar una atención es de esa atención y de su paciente.
CREATE UNIQUE INDEX IF NOT EXISTS "encounter_org_patient_id_uidx" ON "encounter" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
ALTER TABLE "odontogram_assessment" DROP CONSTRAINT IF EXISTS "odontogram_assessment_encounter_id_encounter_id_fk";--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 2. Lo tratado que queda dibujado lo dejó un tratamiento del mismo paciente.
ALTER TABLE "odontogram_entry" DROP CONSTRAINT IF EXISTS "odontogram_entry_left_by_plan_item_id_treatment_plan_item_id_fk";--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_left_by_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","left_by_plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 3. Cada opción de un presupuesto es del presupuesto de ese mismo paciente.
CREATE UNIQUE INDEX IF NOT EXISTS "treatment_budget_org_patient_id_uidx" ON "treatment_budget" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
ALTER TABLE "treatment_budget_option" DROP CONSTRAINT IF EXISTS "treatment_budget_option_budget_fk";--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_budget_fk" FOREIGN KEY ("organization_id","patient_id","budget_id") REFERENCES "public"."treatment_budget"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;
