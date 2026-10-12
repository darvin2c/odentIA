CREATE TABLE "agent_lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'recepcion' NOT NULL,
	"title" text NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"failure" text,
	"original_reply" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'propuesta' NOT NULL,
	"review_item_id" uuid,
	"conversation_id" uuid,
	"knowledge_entry_id" uuid,
	"previous_body" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"proposed_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"withdrawn_by" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_lesson_kind_check" CHECK ("agent_lesson"."kind" in ('respuesta_oficial','regla','ejemplo')),
	CONSTRAINT "agent_lesson_status_check" CHECK ("agent_lesson"."status" in ('propuesta','activa','retirada','descartada')),
	CONSTRAINT "agent_lesson_failure_check" CHECK ("agent_lesson"."failure" is null or "agent_lesson"."failure" in ('dato_equivocado','falto_dato','tono','no_debio_responder','otra_cosa'))
);
--> statement-breakpoint
CREATE TABLE "agent_review_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"reply" text NOT NULL,
	"team_reply" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_item_reason_check" CHECK ("agent_review_item"."reason" in ('equipo_tomo','repitio_pregunta','muestra','marcada','editada')),
	CONSTRAINT "agent_review_item_status_check" CHECK ("agent_review_item"."status" in ('pendiente','bien','corregida'))
);
--> statement-breakpoint
CREATE TABLE "agent_test_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"question" text NOT NULL,
	"expected" text NOT NULL,
	"lesson_id" uuid,
	"status" text DEFAULT 'activo' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_test_case_status_check" CHECK ("agent_test_case"."status" in ('activo','retirado'))
);
--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD COLUMN "edited_text" text;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_review_item_id_agent_review_item_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."agent_review_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_knowledge_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("knowledge_entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_trace_id_agent_answer_trace_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."agent_answer_trace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_lesson_id_agent_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."agent_lesson"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_lesson_org_idx" ON "agent_lesson" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_review_item_trace_uidx" ON "agent_review_item" USING btree ("organization_id","trace_id");--> statement-breakpoint
CREATE INDEX "agent_review_item_org_idx" ON "agent_review_item" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_test_case_org_idx" ON "agent_test_case" USING btree ("organization_id","status","created_at");--> statement-breakpoint
ALTER TABLE "agent_review_item" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_review_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_review_item"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "agent_lesson" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_lesson" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_lesson"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
ALTER TABLE "agent_test_case" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_test_case" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_test_case"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Lo revisado, lo aprendido y sus casos se retiran, nunca se borran: son la historia de lo que cambió al agente.
GRANT SELECT, INSERT, UPDATE ON "agent_review_item", "agent_lesson", "agent_test_case" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_review_item", "agent_lesson", "agent_test_case" FROM dentalagent_app;
