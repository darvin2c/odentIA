CREATE TABLE "commercial_follow_up_coordination" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"conversation_id" uuid,
	"trigger_due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"reason" text,
	"result" jsonb,
	"next_responsible_kind" text DEFAULT 'agent' NOT NULL,
	"next_responsible_user_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_coordination_status_check" CHECK ("commercial_follow_up_coordination"."status" in ('pendiente','propuesta','ejecutada','derivada','omitida','incierta')),
	CONSTRAINT "commercial_coordination_responsible_check" CHECK ("commercial_follow_up_coordination"."next_responsible_kind" in ('agent','team','user','contact','none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_id_uidx" ON "task" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" ADD CONSTRAINT "commercial_follow_up_coordination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" ADD CONSTRAINT "commercial_coordination_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" ADD CONSTRAINT "commercial_coordination_opportunity_fk" FOREIGN KEY ("organization_id","opportunity_id") REFERENCES "public"."opportunity"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" ADD CONSTRAINT "commercial_coordination_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_coordination_org_task_due_uidx" ON "commercial_follow_up_coordination" USING btree ("organization_id","task_id","trigger_due_at");--> statement-breakpoint
CREATE INDEX "commercial_coordination_org_status_idx" ON "commercial_follow_up_coordination" USING btree ("organization_id","status","created_at");--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commercial_follow_up_coordination" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "commercial_follow_up_coordination"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "commercial_follow_up_coordination" TO dentalagent_app;