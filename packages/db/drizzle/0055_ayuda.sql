CREATE TABLE "help_ask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"screen" text NOT NULL,
	"topic_id" text,
	"helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'pregunta' NOT NULL,
	"question" text NOT NULL,
	"detail" text,
	"screen" text NOT NULL,
	"role" text NOT NULL,
	"app_version" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'abierta' NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_request_kind_check" CHECK ("help_request"."kind" in ('pregunta','problema')),
	CONSTRAINT "help_request_status_check" CHECK ("help_request"."status" in ('abierta','respondida'))
);
--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_request" ADD CONSTRAINT "help_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_request" ADD CONSTRAINT "help_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_ask_user_date_idx" ON "help_ask" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "help_request_user_idx" ON "help_request" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "help_request_case_idx" ON "help_request" USING btree ("dedupe_key","status");--> statement-breakpoint
ALTER TABLE "help_ask" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "help_ask" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "help_ask"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "help_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "help_request" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "help_request"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- La clínica crea y lee lo suyo; la respuesta la escribe el equipo de odentIA con el rol propietario.
GRANT SELECT, INSERT, UPDATE ON "help_ask", "help_request" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "help_ask", "help_request" FROM dentalagent_app;
