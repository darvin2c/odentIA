ALTER TABLE "admin"."saas_import_draft" ADD COLUMN "payload_uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_import_draft" ADD COLUMN "payload_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_import_draft" ADD COLUMN "stale_payload_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Lo que ya estaba cuenta sus 30 días desde que se creó (nunca más tarde de lo prometido).
UPDATE "admin"."saas_import_draft" SET "payload_uploaded_at" = "created_at";