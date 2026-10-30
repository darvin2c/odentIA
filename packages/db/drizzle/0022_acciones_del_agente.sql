CREATE TABLE "agent_action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_action_log" ADD CONSTRAINT "agent_action_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_log" ADD CONSTRAINT "agent_action_log_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_action_log_conversation_idx" ON "agent_action_log" USING btree ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_action_log_once_uidx" ON "agent_action_log" USING btree ("conversation_id","trigger_message_id","kind","title");