ALTER TABLE "admin"."saas_demo" DROP CONSTRAINT "saas_demo_product_check";--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" DROP CONSTRAINT "treatment_template_product_check";--> statement-breakpoint
ALTER TABLE "org_profile" DROP CONSTRAINT "org_profile_product_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" DROP CONSTRAINT "saas_plan_product_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" DROP CONSTRAINT "saas_waitlist_request_product_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_signup_policy" ADD COLUMN "optical_mode" text DEFAULT 'invitacion' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_demo" ADD CONSTRAINT "saas_demo_product_check" CHECK ("admin"."saas_demo"."product" IN ('dental','medical','optical'));--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template" ADD CONSTRAINT "treatment_template_product_check" CHECK ("catalog"."treatment_template"."product" IN ('dental','medical','optical'));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_product_check" CHECK ("org_profile"."product" IN ('dental','medical','optical'));--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD CONSTRAINT "saas_plan_product_check" CHECK ("admin"."saas_plan"."product" IN ('dental','medical','optical'));--> statement-breakpoint
ALTER TABLE "admin"."saas_signup_policy" ADD CONSTRAINT "saas_signup_policy_optical_mode_check" CHECK ("admin"."saas_signup_policy"."optical_mode" IN ('invitacion','abierta'));--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_product_check" CHECK ("admin"."saas_waitlist_request"."product" IN ('dental','medical','optical'));--> statement-breakpoint

-- vistIA: lo que la base decide por producto también dice algo de las ópticas
-- (`product-sql.test.ts`).

-- «¿Pagó?» del embudo: una óptica, como un consultorio, no presenta presupuestos; cuenta que vino y pagó algo.
CREATE OR REPLACE VIEW argos.embudo AS
 WITH first_inbound AS (
         SELECT DISTINCT ON (c.organization_id, c.contact_id) c.organization_id,
            c.contact_id,
            fi.created_at AS at,
            cc.channel
           FROM ((public.conversation c
             JOIN LATERAL ( SELECT m.created_at
                   FROM public.message m
                  WHERE ((m.organization_id = c.organization_id) AND (m.conversation_id = c.id) AND (m.direction = 'in'::text))
                  ORDER BY m.created_at, m.id
                 LIMIT 1) fi ON (true))
             LEFT JOIN public.channel_connection cc ON (((cc.organization_id = c.organization_id) AND (cc.id = c.channel_connection_id))))
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM public.contact s
                  WHERE ((s.organization_id = c.organization_id) AND (s.id = c.contact_id) AND (s.screen IS NOT NULL)))))
          ORDER BY c.organization_id, c.contact_id, fi.created_at, c.id
        ), registered AS (
         SELECT p.organization_id,
            p.id AS patient_id,
            p.person_id,
            p.created_at,
            r_1.conversation_id,
            NULLIF(COALESCE(r_1.context_contact_id, rc.contact_id), p.person_id) AS writer_id,
                CASE
                    WHEN ((r_1.entry_point = ANY (ARRAY['public_link'::text, 'qr'::text])) OR ((r_1.entry_point = 'conversation'::text) AND (r_1.actor_user_id IS NULL))) THEN 'registro_en_linea'::text
                    ELSE 'recepcion'::text
                END AS registered_via
           FROM ((public.patient p
             LEFT JOIN public.patient_registration r_1 ON (((r_1.organization_id = p.organization_id) AND (r_1.patient_id = p.id))))
             LEFT JOIN public.conversation rc ON (((rc.organization_id = r_1.organization_id) AND (rc.id = r_1.conversation_id))))
        ), first_contact AS (
         SELECT g.organization_id,
            g.person_id,
            g.patient_id,
            k.at AS first_at,
            k.channel
           FROM (((registered g
             LEFT JOIN first_inbound own ON (((own.organization_id = g.organization_id) AND (own.contact_id = g.person_id))))
             LEFT JOIN LATERAL ( SELECT m.created_at AS at,
                    wcc.channel
                   FROM ((public.message m
                     JOIN public.conversation wc ON (((wc.organization_id = m.organization_id) AND (wc.id = m.conversation_id))))
                     LEFT JOIN public.channel_connection wcc ON (((wcc.organization_id = wc.organization_id) AND (wcc.id = wc.channel_connection_id))))
                  WHERE ((g.writer_id IS NOT NULL) AND (m.organization_id = g.organization_id) AND (m.conversation_id = g.conversation_id) AND (m.direction = 'in'::text) AND (m.created_at <= g.created_at) AND (m.created_at > (g.created_at - make_interval(days => 30))) AND (NOT (EXISTS ( SELECT 1
                           FROM public.contact s
                          WHERE ((s.organization_id = wc.organization_id) AND (s.id = wc.contact_id) AND (s.screen IS NOT NULL))))))
                  ORDER BY m.created_at, m.id
                 LIMIT 1) w ON (true))
             CROSS JOIN LATERAL ( SELECT x.at,
                    x.channel
                   FROM ( VALUES (own.at,own.channel,0), (w.at,w.channel,1), (g.created_at,g.registered_via,2)) x(at, channel, rank)
                  WHERE (x.at IS NOT NULL)
                  ORDER BY x.at, x.rank
                 LIMIT 1) k)
        UNION ALL
         SELECT i.organization_id,
            i.contact_id,
            NULL::uuid AS uuid,
            i.at,
            i.channel
           FROM first_inbound i
          WHERE ((NOT (EXISTS ( SELECT 1
                   FROM public.patient p
                  WHERE ((p.organization_id = i.organization_id) AND (p.person_id = i.contact_id))))) AND (NOT (EXISTS ( SELECT 1
                   FROM public.patient_contact v
                  WHERE ((v.organization_id = i.organization_id) AND (v.contact_id = i.contact_id) AND (v.relationship <> 'self'::text))))) AND (NOT (EXISTS ( SELECT 1
                   FROM registered g
                  WHERE ((g.organization_id = i.organization_id) AND (g.writer_id = i.contact_id))))))
        ), reached AS (
         SELECT k.organization_id,
            k.person_id,
            k.patient_id,
            k.first_at,
            k.channel,
            (EXISTS ( SELECT 1
                   FROM public.appointment a
                  WHERE ((a.organization_id = k.organization_id) AND (a.patient_id = k.patient_id) AND (a.created_at >= k.first_at) AND (a.status <> 'cancelada'::text)))) AS booked,
            ((EXISTS ( SELECT 1
                   FROM public.appointment a
                  WHERE ((a.organization_id = k.organization_id) AND (a.patient_id = k.patient_id) AND (a.created_at >= k.first_at) AND (a.status = 'atendida'::text)))) OR (EXISTS ( SELECT 1
                   FROM public.encounter e
                  WHERE ((e.organization_id = k.organization_id) AND (e.patient_id = k.patient_id) AND (e.status = 'finalizada'::text) AND (e.finalized_at >= k.first_at))))) AS came,
            (EXISTS ( SELECT 1
                   FROM public.treatment_budget b
                  WHERE ((b.organization_id = k.organization_id) AND (b.patient_id = k.patient_id) AND (b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text, 'presentado'::text, 'pospuesto'::text, 'rechazado'::text])) AND (b.presented_at >= k.first_at)))) AS budget,
            (EXISTS ( SELECT 1
                   FROM public.treatment_budget b
                  WHERE ((b.organization_id = k.organization_id) AND (b.patient_id = k.patient_id) AND (b.status = ANY (ARRAY['aceptado'::text, 'parcial'::text])) AND (b.presented_at >= k.first_at)))) AS accepted,
            (EXISTS ( SELECT 1
                   FROM public.patient_payment y
                  WHERE ((y.organization_id = k.organization_id) AND (y.patient_id = k.patient_id) AND (y.voided_at IS NULL) AND (y.paid_at >= k.first_at)))) AS paid
           FROM first_contact k
        )
 SELECT r.first_at AS primer_contacto_en,
    ((r.first_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    r.channel AS canal,
    pp.display_name AS persona,
    r.person_id AS persona_id,
    r.patient_id AS paciente_id,
    (r.booked OR r.came OR r.budget) AS agendo,
    (r.came OR r.budget) AS vino,
    r.budget AS recibio_presupuesto,
    r.accepted AS acepto,
        CASE
            WHEN (op.product = ANY (ARRAY['medical'::text, 'optical'::text])) THEN ((r.came OR r.budget) AND r.paid)
            ELSE (r.accepted AND r.paid)
        END AS pago
   FROM ((reached r
     JOIN public.contact pp ON (((pp.organization_id = r.organization_id) AND (pp.id = r.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = r.organization_id)));--> statement-breakpoint

-- El área de quien atiende en una óptica: optometría.
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
  WHERE (m.organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text));--> statement-breakpoint

-- Las condiciones de pago con que nace una óptica: las de un consultorio, por atención.
CREATE OR REPLACE FUNCTION public.org_profile_budget_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.product IN ('medical', 'optical') AND NEW.budget_payment_terms = 'Cada tratamiento se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.' THEN
    NEW.budget_payment_terms := 'Cada atención se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.';
  END IF;
  RETURN NEW;
END;
$$;
