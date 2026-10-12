-- Nada nace con valores de un país: el perfil de la clínica ya no tiene país,
-- moneda, zona horaria ni formato por defecto (quien lo crea los pasa siempre),
-- el tipo de identificador fiscal puede faltar, y oportunidades y órdenes de
-- compra reciben siempre su moneda.
ALTER TABLE "org_profile" ALTER COLUMN "fiscal_doc_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "fiscal_doc_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "country_code" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_profile" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "purchase_order" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "opportunity" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
-- «RUC» venía del valor por defecto: sin número no hay identificador fiscal.
UPDATE "org_profile" SET "fiscal_doc_type" = NULL WHERE "fiscal_doc_number" IS NULL;
