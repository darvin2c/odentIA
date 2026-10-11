CREATE TABLE "agent_answer_trace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"proposal_id" uuid,
	"message_id" uuid,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"outcome" text NOT NULL,
	"reply_text" text NOT NULL,
	"basis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_answer_trace_outcome_check" CHECK ("agent_answer_trace"."outcome" in ('enviada','pendiente','bloqueada','fallida'))
);
--> statement-breakpoint
CREATE TABLE "agent_case_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lookups" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "reply_check_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_answer_trace" ADD CONSTRAINT "agent_answer_trace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_answer_trace" ADD CONSTRAINT "agent_answer_trace_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_case_memory" ADD CONSTRAINT "agent_case_memory_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_case_memory" ADD CONSTRAINT "agent_case_memory_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_answer_trace_conversation_idx" ON "agent_answer_trace" USING btree ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_answer_trace_message_idx" ON "agent_answer_trace" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX "agent_answer_trace_proposal_idx" ON "agent_answer_trace" USING btree ("organization_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_case_memory_org_conversation_uidx" ON "agent_case_memory" USING btree ("organization_id","conversation_id");--> statement-breakpoint
ALTER TABLE "agent_case_memory" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_case_memory" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_case_memory"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_case_memory" TO dentalagent_app;
--> statement-breakpoint
ALTER TABLE "agent_answer_trace" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_answer_trace" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_answer_trace"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Traza de solo anexado: el rol app registra y lee, nunca corrige ni borra.
GRANT SELECT, INSERT ON "agent_answer_trace" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "agent_answer_trace" FROM dentalagent_app;
