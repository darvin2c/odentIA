-- «No se hizo» en una atención firmada (mesa del cierre de la atención, 19 nov 2026).
--
-- 1. El guardia de lo registrado en una atención deja, además de anular en el borrador, marcar
--    como no hecho un procedimiento de una atención ya firmada: solo poner su anulación (fecha,
--    quién y motivo), nada más de la fila, y una sola vez. Lo demás de una firmada sigue sin
--    cambiar, y un diagnóstico no se anula después de firmar.
-- 2. `commission_live` ya no deja fuera el cobro de un procedimiento anulado: manda el cargo, como
--    en Finanzas y Reportes. Antes no hacía falta mirarlo (un procedimiento solo se anulaba en el
--    borrador, sin cargo todavía); con «No se hizo» el cobro ya pagado sigue contando hasta que caja
--    lo devuelve, y la comisión se descuenta el día de la devolución, no meses atrás.

CREATE OR REPLACE FUNCTION public.guard_draft_encounter_child() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS NOT DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
    IF TG_TABLE_NAME = 'encounter_procedure' THEN
      RAISE EXCEPTION 'Un procedimiento registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'resolved_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'resolved_at' - 'updated_at') THEN
      RAISE EXCEPTION 'Un diagnóstico registrado no se modifica: anúlalo en el borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'La anulación es definitiva' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  IF NEW.encounter_id IS NULL THEN
    RAISE EXCEPTION 'Los diagnósticos nuevos se registran en una atención' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  SELECT status INTO current_status FROM encounter WHERE id = NEW.encounter_id AND organization_id = NEW.organization_id;
  -- «No se hizo»: en una firmada, un procedimiento solo recibe su anulación; el resto de la fila no cambia.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'encounter_procedure' AND current_status = 'finalizada'
     AND NEW.voided_at IS NOT NULL
     AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
    RETURN NEW;
  END IF;
  IF current_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'La atención no está en borrador' USING ERRCODE = '23514', CONSTRAINT = 'encounter_child_draft_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE VIEW public.commission_live AS
 WITH app AS (
         SELECT a.organization_id,
            a.id AS application_id,
            (a.amount_cents)::numeric AS app_cents,
            a.created_at AS cobro_at,
            -- El día de la atención: la regla de lo que se cobra de una sola parte.
            COALESCE(e.finalized_at, e.created_at) AS attended_at,
            a.patient_id,
            p.id AS payment_id,
            p.branch_id,
            p.amount_cents AS payment_cents,
            p.business_cents,
            -- Un cobro cancela una sola moneda: la del cargo.
            (p.currency)::text AS currency,
            c.id AS charge_id,
            c.description,
            c.promotion_name,
            c.plan_item_id,
            ((c.amount_cents + c.returned_cents))::numeric AS charge_cents,
            (COALESCE(c.commission_sessions, 1))::integer AS sessions,
            c.commission_sessions AS split_sessions,
            COALESCE(ep.service_id, ti.service_id) AS service_id,
            COALESCE(ep.quantity, 1) AS quantity,
            e.professional_user_id AS own_user_id
           FROM (((((public.patient_payment_application a
             JOIN public.patient_payment p ON (((p.organization_id = a.organization_id) AND (p.id = a.payment_id))))
             JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id))))
             LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = a.organization_id) AND (ep.id = c.encounter_procedure_id))))
             LEFT JOIN public.encounter e ON (((e.organization_id = a.organization_id) AND (e.id = ep.encounter_id))))
             -- Lo adelantado no tiene procedimiento: su servicio es el del tratamiento.
             LEFT JOIN public.treatment_plan_item ti ON (((ti.organization_id = a.organization_id) AND (ti.id = c.plan_item_id) AND (c.encounter_procedure_id IS NULL))))
          WHERE ((a.voided_at IS NULL) AND (p.voided_at IS NULL) AND (c.voided_at IS NULL) AND (
                ((c.encounter_procedure_id IS NOT NULL) AND (e.status = 'finalizada'::text) AND (e.voided_at IS NULL))
             OR ((c.encounter_procedure_id IS NULL) AND (c.commission_sessions IS NOT NULL) AND (c.plan_item_id IS NOT NULL))))
        ), sliced AS (
         -- Una sola parte: el cobro entero, de quien atendió, el día del cobro (lo de siempre).
         -- Por sesiones: la parte k es de la k-ésima atención finalizada del tratamiento (una atención
         -- es una sesión aunque registre el procedimiento dos veces).
         SELECT app.*,
                CASE
                    WHEN (app.split_sessions IS NULL) THEN NULL::integer
                    ELSE k.slice
                END AS slice,
                CASE
                    WHEN (app.split_sessions IS NULL) THEN app.own_user_id
                    ELSE s.user_id
                END AS user_id,
                CASE
                    WHEN (app.split_sessions IS NULL) THEN app.cobro_at
                    ELSE GREATEST(app.cobro_at, s.done_at)
                END AS at,
                -- La regla: la del día de la atención, o la del día de esa sesión.
                CASE
                    WHEN (app.split_sessions IS NULL) THEN app.attended_at
                    ELSE s.session_at
                END AS rule_at
           FROM ((app
             CROSS JOIN LATERAL generate_series(1, app.sessions) k(slice))
             LEFT JOIN LATERAL ( SELECT x.user_id,
                        CASE
                            -- Lo que sobra de un tratamiento realizado con menos sesiones es de la
                            -- última, el día en que se dio por realizado: no reabre un mes cerrado.
                            WHEN (k.slice > x.total) THEN GREATEST(x.done_at, x.completed_at)
                            ELSE x.done_at
                        END AS done_at,
                        x.done_at AS session_at
                   FROM ( SELECT d.user_id,
                            d.done_at,
                            row_number() OVER (ORDER BY d.done_at, d.encounter_id) AS n,
                            count(*) OVER () AS total,
                            ti.status AS item_status,
                            ti.completed_at
                           FROM (( SELECT DISTINCT ON (e2.id) e2.id AS encounter_id,
                                    e2.professional_user_id AS user_id,
                                    COALESCE(e2.finalized_at, e2.created_at) AS done_at
                                   FROM (public.encounter_procedure ep2
                                     JOIN public.encounter e2 ON (((e2.organization_id = ep2.organization_id) AND (e2.id = ep2.encounter_id))))
                                  WHERE ((app.split_sessions IS NOT NULL) AND (ep2.organization_id = app.organization_id) AND (ep2.plan_item_id = app.plan_item_id) AND (ep2.voided_at IS NULL) AND (e2.status = 'finalizada'::text) AND (e2.voided_at IS NULL))
                                  ORDER BY e2.id) d
                             LEFT JOIN public.treatment_plan_item ti ON (((ti.organization_id = app.organization_id) AND (ti.id = app.plan_item_id))))) x
                  WHERE ((x.n = k.slice) OR ((x.n = x.total) AND (k.slice > x.total) AND (x.item_status = 'realizado'::text)))) s ON (true))
          WHERE ((app.split_sessions IS NULL) OR (s.user_id IS NOT NULL))
        ), ruled AS (
         SELECT sl.*,
            g.rate_bps AS general_bps,
            ex.rate_bps AS service_bps,
            ex.fixed_cents AS service_fixed,
            -- El monto fijo vale solo en su moneda (lo guardado antes, sin moneda, es del negocio).
            ((ex.fixed_cents IS NOT NULL) AND (COALESCE(ex.fixed_currency, op.currency::text) = sl.currency)) AS fixed_ok,
            ((ex.fixed_cents IS NOT NULL) AND (COALESCE(ex.fixed_currency, op.currency::text) <> sl.currency)) AS fixed_other,
            (sl.app_cents / (sl.sessions)::numeric) AS own_value,
            (public.org_money_value(sl.app_cents, (sl.payment_cents)::numeric, (sl.business_cents)::numeric, sl.currency, op.currency, op.second_currency, op.exchange_factor) / (sl.sessions)::numeric) AS value,
            op.currency AS business_currency,
            op.second_currency,
            op.exchange_factor
           FROM (((((sliced sl
             LEFT JOIN public.org_profile op ON ((op.organization_id = sl.organization_id)))
             LEFT JOIN LATERAL ( SELECT r.rate_bps
                   FROM public.commission_rate r
                  WHERE ((r.organization_id = sl.organization_id) AND (r.professional_user_id = sl.user_id) AND (r.service_id IS NULL) AND (r.effective_from <= sl.rule_at))
                  ORDER BY r.effective_from DESC
                 LIMIT 1) g ON (true))
             LEFT JOIN LATERAL ( SELECT r.rate_bps,
                    r.fixed_cents,
                    r.fixed_currency,
                    r.effective_from
                   FROM public.commission_rate r
                  WHERE ((r.organization_id = sl.organization_id) AND (r.professional_user_id = sl.user_id) AND (r.service_id = sl.service_id) AND (r.effective_from <= sl.rule_at))
                  ORDER BY r.effective_from DESC
                 LIMIT 1) sv ON (true))
             -- Un monto en otra moneda no vale: la versión que se escribió después para corregirlo
             -- (en esta moneda, un porcentaje o quitarlo) vale también para lo atendido antes. Sin
             -- esto, esa línea quedaría sin regla para siempre.
             LEFT JOIN LATERAL ( SELECT true AS found,
                    r.rate_bps,
                    r.fixed_cents,
                    r.fixed_currency
                   FROM public.commission_rate r
                  WHERE ((sv.fixed_cents IS NOT NULL) AND (COALESCE(sv.fixed_currency, op.currency::text) <> sl.currency) AND (r.organization_id = sl.organization_id) AND (r.professional_user_id = sl.user_id) AND (r.service_id = sl.service_id) AND (r.effective_from > sv.effective_from) AND ((r.fixed_cents IS NULL) OR (COALESCE(r.fixed_currency, op.currency::text) = sl.currency)))
                  ORDER BY r.effective_from
                 LIMIT 1) fx ON (true))
             CROSS JOIN LATERAL ( SELECT
                        CASE WHEN (fx.found IS TRUE) THEN fx.rate_bps ELSE sv.rate_bps END AS rate_bps,
                        CASE WHEN (fx.found IS TRUE) THEN fx.fixed_cents ELSE sv.fixed_cents END AS fixed_cents,
                        CASE WHEN (fx.found IS TRUE) THEN fx.fixed_currency ELSE sv.fixed_currency END AS fixed_currency) ex)
        ), computed AS (
         SELECT r.*,
                CASE
                    -- Un monto por procedimiento (por la cantidad), en proporción a lo cobrado del
                    -- cargo y repartido igual entre las partes; nunca más de lo cobrado de la línea.
                    WHEN r.fixed_ok THEN floor(LEAST(((((r.service_fixed)::numeric * (r.quantity)::numeric) * r.app_cents) / (GREATEST(r.charge_cents, (1)::numeric) * (r.sessions)::numeric)), r.own_value))
                    WHEN r.fixed_other THEN (0)::numeric
                    ELSE floor(((r.own_value * (COALESCE(r.service_bps, r.general_bps, 0))::numeric) / (10000)::numeric))
                END AS own_commission
           FROM ruled r
        )
 SELECT r.organization_id,
    r.application_id,
    r.slice,
    r.sessions,
    -- Nulo en lo de una sola parte: entonces `at` es el día del cobro y se filtra por `cobro_at`,
    -- que la base sí lleva hasta la tabla (con varias sesiones, `at` depende de la sesión).
    r.split_sessions,
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
            WHEN r.fixed_ok THEN NULL::integer
            ELSE COALESCE(r.service_bps, r.general_bps, 0)
        END AS rate_bps,
        CASE
            WHEN r.fixed_ok THEN r.service_fixed
            ELSE NULL::integer
        END AS fixed_cents,
    (r.fixed_ok OR (r.service_bps IS NOT NULL)) AS for_service,
    ((NOT r.fixed_other) AND ((r.general_bps IS NOT NULL) OR (r.service_bps IS NOT NULL) OR r.fixed_ok)) AS has_rule,
    -- En moneda del negocio, con el cambio de su pago: lo que suman Reportes y Argos. Un porcentaje,
    -- sobre el valor de lo cobrado, como siempre (la misma cifra de antes); un monto fijo en otra
    -- moneda, con el cambio de su pago.
        CASE
            WHEN r.fixed_other THEN (0)::numeric
            WHEN (r.currency = (r.business_currency)::text) THEN r.own_commission
            WHEN r.fixed_ok THEN public.org_money_value(r.own_commission, (r.payment_cents)::numeric, (r.business_cents)::numeric, r.currency, r.business_currency, r.second_currency, r.exchange_factor)
            ELSE floor(((r.value * (COALESCE(r.service_bps, r.general_bps, 0))::numeric) / (10000)::numeric))
        END AS commission,
    r.currency,
    r.own_value,
    r.own_commission
   FROM computed r
  WHERE ((r.value IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM (public.commission_settlement_line l
             JOIN public.commission_settlement st ON (((st.organization_id = l.organization_id) AND (st.id = l.settlement_id) AND (st.voided_at IS NULL))))
          WHERE ((l.organization_id = r.organization_id) AND (l.application_id = r.application_id) AND (l.kind = 'cobro'::text) AND (l.voided_at IS NULL) AND ((l.slice IS NULL) OR (l.slice = r.slice)))))));--> statement-breakpoint
