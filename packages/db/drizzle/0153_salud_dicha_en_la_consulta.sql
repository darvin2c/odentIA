-- Lo de salud dicho en la consulta (mesa del 20 nov 2026, «Clío en una consulta conversada», P3):
-- Clío lo propone como su propia sugerencia (`salud`) y, al confirmarlo con la persona, queda
-- como una declaración hecha en la consulta (`consulta`), con quién lo dijo.
ALTER TABLE "encounter_dictation_suggestion" DROP CONSTRAINT "encounter_dictation_suggestion_kind_check";--> statement-breakpoint
ALTER TABLE "patient_health_declaration" DROP CONSTRAINT "patient_health_declaration_via_check";--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_kind_check" CHECK ("encounter_dictation_suggestion"."kind" IN ('nota','diagnostico','plan','control','odontograma','receta','signos','examen','descanso','alergia','procedimiento','cita','presupuesto','material','ficha','salud'));--> statement-breakpoint
ALTER TABLE "patient_health_declaration" ADD CONSTRAINT "patient_health_declaration_via_check" CHECK ("patient_health_declaration"."via" IN ('enlace','registro','formulario','consulta'));