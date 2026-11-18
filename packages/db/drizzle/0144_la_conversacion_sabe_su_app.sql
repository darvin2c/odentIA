CREATE TABLE "admin"."saas_ad" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text,
	"headline" text,
	"body" text,
	"source_url" text,
	"product" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_ad_product_check" CHECK ("admin"."saas_ad"."product" IS NULL OR "admin"."saas_ad"."product" IN ('dental','medical','optical')),
	CONSTRAINT "saas_ad_text_check" CHECK (length("admin"."saas_ad"."source_id") BETWEEN 1 AND 128
        AND ("admin"."saas_ad"."source_type" IS NULL OR length("admin"."saas_ad"."source_type") <= 40)
        AND ("admin"."saas_ad"."headline" IS NULL OR length("admin"."saas_ad"."headline") <= 300)
        AND ("admin"."saas_ad"."body" IS NULL OR length("admin"."saas_ad"."body") <= 2000)
        AND ("admin"."saas_ad"."source_url" IS NULL OR length("admin"."saas_ad"."source_url") <= 2000)),
	CONSTRAINT "saas_ad_decided_check" CHECK (("admin"."saas_ad"."product" IS NULL) = ("admin"."saas_ad"."decided_at" IS NULL)
        AND ("admin"."saas_ad"."decided_at" IS NOT NULL OR "admin"."saas_ad"."decided_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD COLUMN "product" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD COLUMN "product_source" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD COLUMN "ad_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_ad" ADD CONSTRAINT "saas_ad_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_ad_source_uidx" ON "admin"."saas_ad" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_ad_id_saas_ad_id_fk" FOREIGN KEY ("ad_id") REFERENCES "admin"."saas_ad"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_chat_ad_idx" ON "admin"."saas_chat" USING btree ("ad_id");--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_product_check" CHECK (("admin"."saas_chat"."product" IS NULL OR "admin"."saas_chat"."product" IN ('dental','medical','optical'))
        AND ("admin"."saas_chat"."product_source" IS NULL OR "admin"."saas_chat"."product_source" IN ('anuncio','enlace','lo_dijo','persona'))
        AND (("admin"."saas_chat"."product" IS NULL) = ("admin"."saas_chat"."product_source" IS NULL)));