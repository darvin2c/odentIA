ALTER TABLE "patient" ADD COLUMN "referral_kind" text;--> statement-breakpoint
-- A mano (decisión 3 de Reportes v2): lo que ya se escribió como texto libre
-- queda como «Otro» con su texto, antes de exigir que el texto sea solo de «Otro».
-- Un texto en blanco no dice nada y se vacía.
UPDATE "patient" SET "referral_source" = NULL WHERE "referral_source" IS NOT NULL AND btrim("referral_source") = '';--> statement-breakpoint
UPDATE "patient" SET "referral_kind" = 'otro' WHERE "referral_source" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_referral_kind_check" CHECK ("patient"."referral_kind" IS NULL OR "patient"."referral_kind" IN ('recomendacion','redes_sociales','google_mapas','paso_por_aqui','convenio','otro'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_referral_source_check" CHECK ("patient"."referral_source" IS NULL OR "patient"."referral_kind" = 'otro');
