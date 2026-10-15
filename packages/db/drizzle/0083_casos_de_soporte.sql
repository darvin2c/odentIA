--> statement-breakpoint
CREATE TABLE "support_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"help_request_id" uuid,
	"kind" text DEFAULT 'pregunta' NOT NULL,
	"question" text NOT NULL,
	"detail" text,
	"screen" text DEFAULT '/' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"app_version" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'abierto' NOT NULL,
	"assignee_staff_id" text,
	"opened_by" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"last_public_message_at" timestamp with time zone,
	"client_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_kind_check" CHECK ("support_case"."kind" in ('pregunta','problema','acceso')),
	CONSTRAINT "support_case_status_check" CHECK ("support_case"."status" in ('abierto','en_atencion','esperando_clinica','resuelto'))
);
--> statement-breakpoint
CREATE TABLE "support_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text,
	"author_kind" text DEFAULT 'cliente' NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_message_author_check" CHECK ("support_message"."author_kind" in ('cliente','staff','sistema'))
);
--> statement-breakpoint
CREATE TABLE "support_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" uuid,
	"organization_id" text,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachment_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "support_access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"scope" text DEFAULT 'diagnostico' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_grant_scope_check" CHECK ("support_access_grant"."scope" = 'diagnostico'),
	CONSTRAINT "support_access_grant_expiry_check" CHECK ("support_access_grant"."expires_at" > "support_access_grant"."created_at"),
	CONSTRAINT "support_access_grant_duration_check" CHECK ("support_access_grant"."expires_at" <= "support_access_grant"."created_at" + interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "support_access_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid,
	"case_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"staff_user_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_audit_action_check" CHECK ("support_access_audit"."action" in ('vista_diagnostica','denegado_sin_permiso','revocado'))
);
--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_help_request_id_help_request_id_fk" FOREIGN KEY ("help_request_id") REFERENCES "public"."help_request"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_assignee_staff_id_user_id_fk" FOREIGN KEY ("assignee_staff_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_grant_id_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_access_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_case_id_org_uidx" ON "support_case" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_help_request_id_unique" UNIQUE("help_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_message_id_case_uidx" ON "support_message" USING btree ("id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_grant_id_case_org_uidx" ON "support_access_grant" USING btree ("id","case_id","organization_id");--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_message_case_fk" FOREIGN KEY ("message_id","case_id") REFERENCES "public"."support_message"("id","case_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_grant_case_org_fk" FOREIGN KEY ("grant_id","case_id","organization_id") REFERENCES "public"."support_access_grant"("id","case_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH "moved" AS (
  INSERT INTO "support_case" ("organization_id","help_request_id","kind","question","detail","screen","role","app_version","dedupe_key","status","opened_by","resolved_at","last_public_message_at","client_seen_at","created_at","updated_at")
  SELECT hr."organization_id", hr."id", hr."kind", hr."question", hr."detail", hr."screen", hr."role", hr."app_version", hr."dedupe_key",
    CASE WHEN hr."status" = 'respondida' THEN 'resuelto' ELSE 'abierto' END,
    hr."user_id", hr."answered_at", CASE WHEN hr."answer" IS NOT NULL AND hr."answer" <> '' THEN hr."answered_at" END, hr."seen_at", hr."created_at", COALESCE(hr."answered_at", hr."created_at")
  FROM "help_request" hr
  WHERE NOT EXISTS (SELECT 1 FROM "support_case" sc WHERE sc."help_request_id" = hr."id")
  ON CONFLICT ("help_request_id") DO NOTHING
  RETURNING "id", "help_request_id", "organization_id"
)
INSERT INTO "support_message" ("case_id","organization_id","author_kind","body","is_internal","created_at")
SELECT m."id", m."organization_id", 'staff', hr."answer", false, COALESCE(hr."answered_at", hr."created_at")
FROM "help_request" hr JOIN "moved" m ON m."help_request_id" = hr."id"
WHERE hr."answer" IS NOT NULL AND hr."answer" <> '';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "support_case_org_match"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "support_case" c WHERE c."id" = NEW."case_id"
      AND c."organization_id" IS NOT DISTINCT FROM NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'support % must match organization of case %', TG_TABLE_NAME, NEW."case_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "support_message_org_match" BEFORE INSERT OR UPDATE ON "support_message" FOR EACH ROW EXECUTE FUNCTION "support_case_org_match"();--> statement-breakpoint
CREATE TRIGGER "support_attachment_org_match" BEFORE INSERT OR UPDATE ON "support_attachment" FOR EACH ROW EXECUTE FUNCTION "support_case_org_match"();--> statement-breakpoint
CREATE TRIGGER "support_access_grant_org_match" BEFORE INSERT OR UPDATE ON "support_access_grant" FOR EACH ROW EXECUTE FUNCTION "support_case_org_match"();--> statement-breakpoint
CREATE TRIGGER "support_access_audit_org_match" BEFORE INSERT OR UPDATE ON "support_access_audit" FOR EACH ROW EXECUTE FUNCTION "support_case_org_match"();--> statement-breakpoint
CREATE INDEX "support_case_org_status_idx" ON "support_case" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "support_case_staff_idx" ON "support_case" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "support_case_assignee_idx" ON "support_case" USING btree ("assignee_staff_id","status");--> statement-breakpoint
CREATE INDEX "support_case_dedupe_idx" ON "support_case" USING btree ("dedupe_key","status");--> statement-breakpoint
CREATE INDEX "support_case_opener_idx" ON "support_case" USING btree ("opened_by","created_at");--> statement-breakpoint
CREATE INDEX "support_message_case_idx" ON "support_message" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_attachment_case_idx" ON "support_attachment" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_access_grant_case_idx" ON "support_access_grant" USING btree ("case_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_access_grant_org_idx" ON "support_access_grant" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_access_audit_grant_idx" ON "support_access_audit" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "support_access_audit_case_idx" ON "support_access_audit" USING btree ("case_id","created_at");--> statement-breakpoint
ALTER TABLE "support_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_access_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_access_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_case"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_message"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_attachment"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_access_grant"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_access_audit"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_case", "support_access_grant" TO "dentalagent_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "support_message", "support_attachment", "support_access_audit" TO "dentalagent_app";--> statement-breakpoint
REVOKE DELETE ON "support_case", "support_message", "support_attachment", "support_access_grant", "support_access_audit" FROM "dentalagent_app";--> statement-breakpoint
REVOKE UPDATE ON "support_message", "support_attachment", "support_access_audit" FROM "dentalagent_app";
