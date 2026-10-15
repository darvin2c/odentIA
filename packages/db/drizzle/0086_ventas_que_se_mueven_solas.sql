-- Ventas que se mueven solas, tareas que se cierran solas (ADR 0028).
-- odentIA aún no tiene datos reales: lo que ya no encaja se borra o se
-- convierte con el criterio que se documenta en cada paso.
--
-- Columnas nuevas primero (`moment` sin NOT NULL hasta rellenarla).
ALTER TABLE "task" ADD COLUMN "settled_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD COLUMN "moment" text;--> statement-breakpoint
ALTER TABLE "opportunity" ADD COLUMN "close_note" text;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD COLUMN "origin" text DEFAULT 'persona' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD COLUMN "cause_at" timestamp with time zone;--> statement-breakpoint
-- Quién hizo cada cosa: sin persona del equipo no se sabe si fue el agente, así que es «automático».
UPDATE "opportunity_event" SET "origin" = 'automatico' WHERE "actor_user_id" IS NULL;--> statement-breakpoint
--
-- 1. Las oportunidades automáticas «Seguimiento · …» (una por cada identidad de
-- canal nueva, y las que rellenó la migración 0026) se borran. Criterio seguro:
-- el título empieza por «Seguimiento · » y no tienen ningún dato de un interés
-- concreto (servicio, interés, valor, presupuesto, paciente ni conversación).
-- Sus notas quedan en la persona; sus tareas, sin oportunidad (FK SET NULL).
UPDATE "crm_note" SET "opportunity_id" = NULL WHERE "opportunity_id" IN (
  SELECT "id" FROM "opportunity" WHERE "title" LIKE 'Seguimiento · %' AND "service_id" IS NULL
    AND "interest_text" IS NULL AND "amount_cents" IS NULL AND "budget_id" IS NULL
    AND "patient_id" IS NULL AND "conversation_id" IS NULL);--> statement-breakpoint
DELETE FROM "opportunity" WHERE "title" LIKE 'Seguimiento · %' AND "service_id" IS NULL
  AND "interest_text" IS NULL AND "amount_cents" IS NULL AND "budget_id" IS NULL
  AND "patient_id" IS NULL AND "conversation_id" IS NULL;--> statement-breakpoint
--
-- 2. La línea «Seguimiento sin responsable» se retira: una oportunidad sin
-- responsable es de Recepción. Sus tareas abiertas se cierran solas; sus casos
-- y su estado se borran.
UPDATE "task" SET "status" = 'done', "updated_at" = now(),
  "settled_reason" = 'la línea «Seguimiento sin responsable» se retiró: una oportunidad sin responsable es de Recepción'
  WHERE "status" = 'open' AND "id" IN (
    SELECT "task_id" FROM "automation_job" WHERE "kind" = 'seguimientos_sin_responsable' AND "task_id" IS NOT NULL);--> statement-breakpoint
DELETE FROM "automation_link_token" WHERE "job_id" IN (
  SELECT "id" FROM "automation_job" WHERE "kind" = 'seguimientos_sin_responsable');--> statement-breakpoint
DELETE FROM "automation_job" WHERE "kind" = 'seguimientos_sin_responsable';--> statement-breakpoint
DELETE FROM "automation_rule" WHERE "kind" = 'seguimientos_sin_responsable';--> statement-breakpoint
--
-- 3. La próxima acción es una tarea, y solo una. La fecha suelta de una
-- oportunidad abierta que aún no tenía su tarea abierta pasa a ser esa tarea
-- (sin responsable, va a Recepción).
INSERT INTO "task" ("organization_id", "contact_id", "conversation_id", "opportunity_id", "title",
  "assignee_user_id", "area", "due_at", "created_by")
SELECT o."organization_id", o."contact_id", o."conversation_id", o."id",
  left(coalesce(nullif(trim(o."next_action_note"), ''), 'Retomar: ' || o."title"), 200),
  o."assigned_user_id", CASE WHEN o."assigned_user_id" IS NULL THEN 'recepcion' END, o."next_action_at", 'user'
FROM "opportunity" o
WHERE o."status" = 'open' AND o."next_action_at" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "task" t WHERE t."organization_id" = o."organization_id" AND t."opportunity_id" = o."id" AND t."status" = 'open');--> statement-breakpoint
-- Una oportunidad con varias tareas abiertas conserva una (la de su próxima
-- acción; si no, la que vence antes; si no, la más antigua). Las demás siguen
-- siendo tareas de la persona, sin oportunidad.
UPDATE "task" SET "opportunity_id" = NULL, "updated_at" = now()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT t."id", row_number() OVER (
      PARTITION BY t."organization_id", t."opportunity_id"
      ORDER BY (t."kind" = 'opportunity_follow_up') DESC, t."due_at" ASC NULLS LAST, t."created_at" ASC, t."id"
    ) AS n
    FROM "task" t WHERE t."opportunity_id" IS NOT NULL AND t."status" = 'open'
  ) ranked WHERE ranked.n > 1);--> statement-breakpoint
-- La tarea de una oportunidad sin responsable va a Recepción, igual que la oportunidad.
UPDATE "task" SET "area" = 'recepcion'
WHERE "opportunity_id" IS NOT NULL AND "assignee_user_id" IS NULL AND "area" IS NULL;--> statement-breakpoint
-- Una tarea de un paciente sin otro vínculo (las que dejaba el Administrador)
-- pasa a ser de su propia persona: así dice de quién es.
UPDATE "task" t SET "contact_id" = pc."contact_id"
FROM "patient_contact" pc
WHERE t."patient_id" IS NOT NULL AND t."contact_id" IS NULL AND t."conversation_id" IS NULL
  AND t."opportunity_id" IS NULL AND pc."organization_id" = t."organization_id"
  AND pc."patient_id" = t."patient_id" AND pc."relationship" = 'self';--> statement-breakpoint
DROP INDEX "opportunity_org_next_action_idx";--> statement-breakpoint
DROP INDEX "task_org_opp_open_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_opp_open_uidx" ON "task" USING btree ("organization_id","opportunity_id") WHERE "opportunity_id" IS NOT NULL AND "status" = 'open';--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "opportunity" DROP COLUMN "next_action_at";--> statement-breakpoint
ALTER TABLE "opportunity" DROP COLUMN "next_action_note";--> statement-breakpoint
--
-- 4. Cuatro pasos fijos por embudo: Interesado, Evaluación agendada,
-- Presupuesto enviado y Decidió. Cada embudo conserva sus etapas que encajan
-- (la primera abierta es Interesado; una abierta que habla de cita o evaluación
-- es Evaluación agendada; una abierta que habla de presupuesto es Presupuesto
-- enviado; la primera de cierre, ganada antes que perdida, es Decidió) y crea
-- las que faltan. Las oportunidades abiertas de cualquier otra etapa
-- («Contactado» y las propias) pasan a Interesado; las cerradas, a Decidió.
-- Las demás etapas se borran (el historial las deja en blanco, FK SET NULL).
DO $$
DECLARE
  p record;
  s_int uuid;
  s_eval uuid;
  s_pres uuid;
  s_dec uuid;
BEGIN
  FOR p IN SELECT "id", "organization_id" FROM "pipeline" LOOP
    s_int := NULL; s_eval := NULL; s_pres := NULL; s_dec := NULL;
    SELECT "id" INTO s_int FROM "pipeline_stage"
      WHERE "pipeline_id" = p."id" AND "kind" = 'open' ORDER BY "position" LIMIT 1;
    SELECT "id" INTO s_eval FROM "pipeline_stage"
      WHERE "pipeline_id" = p."id" AND "kind" = 'open' AND "id" IS DISTINCT FROM s_int
        AND ("name" ILIKE '%cita%' OR "name" ILIKE '%evaluaci%') ORDER BY "position" LIMIT 1;
    SELECT "id" INTO s_pres FROM "pipeline_stage"
      WHERE "pipeline_id" = p."id" AND "kind" = 'open' AND "id" IS DISTINCT FROM s_int
        AND "id" IS DISTINCT FROM s_eval AND "name" ILIKE '%presupuest%' ORDER BY "position" LIMIT 1;
    SELECT "id" INTO s_dec FROM "pipeline_stage"
      WHERE "pipeline_id" = p."id" AND "kind" IN ('won', 'lost') ORDER BY ("kind" = 'won') DESC, "position" LIMIT 1;
    -- Libera las posiciones 0 a 3 (únicas por embudo).
    UPDATE "pipeline_stage" SET "position" = -1000 - "position" WHERE "pipeline_id" = p."id";
    IF s_int IS NULL THEN
      INSERT INTO "pipeline_stage" ("organization_id", "pipeline_id", "name", "position", "kind")
        VALUES (p."organization_id", p."id", 'Interesado', 0, 'open') RETURNING "id" INTO s_int;
    END IF;
    IF s_eval IS NULL THEN
      INSERT INTO "pipeline_stage" ("organization_id", "pipeline_id", "name", "position", "kind")
        VALUES (p."organization_id", p."id", 'Evaluación agendada', 1, 'open') RETURNING "id" INTO s_eval;
    END IF;
    IF s_pres IS NULL THEN
      INSERT INTO "pipeline_stage" ("organization_id", "pipeline_id", "name", "position", "kind")
        VALUES (p."organization_id", p."id", 'Presupuesto enviado', 2, 'open') RETURNING "id" INTO s_pres;
    END IF;
    IF s_dec IS NULL THEN
      INSERT INTO "pipeline_stage" ("organization_id", "pipeline_id", "name", "position", "kind")
        VALUES (p."organization_id", p."id", 'Decidió', 3, 'won') RETURNING "id" INTO s_dec;
    END IF;
    UPDATE "pipeline_stage" SET "moment" = 'interesado', "name" = 'Interesado', "position" = 0 WHERE "id" = s_int;
    UPDATE "pipeline_stage" SET "moment" = 'evaluacion_agendada', "name" = 'Evaluación agendada', "position" = 1 WHERE "id" = s_eval;
    UPDATE "pipeline_stage" SET "moment" = 'presupuesto_enviado', "name" = 'Presupuesto enviado', "position" = 2 WHERE "id" = s_pres;
    UPDATE "pipeline_stage" SET "moment" = 'decidio', "name" = 'Decidió', "position" = 3 WHERE "id" = s_dec;
    UPDATE "opportunity" SET "stage_id" = CASE
        WHEN "status" <> 'open' THEN s_dec
        WHEN "stage_id" = s_eval THEN s_eval
        WHEN "stage_id" = s_pres THEN s_pres
        ELSE s_int
      END
      WHERE "pipeline_id" = p."id";
    DELETE FROM "pipeline_stage" WHERE "pipeline_id" = p."id" AND "moment" IS NULL;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "pipeline_stage" ALTER COLUMN "moment" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stage" DROP COLUMN "kind";--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_pipeline_moment_uidx" ON "pipeline_stage" USING btree ("pipeline_id","moment");--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_moment_check" CHECK ("pipeline_stage"."moment" IN ('interesado','evaluacion_agendada','presupuesto_enviado','decidio'));--> statement-breakpoint
--
-- 5. Una sola forma de cerrar, con motivos de una lista. El texto libre de un
-- cierre anterior queda como nota; el motivo pasa a «Aceptó» (ganada) u «Otro»
-- (perdida).
UPDATE "opportunity" SET "close_note" = left("close_reason", 500),
  "close_reason" = CASE WHEN "status" = 'won' THEN 'acepto' ELSE 'otro' END
  WHERE "status" IN ('won', 'lost');--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_close_reason_check" CHECK ("opportunity"."close_reason" IS NULL OR "opportunity"."close_reason" IN ('precio','otra_clinica','no_responde','no_lo_necesita','otro','rechazo_presupuesto','acepto','acepto_presupuesto'));--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_origin_check" CHECK ("opportunity_event"."origin" IN ('persona','agente','automatico'));
