-- Comisión por servicio, desde el cambio y por sesión (QA de comisiones, entrega 7; ADR 0151).
--
-- 1. `commission_rate`: las versiones de la regla de cada profesional. Solo se agregan filas.
-- 2. La copia de `commission_rule` como primera versión, que vale desde siempre: lo ya cobrado y
--    sin pagar sigue con el porcentaje que tenía. `commission_rule` deja de leerse y escribirse;
--    se borra en otra entrega, ya desplegada esta.
-- 3. `commission_live`: las líneas de comisión aún sin pagar, una sola cuenta para Finanzas,
--    Reportes y Argos. Antes cada uno la escribía por su lado y se separaron más de una vez.
-- 4. `argos.comisiones` lee lo nuevo de esa vista; conserva sus columnas, su dueño y sus GRANT.

-- ═════════════════════════════════════════════════════════════════════════
-- public.commission_rate
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.commission_rate ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.commission_rate FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.commission_rate USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
-- El servicio de una excepción es de la misma clínica.
ALTER TABLE ONLY public.commission_rate
    ADD CONSTRAINT commission_rate_service_id_org_fk FOREIGN KEY (organization_id, service_id) REFERENCES public.service_catalog(organization_id, id);--> statement-breakpoint
-- Una versión no se cambia ni se borra: el cambio es otra versión.
CREATE TRIGGER commission_rate_immutable BEFORE UPDATE ON public.commission_rate FOR EACH ROW EXECUTE FUNCTION public.finance_allow_only();--> statement-breakpoint
CREATE TRIGGER commission_rate_no_delete BEFORE DELETE ON public.commission_rate FOR EACH ROW EXECUTE FUNCTION public.finance_no_delete();--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_rate FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.commission_rate TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.commission_rate TO argos_dueno;--> statement-breakpoint

-- El porcentaje de hoy, como primera versión: vale desde siempre.
INSERT INTO public.commission_rate (organization_id, professional_user_id, service_id, effective_from, rate_bps, created_by, created_at)
SELECT organization_id, professional_user_id, NULL, '-infinity'::timestamptz, rate_bps, created_by, created_at
FROM public.commission_rule;--> statement-breakpoint

-- La vista (de `argos_dueno`) lee los tratamientos para saber de quién es cada sesión.
GRANT SELECT ON TABLE public.treatment_plan_item TO argos_dueno;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- public.commission_live
-- ═════════════════════════════════════════════════════════════════════════
-- Cada cobro en pie de lo que atendió alguien (aplicación sobre el cargo de un procedimiento de
-- una atención finalizada), con su comisión, aún sin pagar:
--
-- - Un cargo de una sola parte es de quien atendió y cuenta el día del cobro (lo de siempre).
-- - Un cargo de un tratamiento de N sesiones (`commission_sessions`) reparte cada cobro en N
--   partes iguales. La parte k es de quien hizo la sesión k (la k-ésima atención finalizada de
--   ese tratamiento) y cuenta el día en que existen las dos cosas, el cobro y la sesión. Sin la
--   sesión k, la parte aún no es de nadie; si el tratamiento quedó realizado con menos sesiones,
--   lo que sobra es de la última.
-- - La regla es la que valía el día del cobro: la excepción del servicio, si hay, y si no el
--   porcentaje general. Un monto fijo es por procedimiento (por la cantidad), en proporción a lo
--   cobrado del cargo y repartido igual entre las partes.
-- - Lo ya pagado no sale: una línea pagada sin parte cubre el cobro entero.
--
-- Es de `argos_dueno`, como las vistas de Argos: lee las tablas con sus permisos y bajo la RLS de
-- la clínica (no tiene BYPASSRLS), así que la aplicación y Argos ven solo la suya. Con
-- `security_invoker` no serviría a Argos: sus llaves no leen tablas, y Postgres revisaría sus
-- permisos y no los del dueño de `argos.comisiones`. El valor va en moneda del negocio con el de
-- su pago; lo viejo en otra moneda sin valor ni factor no entra.
CREATE VIEW public.commission_live AS
 WITH app AS (
         SELECT a.organization_id,
            a.id AS application_id,
            (a.amount_cents)::numeric AS app_cents,
            a.created_at AS cobro_at,
            a.patient_id,
            p.id AS payment_id,
            p.branch_id,
            p.amount_cents AS payment_cents,
            p.business_cents,
            (p.currency)::text AS currency,
            c.id AS charge_id,
            c.description,
            c.promotion_name,
            c.plan_item_id,
            ((c.amount_cents + c.returned_cents))::numeric AS charge_cents,
            (COALESCE(c.commission_sessions, 1))::integer AS sessions,
            ep.service_id,
            ep.quantity,
            e.professional_user_id AS own_user_id
           FROM ((((public.patient_payment_application a
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
             JOIN public.encounter_procedure ep ON (((ep.organization_id = a.organization_id) AND (ep.id = c.encounter_procedure_id))))
             JOIN public.encounter e ON (((e.organization_id = a.organization_id) AND (e.id = ep.encounter_id))))
          WHERE ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL) AND (ep.voided_at IS NULL) AND (e.status = 'finalizada'::text) AND (e.voided_at IS NULL))
        ), sliced AS (
         SELECT app.*,
            NULL::integer AS slice,
            app.own_user_id AS user_id,
            app.cobro_at AS at
           FROM app
          WHERE (app.sessions = 1)
        UNION ALL
         SELECT app.*,
            k.slice,
            s.user_id,
            GREATEST(app.cobro_at, s.done_at) AS at
           FROM ((app
             CROSS JOIN LATERAL generate_series(1, app.sessions) k(slice))
             JOIN LATERAL ( SELECT x.user_id,
                    x.done_at
                   FROM ( SELECT e2.professional_user_id AS user_id,
                            COALESCE(e2.finalized_at, e2.updated_at) AS done_at,
                            row_number() OVER (ORDER BY COALESCE(e2.finalized_at, e2.updated_at), ep2.created_at, ep2.id) AS n,
                            count(*) OVER () AS total
                           FROM (public.encounter_procedure ep2
                             JOIN public.encounter e2 ON (((e2.organization_id = ep2.organization_id) AND (e2.id = ep2.encounter_id))))
                          WHERE ((ep2.organization_id = app.organization_id) AND (ep2.plan_item_id = app.plan_item_id) AND (ep2.voided_at IS NULL) AND (e2.status = 'finalizada'::text) AND (e2.voided_at IS NULL))) x
                  WHERE ((x.n = k.slice) OR ((x.n = x.total) AND (k.slice > x.total) AND (EXISTS ( SELECT 1
                           FROM public.treatment_plan_item ti
                          WHERE ((ti.organization_id = app.organization_id) AND (ti.id = app.plan_item_id) AND (ti.status = 'realizado'::text))))))) s ON (true))
          WHERE (app.sessions > 1)
        ), ruled AS (
         SELECT sl.*,
            g.rate_bps AS general_bps,
            sv.rate_bps AS service_bps,
            sv.fixed_cents AS service_fixed,
            (public.org_money_value(sl.app_cents, (sl.payment_cents)::numeric, (sl.business_cents)::numeric, sl.currency, op.currency, op.second_currency, op.exchange_factor) / (sl.sessions)::numeric) AS value
           FROM (((sliced sl
             LEFT JOIN public.org_profile op ON ((op.organization_id = sl.organization_id)))
             LEFT JOIN LATERAL ( SELECT r.rate_bps
                   FROM public.commission_rate r
                  WHERE ((r.organization_id = sl.organization_id) AND (r.professional_user_id = sl.user_id) AND (r.service_id IS NULL) AND (r.effective_from <= sl.cobro_at))
                  ORDER BY r.effective_from DESC
                 LIMIT 1) g ON (true))
             LEFT JOIN LATERAL ( SELECT r.rate_bps,
                    r.fixed_cents
                   FROM public.commission_rate r
                  WHERE ((r.organization_id = sl.organization_id) AND (r.professional_user_id = sl.user_id) AND (r.service_id = sl.service_id) AND (r.effective_from <= sl.cobro_at))
                  ORDER BY r.effective_from DESC
                 LIMIT 1) sv ON (true))
        )
 SELECT r.organization_id,
    r.application_id,
    r.slice,
    r.sessions,
    r.user_id AS professional_user_id,
    r.at,
    r.cobro_at,
    r.branch_id,
    r.charge_id,
    r.payment_id,
    r.patient_id,
    r.description,
    r.promotion_name,
    r.service_id,
    r.value,
        CASE
            WHEN (r.service_fixed IS NOT NULL) THEN NULL::integer
            ELSE COALESCE(r.service_bps, r.general_bps, 0)
        END AS rate_bps,
    r.service_fixed AS fixed_cents,
    ((r.service_fixed IS NOT NULL) OR (r.service_bps IS NOT NULL)) AS for_service,
        CASE
            WHEN (r.service_fixed IS NOT NULL) THEN floor(((((r.service_fixed)::numeric * (r.quantity)::numeric) * r.app_cents) / (GREATEST(r.charge_cents, (1)::numeric) * (r.sessions)::numeric)))
            ELSE floor(((r.value * (COALESCE(r.service_bps, r.general_bps, 0))::numeric) / (10000)::numeric))
        END AS commission
   FROM ruled r
  WHERE ((r.value IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM (public.commission_settlement_line l
             JOIN public.commission_settlement st ON (((st.organization_id = l.organization_id) AND (st.id = l.settlement_id) AND (st.voided_at IS NULL))))
          WHERE ((l.organization_id = r.organization_id) AND (l.application_id = r.application_id) AND (l.kind = 'cobro'::text) AND (l.voided_at IS NULL) AND ((l.slice IS NULL) OR (l.slice = r.slice)))))));--> statement-breakpoint
ALTER VIEW public.commission_live OWNER TO argos_dueno;--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_live FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public.commission_live FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.commission_live TO dentalagent_app;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- argos.comisiones: lo nuevo, de `commission_live`
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW argos.comisiones AS
 WITH frozen AS (
         SELECT l_1.organization_id,
            (l_1.base_cents)::bigint AS base,
            (l_1.commission_cents)::bigint AS commission,
            l_1.occurred_at AS at,
            s.professional_user_id AS user_id,
            ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL)) AS live,
            p.branch_id
           FROM ((((public.commission_settlement_line l_1
             JOIN public.commission_settlement s ON (((s.organization_id = l_1.organization_id) AND (s.id = l_1.settlement_id) AND (s.voided_at IS NULL))))
             JOIN public.patient_payment_application a ON (((a.organization_id = l_1.organization_id) AND (a.id = l_1.application_id))))
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
          WHERE ((l_1.kind = 'cobro'::text) AND (l_1.voided_at IS NULL))
        ), line AS (
         SELECT f.organization_id,
            f.user_id,
            f.at,
                CASE
                    WHEN f.live THEN (f.base)::numeric
                    ELSE (0)::numeric
                END AS base,
                CASE
                    WHEN f.live THEN (f.commission)::numeric
                    ELSE (0)::numeric
                END AS commission,
            (f.commission)::numeric AS paid,
            (0)::numeric AS fresh,
            f.branch_id
           FROM frozen f
        UNION ALL
         SELECT cl.organization_id,
            cl.professional_user_id,
            cl.at,
            cl.value,
            cl.commission,
            (0)::numeric,
            cl.commission,
            cl.branch_id
           FROM public.commission_live cl
        )
 SELECT l.at AS momento,
    ((l.at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    u.name AS profesional,
    b.name AS sede,
    public.money_major(l.base, op.currency) AS base,
    public.money_major(l.commission, op.currency) AS comision,
    public.money_major(l.paid, op.currency) AS pagado,
    public.money_major(l.fresh, op.currency) AS sin_pagar
   FROM (((line l
     JOIN auth."user" u ON ((u.id = l.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = l.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = l.organization_id) AND (b.id = l.branch_id))));
