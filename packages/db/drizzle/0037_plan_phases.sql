ALTER TABLE "treatment_plan_item" ADD COLUMN "phase" text DEFAULT 'basica' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "planned_sessions" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_phase_check" CHECK ("treatment_plan_item"."phase" IN ('urgencia','basica','quirurgica','rehabilitadora','mantenimiento'));--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_planned_sessions_check" CHECK ("treatment_plan_item"."planned_sessions" BETWEEN 1 AND 60);--> statement-breakpoint
--> Fase propuesta por la especialidad del servicio (misma regla que
--> phaseForSpecialty en @odentia/clinical); la urgencia nunca se infiere.
UPDATE "treatment_plan_item" AS i
SET "phase" = CASE s."specialty"
    WHEN 'cirugia' THEN 'quirurgica'
    WHEN 'implantologia' THEN 'quirurgica'
    WHEN 'protesis' THEN 'rehabilitadora'
    WHEN 'ortodoncia' THEN 'rehabilitadora'
    WHEN 'estetica' THEN 'rehabilitadora'
    WHEN 'disfuncion' THEN 'rehabilitadora'
    ELSE 'basica'
  END
FROM "service_catalog" AS s
WHERE s."id" = i."service_id";--> statement-breakpoint
--> Orden de ejecución: el de indicación dentro de cada plan.
UPDATE "treatment_plan_item" AS i
SET "sort_order" = o.n
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "plan_id" ORDER BY "created_at", "id") AS n
  FROM "treatment_plan_item"
) AS o
WHERE o."id" = i."id";--> statement-breakpoint
--> Sesiones previstas: al menos las ya registradas, para no mostrar «3 de 1».
UPDATE "treatment_plan_item" AS i
SET "planned_sessions" = LEAST(60, GREATEST(1, d.n))
FROM (
  SELECT "plan_item_id", count(*)::int AS n
  FROM "encounter_procedure"
  WHERE "plan_item_id" IS NOT NULL AND "voided_at" IS NULL
  GROUP BY "plan_item_id"
) AS d
WHERE d."plan_item_id" = i."id";
