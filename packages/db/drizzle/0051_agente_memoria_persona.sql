CREATE TABLE "agent_person_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"conversation_id" uuid,
	"channel" text,
	"created_by" text,
	"status" text DEFAULT 'activo' NOT NULL,
	"replaced_by_id" uuid,
	"removed_by" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_person_fact_source_check" CHECK ("agent_person_fact"."source" in ('agente','equipo')),
	CONSTRAINT "agent_person_fact_status_check" CHECK ("agent_person_fact"."status" in ('activo','reemplazado','quitado'))
);
--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_person_fact_contact_idx" ON "agent_person_fact" USING btree ("organization_id","contact_id","status");--> statement-breakpoint
ALTER TABLE "agent_person_fact" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_person_fact" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_person_fact"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Un dato se reemplaza o se quita; la fila queda como historia de lo que el agente supo y cuándo.
GRANT SELECT, INSERT, UPDATE ON "agent_person_fact" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_person_fact" FROM dentalagent_app;
