CREATE TABLE "registration_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"match" text NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_hold_match_check" CHECK ("registration_hold"."match" IN ('documento', 'celular'))
);
--> statement-breakpoint
ALTER TABLE "registration_hold" ADD CONSTRAINT "registration_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_hold" ADD CONSTRAINT "registration_hold_organization_id_task_id_task_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_hold_task_uidx" ON "registration_hold" USING btree ("organization_id","task_id");--> statement-breakpoint
-- registration_hold: cada clínica ve solo lo suyo; lo borra la decisión de recepción.
ALTER TABLE public.registration_hold ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.registration_hold FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.registration_hold USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
-- Lo que escribió no se reescribe: se guarda una vez y se borra al decidir.
REVOKE UPDATE ON TABLE public.registration_hold FROM dentalagent_app;
