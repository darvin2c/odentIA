ALTER TABLE "contact" ADD COLUMN "screen" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screened_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screen_reason" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screen_note" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "not_spam_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "not_spam_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contact_identity" ADD COLUMN "provider_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_screened_by_user_id_user_id_fk" FOREIGN KEY ("screened_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_not_spam_by_user_id_user_id_fk" FOREIGN KEY ("not_spam_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_org_screen_idx" ON "contact" USING btree ("organization_id","screen") WHERE "screen" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_screen_check" CHECK (("contact"."screen" IS NULL AND "contact"."screened_at" IS NULL AND "contact"."screened_by_user_id" IS NULL
        AND "contact"."screen_reason" IS NULL AND "contact"."screen_note" IS NULL)
      OR ("contact"."screen" = 'spam' AND "contact"."screened_at" IS NOT NULL
        AND "contact"."screen_reason" IN ('repeticion','publicidad','estafa','cadena','respuesta_automatica','venta','equipo'))
      OR ("contact"."screen" = 'blocked' AND "contact"."screened_at" IS NOT NULL AND "contact"."screened_by_user_id" IS NOT NULL
        AND "contact"."screen_reason" IN ('acoso','amenazas','estafa','otro') AND length(trim("contact"."screen_note")) > 0));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_not_spam_check" CHECK (("contact"."not_spam_at" IS NULL) = ("contact"."not_spam_by_user_id" IS NULL));