CREATE TABLE "treatment_option_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "treatment_budget_org_number_uidx";--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "supersedes_budget_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "presented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD COLUMN "decision_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "option_group_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "supersedes_item_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "is_recommended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decision_status" text DEFAULT 'pendiente' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decided_by_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "decided_by_name" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_option_group" ADD CONSTRAINT "treatment_option_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_option_group" ADD CONSTRAINT "treatment_option_group_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_option_group" ADD CONSTRAINT "treatment_option_group_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_option_group" ADD CONSTRAINT "treatment_option_group_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_option_group_org_patient_idx" ON "treatment_option_group" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_option_group_org_plan_idx" ON "treatment_option_group" USING btree ("organization_id","plan_id");--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_supersedes_budget_id_treatment_budget_id_fk" FOREIGN KEY ("supersedes_budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decision_contact_id_contact_id_fk" FOREIGN KEY ("decision_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_option_group_id_treatment_option_group_id_fk" FOREIGN KEY ("option_group_id") REFERENCES "public"."treatment_option_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_supersedes_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("supersedes_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_decided_by_contact_id_contact_id_fk" FOREIGN KEY ("decided_by_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_org_number_uidx" ON "treatment_budget" USING btree ("organization_id","budget_number","revision_number");--> statement-breakpoint
ALTER TABLE "treatment_budget" DROP CONSTRAINT "treatment_budget_status_check";--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_status_check" CHECK ("treatment_budget"."status" IN ('borrador','presentado','aceptado','parcial','rechazado','pospuesto','cancelado','sustituido','historico'));--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_revision_check" CHECK ("treatment_budget"."revision_number" > 0);--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_status_check" CHECK ("treatment_plan_item"."status" IN ('pendiente','programado','en_curso','suspendido','realizado','cancelado','reemplazado'));--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_decision_status_check" CHECK ("treatment_plan_item"."decision_status" IN ('pendiente','aceptado','pospuesto','rechazado','reemplazado'));
--> statement-breakpoint
-- La decisión vigente se recupera de la línea histórica sin inventar aceptación.
UPDATE treatment_plan_item AS i SET
  decision_status = CASE WHEN l.decision IN ('aceptado','rechazado') THEN l.decision ELSE 'pendiente' END,
  decision_note = b.decision_note,
  decided_at = b.decided_at,
  decided_by_name = b.accepted_by_name
FROM treatment_budget_item AS l, treatment_budget AS b
WHERE l.plan_item_id = i.id AND l.budget_id = i.budget_id
  AND l.organization_id = i.organization_id AND b.id = l.budget_id
  AND b.organization_id = i.organization_id;--> statement-breakpoint
UPDATE treatment_plan_item AS i SET started_at = p.first_session
FROM (SELECT organization_id, plan_item_id, min(created_at) AS first_session
      FROM encounter_procedure WHERE plan_item_id IS NOT NULL
      GROUP BY organization_id, plan_item_id) AS p
WHERE p.plan_item_id = i.id AND p.organization_id = i.organization_id;--> statement-breakpoint
UPDATE treatment_plan_item SET completed_at = updated_at WHERE status = 'realizado';--> statement-breakpoint
ALTER TABLE treatment_option_group ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE treatment_option_group FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON treatment_option_group
  USING (organization_id = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
REVOKE DELETE ON treatment_option_group, treatment_plan_item, treatment_budget FROM dentalagent_app;