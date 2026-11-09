CREATE TABLE "job_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid,
	"patient_id" uuid NOT NULL,
	"order_number" integer NOT NULL,
	"request_key" text,
	"status" text DEFAULT 'por_enviar' NOT NULL,
	"promised_on" date NOT NULL,
	"maker" text NOT NULL,
	"title" text NOT NULL,
	"prescription" jsonb,
	"fitting" jsonb,
	"notes" text,
	"remake_of" uuid,
	"remake_reason" text,
	"delivered_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_status_check" CHECK ("job_order"."status" IN ('por_enviar','en_laboratorio','por_revisar','listo','entregado','anulado')),
	CONSTRAINT "job_order_remake_check" CHECK (("job_order"."remake_of" IS NULL) = ("job_order"."remake_reason" IS NULL)),
	CONSTRAINT "job_order_void_check" CHECK (("job_order"."status" = 'anulado') = ("job_order"."voided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "job_order_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"job_order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"actor_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_event_status_check" CHECK ("job_order_event"."status" IN ('por_enviar','en_laboratorio','por_revisar','listo','entregado','anulado'))
);
--> statement-breakpoint
CREATE TABLE "job_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"job_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"product_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"charge_id" uuid,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_line_kind_check" CHECK ("job_order_line"."kind" IN ('montura','lunas','contacto','otro')),
	CONSTRAINT "job_order_line_quantity_check" CHECK ("job_order_line"."quantity" BETWEEN 1 AND 99)
);
--> statement-breakpoint
ALTER TABLE "job_order" ADD CONSTRAINT "job_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order" ADD CONSTRAINT "job_order_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order" ADD CONSTRAINT "job_order_remake_of_job_order_id_fk" FOREIGN KEY ("remake_of") REFERENCES "public"."job_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order" ADD CONSTRAINT "job_order_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order" ADD CONSTRAINT "job_order_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_event" ADD CONSTRAINT "job_order_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_event" ADD CONSTRAINT "job_order_event_job_order_id_job_order_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_event" ADD CONSTRAINT "job_order_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_line" ADD CONSTRAINT "job_order_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_line" ADD CONSTRAINT "job_order_line_job_order_id_job_order_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_line" ADD CONSTRAINT "job_order_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_line" ADD CONSTRAINT "job_order_line_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_order_number_uidx" ON "job_order" USING btree ("organization_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "job_order_request_uidx" ON "job_order" USING btree ("organization_id","request_key");--> statement-breakpoint
CREATE INDEX "job_order_status_idx" ON "job_order" USING btree ("organization_id","status","promised_on");--> statement-breakpoint
CREATE INDEX "job_order_patient_idx" ON "job_order" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "job_order_event_order_idx" ON "job_order_event" USING btree ("organization_id","job_order_id","at");--> statement-breakpoint
CREATE INDEX "job_order_line_order_idx" ON "job_order_line" USING btree ("organization_id","job_order_id");--> statement-breakpoint

-- Las reglas del pedido (ADR 0168): de la clínica, con su RLS. La historia de
-- estados y las líneas solo se agregan; del pedido solo cambia su paso, la fecha
-- prometida, quién lo hace, sus notas, la entrega y la anulación.
ALTER TABLE public.job_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.job_order FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.job_order USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.job_order TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE (status, promised_on, maker, notes, delivered_at, voided_at, void_reason, updated_at) ON TABLE public.job_order TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.job_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.job_order_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.job_order_line USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.job_order_line TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.job_order_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.job_order_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.job_order_event USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.job_order_event TO dentalagent_app;--> statement-breakpoint

-- El área de Ventas y de Taller, los roles de vistIA, en el equipo de Argos.
CREATE OR REPLACE VIEW argos.equipo AS
 SELECT u.name AS profesional,
    array_to_string(ARRAY( SELECT
                CASE TRIM(BOTH FROM r.r)
                    WHEN 'owner'::text THEN 'propietario'::text
                    WHEN 'admin'::text THEN 'administración'::text
                    WHEN 'clinician'::text THEN
                    CASE
                        WHEN (op.product = 'medical'::text) THEN 'medicina'::text
                        WHEN (op.product = 'optical'::text) THEN 'optometría'::text
                        ELSE 'odontología'::text
                    END
                    WHEN 'reception'::text THEN 'recepción'::text
                    WHEN 'cashier'::text THEN 'caja'::text
                    WHEN 'sales'::text THEN 'ventas'::text
                    WHEN 'workshop'::text THEN 'taller'::text
                    ELSE 'otro'::text
                END AS "case"
           FROM unnest(string_to_array(m.role, ','::text)) r(r)), ', '::text) AS rol,
    ( SELECT string_agg(s.name, ', '::text ORDER BY s.name) AS string_agg
           FROM (public.professional_specialty ps
             JOIN public.org_specialty s ON (((s.organization_id = ps.organization_id) AND (s.id = ps.specialty_id))))
          WHERE ((ps.organization_id = m.organization_id) AND (ps.user_id = m.user_id))) AS especialidades,
    ((m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'clinician'::text])) AND ((EXISTS ( SELECT 1
           FROM public.professional_schedule s
          WHERE ((s.organization_id = m.organization_id) AND (s.professional_user_id = m.user_id)))) OR (EXISTS ( SELECT 1
           FROM public.appointment a
          WHERE ((a.organization_id = m.organization_id) AND (a.professional_user_id = m.user_id)))))) AS atiende
   FROM ((public.member m
     JOIN auth."user" u ON ((u.id = m.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = m.organization_id)))
  WHERE (m.organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text));
