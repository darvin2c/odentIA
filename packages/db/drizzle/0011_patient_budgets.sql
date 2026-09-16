--> 0011 presupuestos agrupados + vínculo atención-plan + contexto de documentos.
--> treatment_budget/history: cabecera con decisión auditada y snapshots en el
--> ítem; encounter_plan_item: vínculo atención-plan (PK
--> compuesta); patient_document_context: contexto versionado append-only que
--> reemplaza patient_document.encounter_id/tooth_number (backfill v1 y drop).
CREATE TABLE "treatment_budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"budget_number" integer NOT NULL,
	"title" text NOT NULL,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"notes" text,
	"accepted_by_name" text,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encounter_plan_item" (
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_plan_item_encounter_id_plan_item_id_pk" PRIMARY KEY("encounter_id","plan_item_id")
);
--> statement-breakpoint
CREATE TABLE "patient_document_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"encounter_id" uuid,
	"plan_item_id" uuid,
	"tooth_numbers" smallint[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"author_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
--> Ítems: budget_id primero NULLABLE para el backfill histórico; al final de
--> esta migración queda NOT NULL (el schema ya lo declara obligatorio).
ALTER TABLE "treatment_plan_item" ADD COLUMN "budget_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decision" text DEFAULT 'pendiente' NOT NULL;--> statement-breakpoint
--> Backfill conservador histórico: agrupa ítems pre-presupuesto por
--> (org, paciente, moneda) en presupuestos 'historico'. NO infiere aceptación
--> (decision='sin_registro'). Correlativo por org vía org_counter key 'budget'
--> (continúa la serie si ya existe; idempotente por grupo vía NOT EXISTS y por
--> ítem vía budget_id IS NULL).
WITH "groups" AS (
  SELECT DISTINCT "treatment_plan_item"."organization_id", "treatment_plan_item"."patient_id", "treatment_plan_item"."currency"
  FROM "treatment_plan_item"
  WHERE "treatment_plan_item"."budget_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "treatment_budget" "hb"
      WHERE "hb"."organization_id" = "treatment_plan_item"."organization_id"
        AND "hb"."patient_id" = "treatment_plan_item"."patient_id"
        AND "hb"."currency" = "treatment_plan_item"."currency"
        AND "hb"."status" = 'historico'
    )
),
"numbered" AS (
  SELECT "organization_id", "patient_id", "currency",
    row_number() OVER (PARTITION BY "organization_id" ORDER BY "patient_id", "currency") AS "rn"
  FROM "groups"
),
"ins" AS (
  INSERT INTO "treatment_budget" ("organization_id", "patient_id", "budget_number", "title", "currency", "status", "notes")
  SELECT "n"."organization_id", "n"."patient_id",
    "n"."rn" + COALESCE("b"."value", 0),
    'Historial migrado' || CASE WHEN "n"."currency" <> 'PEN' THEN ' (' || "n"."currency" || ')' ELSE '' END,
    "n"."currency", 'historico',
    'Presupuesto histórico creado por la migración 0011: agrupa tratamientos registrados antes de presupuestos. Sin aceptación inferida (decision sin_registro).'
  FROM "numbered" "n"
  LEFT JOIN "org_counter" "b" ON "b"."organization_id" = "n"."organization_id" AND "b"."key" = 'budget'
  RETURNING "organization_id", "budget_number"
)
INSERT INTO "org_counter" ("organization_id", "key", "value")
SELECT "organization_id", 'budget', MAX("budget_number") FROM "ins" GROUP BY "organization_id"
ON CONFLICT ("organization_id", "key") DO UPDATE SET "value" = GREATEST("org_counter"."value", "excluded"."value");--> statement-breakpoint
UPDATE "treatment_plan_item" "i" SET "budget_id" = "b"."id", "decision" = 'sin_registro'
FROM "treatment_budget" "b"
WHERE "b"."organization_id" = "i"."organization_id" AND "b"."patient_id" = "i"."patient_id"
  AND "b"."currency" = "i"."currency" AND "b"."status" = 'historico' AND "i"."budget_id" IS NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ALTER COLUMN "budget_id" SET NOT NULL;--> statement-breakpoint
--> Vínculos atención↔plan preservados desde las dos fuentes históricas
--> (ítem realizado con encounter_id y procedimiento con plan_item_id).
INSERT INTO "encounter_plan_item" ("organization_id", "encounter_id", "plan_item_id")
SELECT "organization_id", "encounter_id", "id" FROM "treatment_plan_item" WHERE "encounter_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "encounter_plan_item" ("organization_id", "encounter_id", "plan_item_id")
SELECT "organization_id", "encounter_id", "plan_item_id" FROM "encounter_procedure" WHERE "plan_item_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
--> Contextos v1 desde las columnas que se retiran (conserva atención y pieza;
--> tags '{}': patient_document no tiene etiquetas hoy, nada que inventar).
INSERT INTO "patient_document_context" ("organization_id", "patient_id", "document_id", "version", "encounter_id", "plan_item_id", "tooth_numbers", "tags", "author_user_id")
SELECT "organization_id", "patient_id", "id", 1, "encounter_id", NULL,
  CASE WHEN "tooth_number" IS NULL THEN '{}' ELSE ARRAY["tooth_number"] END,
  '{}', "uploaded_by"
FROM "patient_document"
ON CONFLICT DO NOTHING;--> statement-breakpoint
--> Normalización NFKD y marcas U+0300–036F, igual al helper de etiquetas.
--> Deduplica conservando el primer orden; preserva valores antiguos no vacíos
--> aunque no cumplan los límites actuales para no perder información.
UPDATE "contact" SET "tags" = "n"."tags" FROM (
  SELECT "c"."id",
    COALESCE((
      SELECT array_agg("x"."canon" ORDER BY "x"."ord")
      FROM (
        SELECT DISTINCT ON ("s"."canon") "s"."canon", "s"."ord"
        FROM (
          SELECT NULLIF(regexp_replace(regexp_replace(lower(trim(regexp_replace(normalize("t"."tag", NFKD), E'[\u0300-\u036f]', '', 'g'))), '[\s_\-]+', '-', 'g'), '^-+|-+$', '', 'g'), '') AS "canon", "t"."ord"
          FROM unnest("c"."tags") WITH ORDINALITY AS "t"("tag", "ord")
        ) "s"
        WHERE "s"."canon" IS NOT NULL
        ORDER BY "s"."canon", "s"."ord"
      ) "x"
    ), '{}') AS "tags"
  FROM "contact" "c"
) "n" WHERE "n"."id" = "contact"."id";--> statement-breakpoint
UPDATE "patient_document_context" SET "tags" = "n"."tags" FROM (
  SELECT "c"."id",
    COALESCE((
      SELECT array_agg("x"."canon" ORDER BY "x"."ord")
      FROM (
        SELECT DISTINCT ON ("s"."canon") "s"."canon", "s"."ord"
        FROM (
          SELECT NULLIF(regexp_replace(regexp_replace(lower(trim(regexp_replace(normalize("t"."tag", NFKD), E'[\u0300-\u036f]', '', 'g'))), '[\s_\-]+', '-', 'g'), '^-+|-+$', '', 'g'), '') AS "canon", "t"."ord"
          FROM unnest("c"."tags") WITH ORDINALITY AS "t"("tag", "ord")
        ) "s"
        WHERE "s"."canon" IS NOT NULL
        ORDER BY "s"."canon", "s"."ord"
      ) "x"
    ), '{}') AS "tags"
  FROM "patient_document_context" "c"
) "n" WHERE "n"."id" = "patient_document_context"."id";--> statement-breakpoint
--> Retiro de columnas de documentos: el contexto v1 ya conserva los datos.
--> Sin triggers ni vistas sobre estas columnas (solo la FK que se elimina).
ALTER TABLE "patient_document" DROP CONSTRAINT "patient_document_encounter_id_encounter_id_fk";--> statement-breakpoint
ALTER TABLE "patient_document" DROP COLUMN "encounter_id";--> statement-breakpoint
ALTER TABLE "patient_document" DROP COLUMN "tooth_number";--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_document_id_patient_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."patient_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encounter_plan_item_plan_item_idx" ON "encounter_plan_item" USING btree ("plan_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_document_context_document_version_uidx" ON "patient_document_context" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "patient_document_context_org_patient_idx" ON "patient_document_context" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_document_context_document_idx" ON "patient_document_context" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_org_number_uidx" ON "treatment_budget" USING btree ("organization_id","budget_number");--> statement-breakpoint
CREATE INDEX "treatment_budget_org_patient_idx" ON "treatment_budget" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_budget_idx" ON "treatment_plan_item" USING btree ("organization_id","budget_id");--> statement-breakpoint
--> RLS: aislamiento por tenant en las tres tablas nuevas (cie10 global aparte).
ALTER TABLE "treatment_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "treatment_budget" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "treatment_budget"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "encounter_plan_item"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "patient_document_context" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_document_context" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "patient_document_context"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
--> Inmutabilidad a nivel DB: presupuestos se cancelan por estado (nunca
--> DELETE); vínculos y contextos son append-only (nunca UPDATE ni DELETE).
--> Los ítems son el set editable del presupuesto en borrador (corrección de
--> la propuesta antes de presentar vía removePlanItem): DELETE limitado a
--> borrador por policy restrictiva; el servicio además exige ítem pendiente
--> sin relaciones clínicas. El borrado clínico general sigue prohibido.
GRANT DELETE ON "treatment_plan_item" TO "dentalagent_app";--> statement-breakpoint
CREATE POLICY "draft_plan_item_delete" ON "treatment_plan_item" AS RESTRICTIVE FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "treatment_budget"
    WHERE "treatment_budget"."id" = "treatment_plan_item"."budget_id"
      AND "treatment_budget"."organization_id" = "treatment_plan_item"."organization_id"
      AND "treatment_budget"."status" = 'borrador'
  ));
--> El presupuesto conserva UPDATE (borrador editable, presentar, decidir,
--> cancelar); su DELETE sigue revocado desde 0006 para treatment_plan_item
--> salvo el GRANT acotado a borrador de esta migración.
REVOKE DELETE ON "treatment_budget" FROM "dentalagent_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON "encounter_plan_item" FROM "dentalagent_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON "patient_document_context" FROM "dentalagent_app";--> statement-breakpoint
--> Blindaje de dominio a nivel DB (el servicio valida primero, fail closed).
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_status_check"
  CHECK ("status" IN ('borrador','presentado','aceptado','parcial','rechazado','cancelado','historico'));--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_number_check" CHECK ("budget_number" > 0);--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_decision_check"
  CHECK ("decision" IN ('pendiente','aceptado','rechazado','sin_registro'));--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_version_check" CHECK ("version" >= 1);
