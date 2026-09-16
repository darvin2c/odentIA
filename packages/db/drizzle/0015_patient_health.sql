--> 0015 agregado transaccional de salud: revisión de antecedentes en patient.
--> health_revision (bloqueo optimista), health_review_status (unknown|none|
--> recorded por grupo), auditoría de revisión. Backfill conservador: grupos
--> con filas activas → recorded, vacíos → unknown (nunca none inferido).
ALTER TABLE "patient" ADD COLUMN "health_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "health_review_status" jsonb DEFAULT '{"allergies":"unknown","conditions":"unknown","medications":"unknown"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "health_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "health_reviewed_by" text;--> statement-breakpoint
UPDATE "patient" "p" SET "health_review_status" = jsonb_build_object(
  'allergies', CASE WHEN EXISTS (SELECT 1 FROM "patient_allergy" "a" WHERE "a"."patient_id" = "p"."id" AND "a"."is_active") THEN 'recorded' ELSE 'unknown' END,
  'conditions', CASE WHEN EXISTS (SELECT 1 FROM "patient_condition" "c" WHERE "c"."patient_id" = "p"."id" AND "c"."status" = 'activa') THEN 'recorded' ELSE 'unknown' END,
  'medications', CASE WHEN EXISTS (SELECT 1 FROM "patient_medication" "m" WHERE "m"."patient_id" = "p"."id" AND "m"."end_date" IS NULL) THEN 'recorded' ELSE 'unknown' END
);--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_health_reviewed_by_user_id_fk" FOREIGN KEY ("health_reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
