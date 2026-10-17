-- Diagnósticos por lista y demografía con códigos internacionales (fase 4,
-- tablero 6; issues 35 y 42; decisiones 11, 26, 27 y 28; ADR 0041).
-- No hay datos reales: lo de desarrollo se convierte sin plan de conservación.

-- 1) Listas de diagnósticos: cada código es (lista, código) con su edición.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "diagnosis_code_system" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"country" char(2),
	"uri" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "diagnosis_code_release" (
	"system_key" text NOT NULL,
	"edition" text NOT NULL,
	"official" boolean NOT NULL,
	"license" text NOT NULL,
	"source_url" text,
	"source_sha256" text,
	"code_count" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_code_release_system_key_edition_pk" PRIMARY KEY("system_key","edition"),
	CONSTRAINT "diagnosis_code_release_sha_check" CHECK ("diagnosis_code_release"."source_sha256" IS NULL OR "diagnosis_code_release"."source_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "diagnosis_code" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"edition" text NOT NULL,
	"title" text NOT NULL,
	"uri" text,
	"is_category" boolean DEFAULT false NOT NULL,
	"is_dental" boolean DEFAULT false NOT NULL,
	"search_text" text NOT NULL,
	CONSTRAINT "diagnosis_code_system_key_code_pk" PRIMARY KEY("system_key","code")
);--> statement-breakpoint
ALTER TABLE "diagnosis_code_release" ADD CONSTRAINT "diagnosis_code_release_system_key_diagnosis_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "public"."diagnosis_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_code" ADD CONSTRAINT "diagnosis_code_system_key_diagnosis_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "public"."diagnosis_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_code" ADD CONSTRAINT "diagnosis_code_release_fk" FOREIGN KEY ("system_key","edition") REFERENCES "public"."diagnosis_code_release"("system_key","edition") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- El buscador ignora tildes y mayúsculas: busca en el texto normalizado.
CREATE INDEX "diagnosis_code_search_idx" ON "diagnosis_code" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
-- Las dos listas de la OMS y, preparadas sin cargar, las nacionales.
INSERT INTO "diagnosis_code_system" ("key", "title", "publisher", "country", "uri") VALUES
	('ICD-10', 'CIE-10 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://hl7.org/fhir/sid/icd-10'),
	('ICD-11', 'CIE-11 (OMS)', 'Organización Mundial de la Salud', NULL, 'http://id.who.int/icd/release/11/mms'),
	('ICD-10-PE', 'CIE-10 MINSA', 'Ministerio de Salud del Perú', 'PE', 'urn:odentia:diagnosis:icd-10-pe'),
	('ICD-10-ES', 'CIE-10-ES', 'Ministerio de Sanidad de España', 'ES', 'urn:odentia:diagnosis:icd-10-es');--> statement-breakpoint
-- Los 124 códigos de desarrollo pasan tal cual, como semilla no oficial (la
-- misma edición que escribe `seed:diagnoses`, que la vuelve a conciliar).
INSERT INTO "diagnosis_code_release" ("system_key", "edition", "official", "license", "code_count")
	SELECT 'ICD-10', 'semilla-desarrollo', false, 'Semilla mínima de desarrollo, no oficial: sin fuente verificada ni permiso de uso comercial.', count(*)::int
	FROM "cie10_code" HAVING count(*) > 0;--> statement-breakpoint
INSERT INTO "diagnosis_code" ("system_key", "code", "edition", "title", "is_category", "is_dental", "search_text")
	SELECT 'ICD-10', c."code", 'semilla-desarrollo', c."description",
		EXISTS (SELECT 1 FROM "cie10_code" sub WHERE sub."code" LIKE c."code" || '.%'),
		c."code" ~ '^K(0[0-9]|1[0-4])' OR c."code" IN ('Z01.2','Z46.3','Z97.2','S02.5','S02.6','S03.0','S03.2','B00.2','B37.0'),
		translate(lower(c."code" || ' ' || replace(c."code", '.', '') || ' ' || c."description"), 'áéíóúüñ', 'aeiouun')
	FROM "cie10_code" c;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "diagnosis_code_system" FROM "dentalagent_app";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "diagnosis_code_release" FROM "dentalagent_app";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "diagnosis_code" FROM "dentalagent_app";--> statement-breakpoint
-- La tabla vieja se va con sus nueve FK.
DROP TABLE "cie10_code" CASCADE;--> statement-breakpoint

-- 2) Las nueve columnas que apuntaban al catálogo, y el diagnóstico del
--    consentimiento (que no tenía FK), guardan lista y código.
ALTER TABLE "patient_condition" RENAME COLUMN "cie10_code" TO "diagnosis_code";--> statement-breakpoint
ALTER TABLE "patient_family_history" RENAME COLUMN "cie10_code" TO "diagnosis_code";--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" RENAME COLUMN "cie10_code" TO "diagnosis_code";--> statement-breakpoint
ALTER TABLE "patient_condition" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
ALTER TABLE "consent_document" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
-- El código del diagnóstico de una atención siempre está: la columna nace con la CIE-10.
ALTER TABLE "encounter_diagnosis" ADD COLUMN "diagnosis_system" text DEFAULT 'ICD-10' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ALTER COLUMN "diagnosis_system" DROP DEFAULT;--> statement-breakpoint
UPDATE "patient_condition" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "patient_family_history" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "clinical_note" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "odontogram_entry" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "treatment_plan_item" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "prescription" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
UPDATE "clinical_order" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
-- El consentimiento no tenía FK: un código que no está en el catálogo se quita.
UPDATE "consent_document" SET "diagnosis_code" = NULL WHERE "diagnosis_code" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "diagnosis_code" d WHERE d."system_key" = 'ICD-10' AND d."code" = "consent_document"."diagnosis_code");--> statement-breakpoint
UPDATE "consent_document" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
-- Completar la lista no cambia lo registrado: la guarda del borrador se
-- suspende solo para este relleno y para el tipo del diagnóstico (abajo).
ALTER TABLE "encounter_procedure" DISABLE TRIGGER "encounter_procedure_draft_only";--> statement-breakpoint
UPDATE "encounter_procedure" SET "diagnosis_system" = 'ICD-10' WHERE "diagnosis_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ENABLE TRIGGER "encounter_procedure_draft_only";--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "public"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_diagnosis_pair_check" CHECK (("patient_condition"."diagnosis_system" IS NULL) = ("patient_condition"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_diagnosis_pair_check" CHECK (("patient_family_history"."diagnosis_system" IS NULL) = ("patient_family_history"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_diagnosis_pair_check" CHECK (("clinical_note"."diagnosis_system" IS NULL) = ("clinical_note"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "odontogram_entry" ADD CONSTRAINT "odontogram_entry_diagnosis_pair_check" CHECK (("odontogram_entry"."diagnosis_system" IS NULL) = ("odontogram_entry"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_diagnosis_pair_check" CHECK (("treatment_plan_item"."diagnosis_system" IS NULL) = ("treatment_plan_item"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_diagnosis_pair_check" CHECK (("prescription"."diagnosis_system" IS NULL) = ("prescription"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_diagnosis_pair_check" CHECK (("clinical_order"."diagnosis_system" IS NULL) = ("clinical_order"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_diagnosis_pair_check" CHECK (("consent_document"."diagnosis_system" IS NULL) = ("consent_document"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_diagnosis_pair_check" CHECK (("encounter_procedure"."diagnosis_system" IS NULL) = ("encounter_procedure"."diagnosis_code" IS NULL));--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_diagnosis_pair_check" CHECK (("encounter_diagnosis"."diagnosis_system" IS NULL) = ("encounter_diagnosis"."diagnosis_code" IS NULL));--> statement-breakpoint
-- «Los más usados en tu clínica» y «ya diagnosticado antes» se leen por lista y código.
CREATE INDEX "encounter_diagnosis_org_code_idx" ON "encounter_diagnosis" USING btree ("organization_id","diagnosis_system","diagnosis_code");--> statement-breakpoint

-- 3) Tipo del diagnóstico con FHIR Condition.verificationStatus (decisión 11):
--    «Repetido» deja de elegirse; lo marca el sistema.
ALTER TABLE "encounter_diagnosis" ADD COLUMN "previously_diagnosed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" DROP CONSTRAINT "encounter_diagnosis_type_check";--> statement-breakpoint
ALTER TABLE "clinical_note" DROP CONSTRAINT "clinical_note_diagnosis_type_check";--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" DISABLE TRIGGER "encounter_diagnosis_draft_only";--> statement-breakpoint
UPDATE "encounter_diagnosis" SET
	"previously_diagnosed" = ("diagnosis_type" = 'repetido'),
	"diagnosis_type" = CASE "diagnosis_type" WHEN 'presuntivo' THEN 'provisional' WHEN 'definitivo' THEN 'confirmed' WHEN 'repetido' THEN 'confirmed' ELSE "diagnosis_type" END
	WHERE "diagnosis_type" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ENABLE TRIGGER "encounter_diagnosis_draft_only";--> statement-breakpoint
UPDATE "clinical_note" SET
	"diagnosis_type" = CASE "diagnosis_type" WHEN 'presuntivo' THEN 'provisional' ELSE 'confirmed' END
	WHERE "diagnosis_type" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_type_check" CHECK (("encounter_diagnosis"."diagnosis_type" IS NULL AND "encounter_diagnosis"."legacy_note_id" IS NOT NULL) OR "encounter_diagnosis"."diagnosis_type" IN ('provisional','confirmed'));--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_diagnosis_type_check" CHECK ("clinical_note"."diagnosis_type" IS NULL OR ("clinical_note"."diagnosis_code" IS NOT NULL AND "clinical_note"."diagnosis_type" IN ('provisional','confirmed')));--> statement-breakpoint

-- 4) La lista de cada clínica (decisión 26): la que recomienda su país.
ALTER TABLE "org_profile" ADD COLUMN "diagnosis_system" text;--> statement-breakpoint
UPDATE "org_profile" SET "diagnosis_system" = CASE WHEN "country_code" = 'CO' THEN 'ICD-11' ELSE 'ICD-10' END;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_diagnosis_system_check" CHECK ("org_profile"."diagnosis_system" IS NULL OR "org_profile"."diagnosis_system" IN ('ICD-10','ICD-11'));--> statement-breakpoint

-- 5) Estado civil (HL7 v3 MaritalStatus), nivel educativo (CINE 2011) y
--    parentesco (HL7 v3 RoleCode). «Conviviente» queda como la palabra de Perú
--    y se traduce a T solo al exportar (decisión 28).
ALTER TABLE "patient" DROP CONSTRAINT "patient_marital_status_check";--> statement-breakpoint
ALTER TABLE "patient" DROP CONSTRAINT "patient_education_level_check";--> statement-breakpoint
UPDATE "patient" p SET "marital_status" = CASE p."marital_status"
		WHEN 'soltero' THEN 'S' WHEN 'casado' THEN 'M' WHEN 'viudo' THEN 'W'
		WHEN 'divorciado' THEN 'D' WHEN 'separado' THEN 'L'
		WHEN 'conviviente' THEN CASE WHEN (SELECT o."country_code" FROM "org_profile" o WHERE o."organization_id" = p."organization_id") = 'PE' THEN 'PE:conviviente' ELSE 'T' END
		ELSE NULL END
	WHERE p."marital_status" IS NOT NULL;--> statement-breakpoint
UPDATE "patient" SET "education_level" = CASE "education_level"
		WHEN 'sin_nivel' THEN '0' WHEN 'inicial' THEN '0' WHEN 'primaria_incompleta' THEN '0'
		WHEN 'primaria_completa' THEN '1' WHEN 'secundaria_incompleta' THEN '1'
		WHEN 'secundaria_completa' THEN '3' WHEN 'superior_no_universitaria_incompleta' THEN '3'
		WHEN 'superior_no_universitaria_completa' THEN '5' WHEN 'superior_universitaria_incompleta' THEN '3'
		WHEN 'superior_universitaria_completa' THEN '6' WHEN 'posgrado' THEN '7'
		ELSE NULL END
	WHERE "education_level" IS NOT NULL;--> statement-breakpoint
UPDATE "patient" SET "emergency_contact_relationship" = CASE "emergency_contact_relationship"
		WHEN 'madre' THEN 'MTH' WHEN 'padre' THEN 'FTH' WHEN 'hijo' THEN 'CHILD'
		WHEN 'conyuge' THEN 'SPS' WHEN 'hermano' THEN 'SIB' WHEN 'otro_familiar' THEN 'FAMMEMB'
		WHEN 'abuelo' THEN 'FAMMEMB' WHEN 'tio' THEN 'FAMMEMB'
		ELSE NULL END
	WHERE "emergency_contact_relationship" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_marital_status_check" CHECK ("patient"."marital_status" IS NULL OR "patient"."marital_status" IN ('S','M','T','L','D','W') OR "patient"."marital_status" ~ '^[A-Z]{2}:[a-z_]{1,40}$');--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_education_level_check" CHECK ("patient"."education_level" IS NULL OR "patient"."education_level" IN ('0','1','2','3','4','5','6','7','8'));--> statement-breakpoint
ALTER TABLE "patient_family_history" DROP CONSTRAINT "patient_family_history_relationship_check";--> statement-breakpoint
UPDATE "patient_family_history" SET "relationship" = CASE "relationship"
		WHEN 'madre' THEN 'MTH' WHEN 'padre' THEN 'FTH' WHEN 'hijo' THEN 'CHILD'
		WHEN 'conyuge' THEN 'SPS' WHEN 'hermano' THEN 'SIB'
		ELSE 'FAMMEMB' END;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_relationship_check" CHECK ("patient_family_history"."relationship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB'));--> statement-breakpoint
ALTER TABLE "patient_contact" ADD COLUMN "kinship" text;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_kinship_check" CHECK ("patient_contact"."kinship" IS NULL OR "patient_contact"."kinship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB','FRND','NBOR'));
