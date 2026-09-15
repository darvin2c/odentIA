--> NTS 188-MINSA/DGIESP-2022: persistencia normativa del odontograma.
ALTER TABLE "odontogram_entry" ADD COLUMN "details" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "legacy_data" jsonb;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ALTER COLUMN "status" SET DEFAULT 'recorded';--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> 1. Archivo COMPLETO del objeto original (fila íntegra vía to_jsonb: incluye
--> organization_id, patient_id, created_by, created_at, encounter_id, etc.) más
--> marcador de migración, + señal de revisión. Cada fila migrada queda excluida
--> del dibujo normativo hasta su revisión clínica.
UPDATE "odontogram_entry" SET "legacy_data" = to_jsonb("odontogram_entry") || '{"migration": "0008_odontogram_nts188"}',
  "needs_review" = true
WHERE "legacy_data" IS NULL;--> statement-breakpoint
--> 2. Superficies a inglés (traducción 1:1, sin juicio clínico). La cara
--> externa sigue anatomía ADA: facial/labial en anterior (dígito 1–3),
--> buccal solo en posterior (dígito 4–8; 54/55/64/65/74/75/84/85 molares).
UPDATE "odontogram_entry" SET "surface" = CASE
  WHEN "surface" = 'vestibular' AND ("tooth_number" % 10) BETWEEN 1 AND 3 THEN 'facial'
  WHEN "surface" = 'vestibular' THEN 'buccal'
  WHEN "surface" = 'oclusal' THEN 'occlusal'
  WHEN "surface" = 'palatina' THEN 'palatal'
  ELSE "surface" END
WHERE "surface" IS NOT NULL
  AND "legacy_data"->>'migration' = '0008_odontogram_nts188';--> statement-breakpoint
--> 3. Condiciones a códigos ingleses solo con semántica exacta. 'obturacion'
--> puede ser temporal o definitiva: NO se inventa, se conserva como
--> legacy_restoration con needs_review. Los ambiguos (protesis/
--> extraccion_indicada/otro/sano) conservan códigos legacy ingleses NO
--> aceptados como hallazgos nuevos (el dominio los rechaza al crear).
--> Estatus también a inglés (el original queda en legacy_data->>'status'):
--> registrado/realizado/planificado -> recorded, anulado -> voided.
UPDATE "odontogram_entry" SET "condition" = CASE "condition"
  WHEN 'sano' THEN 'healthy'
  WHEN 'caries' THEN 'caries'
  WHEN 'obturacion' THEN 'legacy_restoration'
  WHEN 'corona' THEN 'crown'
  WHEN 'ausente' THEN 'missing_tooth'
  WHEN 'extraccion_indicada' THEN 'extraction_indicated'
  WHEN 'endodoncia' THEN 'root_canal_treatment'
  WHEN 'implante' THEN 'implant'
  WHEN 'fractura' THEN 'fracture'
  WHEN 'sellante' THEN 'sealant'
  WHEN 'protesis' THEN 'legacy_prosthesis'
  WHEN 'desgaste' THEN 'tooth_wear'
  WHEN 'otro' THEN 'clinical_observation'
  ELSE "condition" END,
  "status" = CASE "status"
  WHEN 'registrado' THEN 'recorded'
  WHEN 'realizado' THEN 'recorded'
  WHEN 'planificado' THEN 'recorded'
  WHEN 'anulado' THEN 'voided'
  ELSE "status" END
WHERE "legacy_data"->>'migration' = '0008_odontogram_nts188';--> statement-breakpoint
--> 4. El antiguo 'planificado' NO es hallazgo observado (NTS 188 §5.8): se crea
--> UN ítem de plan pendiente por grupo (pieza+condición legada+nota+diagnóstico)
--> sin perder el historial (la fila original se conserva con needs_review). El
--> detalle conserva fuente completa: condición legada, superficies, ids de los
--> registros origen, nota, autor y fecha originales. created_by queda NULL
--> (columna nullable sin default: el ítem lo crea la migración, la autoría
--> original va en el detalle). Idempotente por grupo vía marcador en detalle.
INSERT INTO "treatment_plan_item" ("organization_id", "patient_id", "tooth_number", "title", "detail", "diagnosis_code", "status")
SELECT g."organization_id", g."patient_id", g."tooth_number",
  'Hallazgo planificado migrado (pieza ' || g."tooth_number" || '): ' || g."legacy_condition",
  'Migrado desde odontograma (NTS-188-0008) [legado:' || g."legacy_condition" || ' pieza ' || g."tooth_number" || ']: '
    || g."entries_count" || ' registro(s) ' || g."entry_ids"
    || '; superficies: ' || g."surfaces"
    || '; nota: ' || coalesce(nullif(g."note", ''), 'sin nota')
    || '; registrado por ' || coalesce(g."authors", 'desconocido') || ' el ' || g."first_at"
    || '. Revisar y completar.',
  g."diagnosis_code", 'pendiente'
FROM (SELECT "organization_id", "patient_id", "tooth_number",
        "legacy_data"->>'condition' AS "legacy_condition", "diagnosis_code", "note",
        count(*) AS "entries_count",
        string_agg("id"::text, ', ' ORDER BY "created_at", "id") AS "entry_ids",
        string_agg(DISTINCT coalesce("surface", 'pieza completa'), ', ' ORDER BY coalesce("surface", 'pieza completa')) AS "surfaces",
        string_agg(DISTINCT "created_by", ', ' ORDER BY "created_by") FILTER (WHERE "created_by" IS NOT NULL) AS "authors",
        min("created_at")::text AS "first_at"
      FROM "odontogram_entry"
      WHERE "legacy_data"->>'migration' = '0008_odontogram_nts188'
        AND "legacy_data"->>'status' = 'planificado'
      GROUP BY "organization_id", "patient_id", "tooth_number",
        "legacy_data"->>'condition', "diagnosis_code", "note") AS g
WHERE NOT EXISTS (
  SELECT 1 FROM "treatment_plan_item" AS existing
  WHERE existing."organization_id" = g."organization_id"
    AND existing."patient_id" = g."patient_id"
    AND existing."tooth_number" = g."tooth_number"
    AND existing."detail" LIKE 'Migrado desde odontograma (NTS-188-0008) [legado:' || g."legacy_condition" || ' pieza ' || g."tooth_number" || ']%'
);--> statement-breakpoint
--> 5. Acta de odontograma: snapshot inmutable con firma y trazado obligatorio.
CREATE TABLE "odontogram_assessment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "patient_id" uuid NOT NULL,
  "author_user_id" text NOT NULL,
  "purpose" text NOT NULL,
  "specifications" text NOT NULL,
  "observations" text NOT NULL,
  "examiner_name" text NOT NULL,
  "registration_number" text NOT NULL,
  "patient_name" text NOT NULL,
  "patient_number" integer NOT NULL,
  "signature" jsonb NOT NULL,
  "signature_kind" text DEFAULT 'captured_handwritten' NOT NULL,
  "entries" jsonb NOT NULL,
  "standard" text DEFAULT 'NTS 188-MINSA/DGIESP-2022' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "odontogram_assessment_org_patient_idx" ON "odontogram_assessment" USING btree ("organization_id","patient_id");--> statement-breakpoint
ALTER TABLE "odontogram_assessment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "odontogram_assessment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "odontogram_assessment"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
--> Inmutabilidad del acta a nivel DB (el rol app solo inserta y lee).
REVOKE UPDATE, DELETE ON "odontogram_assessment" FROM "dentalagent_app";
--> statement-breakpoint
--> 6. Blindaje a nivel DB (tras traducir el legado): FDI válido, estatus del
--> modelo nuevo, superficies inglesas y details siempre objeto JSON.
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_tooth_fdi_check"
  CHECK ("tooth_number" IN (11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48,51,52,53,54,55,61,62,63,64,65,71,72,73,74,75,81,82,83,84,85));--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_status_check"
  CHECK ("status" IN ('recorded', 'voided'));--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_surface_check"
  CHECK ("surface" IS NULL OR "surface" IN ('mesial', 'distal', 'buccal', 'facial', 'lingual', 'palatal', 'occlusal', 'incisal'));--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_details_object_check"
  CHECK (jsonb_typeof("details") = 'object');
