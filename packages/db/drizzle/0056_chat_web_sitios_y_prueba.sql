CREATE TABLE "webchat_site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webchat_site_status_check" CHECK ("webchat_site"."status" in ('permitido','pendiente','bloqueado'))
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webchat_site_connection_origin_uidx" ON "webchat_site" USING btree ("connection_id","origin");