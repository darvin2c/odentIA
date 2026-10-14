CREATE TABLE "clinic_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text,
	"title" text,
	"button_title" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"pending_version" integer,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_message_kind_check" CHECK (("clinic_message"."key" is null) <> ("clinic_message"."title" is null)),
	CONSTRAINT "clinic_message_catalog_check" CHECK ("clinic_message"."key" is null or ("clinic_message"."button_title" is null and "clinic_message"."archived_at" is null)),
	CONSTRAINT "clinic_message_version_check" CHECK ("clinic_message"."current_version" >= 0 and ("clinic_message"."pending_version" is null or "clinic_message"."pending_version" >= 0))
);
--> statement-breakpoint
CREATE TABLE "clinic_message_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"body" text NOT NULL,
	"template_name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_message_version_number_check" CHECK ("clinic_message_version"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "channel_connection" ADD COLUMN "webhook_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "channel_template" ADD COLUMN "status_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinic_message" ADD CONSTRAINT "clinic_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message" ADD CONSTRAINT "clinic_message_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- El vínculo compuesto de las versiones necesita antes este índice único.
CREATE UNIQUE INDEX "clinic_message_org_id_uidx" ON "clinic_message" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_organization_id_message_id_clinic_message_organization_id_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."clinic_message"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_org_key_uidx" ON "clinic_message" USING btree ("organization_id","key") WHERE "key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_version_message_number_uidx" ON "clinic_message_version" USING btree ("message_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_version_org_template_uidx" ON "clinic_message_version" USING btree ("organization_id","template_name");--> statement-breakpoint
ALTER TABLE "clinic_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinic_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "clinic_message" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "clinic_message_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinic_message_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "clinic_message_version" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- Un mensaje se archiva y un texto nuevo es otra versión: la aplicación no
-- borra ninguno ni reescribe un texto ya guardado.
REVOKE DELETE ON "clinic_message", "clinic_message_version" FROM dentalagent_app;--> statement-breakpoint
REVOKE UPDATE ON "clinic_message_version" FROM dentalagent_app;
