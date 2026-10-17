-- Lo repetido: mensajes y agente (fase 4, paso 7b-1).
-- 1) «Horario para escribir» (decisión 18 v3, ADR 0042): por día de la semana
--    (0 = domingo), los tramos en minutos locales en que odentIA escribe por su
--    cuenta. Viene de lunes a viernes de 8:00 a 20:00, sábado de 8:00 a 14:00 y
--    domingo sin mensajes. Reemplaza al «Horario de silencio» del Administrador.
ALTER TABLE "agent_config" ADD COLUMN "writing_hours" jsonb DEFAULT '[[],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,840]]]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_writing_hours_check" CHECK (jsonb_typeof("agent_config"."writing_hours") = 'array' and jsonb_array_length("agent_config"."writing_hours") = 7);--> statement-breakpoint
UPDATE "agent_config" SET "advisor" = "advisor" - 'quietStart' - 'quietEnd' WHERE "advisor" ?| array['quietStart','quietEnd'];--> statement-breakpoint
-- 2) «Lo que el agente debe saber» (decisión 24): una sola lista. Lo que la
--    clínica escribe es una regla más, con su origen; las indicaciones de antes
--    pasan a ser filas (una por línea, en su orden) y la columna desaparece.
ALTER TABLE "agent_lesson" ADD COLUMN "source" text DEFAULT 'aprendida' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_source_check" CHECK ("agent_lesson"."source" in ('aprendida','escrita'));--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_written_rule_check" CHECK ("agent_lesson"."source" = 'aprendida' or "agent_lesson"."kind" = 'regla');--> statement-breakpoint
INSERT INTO "agent_lesson" ("organization_id", "kind", "scope", "title", "body", "status", "source", "proposed_by", "approved_at", "created_at", "updated_at")
SELECT c."organization_id", 'regla', 'recepcion', left(btrim(l.line), 200), left(btrim(l.line), 2000), 'activa', 'escrita', 'clinica',
  c."updated_at" + l.n * interval '1 millisecond', c."updated_at" + l.n * interval '1 millisecond', c."updated_at"
FROM "agent_config" c
CROSS JOIN LATERAL regexp_split_to_table(c."system_prompt", E'\r?\n') WITH ORDINALITY AS l(line, n)
WHERE btrim(l.line) <> '';--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "system_prompt";
