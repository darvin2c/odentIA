CREATE TABLE "calendar_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"known_clients" text[] DEFAULT '{}'::text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_status_check" CHECK ("calendar_feed"."status" IN ('activo','revocado')),
	CONSTRAINT "calendar_feed_revoked_check" CHECK (("calendar_feed"."status" <> 'revocado') = ("calendar_feed"."revoked_at" IS NULL)),
	CONSTRAINT "calendar_feed_reason_check" CHECK ("calendar_feed"."revoke_reason" IS NULL OR "calendar_feed"."revoke_reason" IN ('cambiado','apagado','administracion','sin_acceso'))
);--> statement-breakpoint
CREATE TABLE "calendar_feed_use" (
	"organization_id" text NOT NULL,
	"feed_id" uuid NOT NULL,
	"day" date NOT NULL,
	"client" text NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_use_pkey" PRIMARY KEY("organization_id","feed_id","day","client")
);--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_org_id_uidx" ON "calendar_feed" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_token_uidx" ON "calendar_feed" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_org_user_active_uidx" ON "calendar_feed" USING btree ("organization_id","user_id") WHERE "status" = 'activo';--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_use" ADD CONSTRAINT "calendar_feed_use_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_use" ADD CONSTRAINT "calendar_feed_use_organization_id_feed_id_calendar_feed_organization_id_id_fk" FOREIGN KEY ("organization_id","feed_id") REFERENCES "public"."calendar_feed"("organization_id","id") ON DELETE cascade ON UPDATE no action;
