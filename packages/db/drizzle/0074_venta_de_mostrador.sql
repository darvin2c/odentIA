ALTER TABLE "patient_charge" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_return" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_ticket" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD COLUMN "buyer_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_buyer_contact_fk" FOREIGN KEY ("organization_id","buyer_contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_ticket_org_buyer_idx" ON "payment_ticket" USING btree ("organization_id","buyer_contact_id") WHERE "payment_ticket"."buyer_contact_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_counter_check" CHECK ("patient_charge"."patient_id" IS NOT NULL OR ("patient_charge"."product_id" IS NOT NULL AND "patient_charge"."plan_item_id" IS NULL AND "patient_charge"."budget_item_id" IS NULL AND "patient_charge"."encounter_procedure_id" IS NULL AND "patient_charge"."promotion_id" IS NULL AND "patient_charge"."commission_sessions" IS NULL));--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_counter_check" CHECK ("patient_payment"."patient_id" IS NOT NULL OR "patient_payment"."ticket_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "payment_application_counter_check" CHECK ("patient_payment_application"."patient_id" IS NOT NULL OR "patient_payment_application"."ticket_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "payment_refund_counter_check" CHECK ("patient_payment_refund"."patient_id" IS NOT NULL OR "patient_payment_refund"."return_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_counter_check" CHECK ("payment_return"."patient_id" IS NOT NULL OR "payment_return"."outcome" = 'pagado');--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_counter_check" CHECK (("payment_ticket"."patient_id" IS NOT NULL AND "payment_ticket"."buyer_contact_id" IS NULL AND "payment_ticket"."buyer_name" IS NULL) OR ("payment_ticket"."patient_id" IS NULL AND "payment_ticket"."credit_applied_cents" = 0 AND "payment_ticket"."payer_contact_id" IS NULL AND ("payment_ticket"."buyer_contact_id" IS NULL OR "payment_ticket"."buyer_name" IS NULL)));--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_buyer_name_check" CHECK ("payment_ticket"."buyer_name" IS NULL OR ("payment_ticket"."buyer_name" = btrim("payment_ticket"."buyer_name") AND char_length("payment_ticket"."buyer_name") BETWEEN 1 AND 200));--> statement-breakpoint

-- Venta de mostrador (ADR 0170): productos cobrados sin ficha, a un contacto, a un
-- nombre o a nadie. Los checks de arriba dicen lo que cada fila sin paciente puede
-- ser; esto dice con qué se une: lo que no tiene ficha solo se une a lo que tampoco
-- la tiene, para que una venta de mostrador nunca pague ni reciba la cuenta de un
-- paciente (ni su saldo a favor), y lo que se aplica o se devuelve queda en su propio
-- ticket: el pago de una venta no paga ni devuelve lo de otra.
CREATE FUNCTION public.counter_sale_same_party() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ok boolean := true;
BEGIN
  IF TG_TABLE_NAME = 'patient_payment' THEN
    IF NEW.ticket_id IS NOT NULL THEN
      SELECT (t.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
        FROM payment_ticket t WHERE t.organization_id = NEW.organization_id AND t.id = NEW.ticket_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'patient_payment_application' THEN
    SELECT (p.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
      FROM patient_payment p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id;
    IF ok THEN
      SELECT (c.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
        FROM patient_charge c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.charge_id;
    END IF;
    IF ok AND NEW.ticket_id IS NOT NULL THEN
      SELECT (t.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
        FROM payment_ticket t WHERE t.organization_id = NEW.organization_id AND t.id = NEW.ticket_id;
    END IF;
    -- Sin ficha, el pago, lo aplicado y el concepto son de un mismo ticket.
    IF ok AND NEW.patient_id IS NULL THEN
      SELECT p.ticket_id = NEW.ticket_id INTO ok
        FROM patient_payment p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id;
      IF ok AND EXISTS (
        SELECT 1 FROM patient_payment_application a
         WHERE a.organization_id = NEW.organization_id AND a.charge_id = NEW.charge_id AND a.ticket_id <> NEW.ticket_id
      ) THEN
        ok := false;
      END IF;
      IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Lo de una venta de mostrador queda en su propio ticket (%)', TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'patient_payment_refund' THEN
    SELECT (p.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
      FROM patient_payment p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id;
    -- Sin ficha, se devuelve el pago del mismo ticket que se devuelve.
    IF ok AND NEW.patient_id IS NULL THEN
      SELECT p.ticket_id = r.ticket_id INTO ok
        FROM patient_payment p, payment_return r
       WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id
         AND r.organization_id = NEW.organization_id AND r.id = NEW.return_id;
      IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Lo de una venta de mostrador queda en su propio ticket (%)', TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_return' THEN
    SELECT (t.patient_id IS NULL) = (NEW.patient_id IS NULL) INTO ok
      FROM payment_ticket t WHERE t.organization_id = NEW.organization_id AND t.id = NEW.ticket_id;
  END IF;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Una venta de mostrador no se mezcla con la cuenta de un paciente (%)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_payment_counter_sale BEFORE INSERT ON public.patient_payment FOR EACH ROW EXECUTE FUNCTION public.counter_sale_same_party();--> statement-breakpoint
CREATE TRIGGER patient_payment_application_counter_sale BEFORE INSERT ON public.patient_payment_application FOR EACH ROW EXECUTE FUNCTION public.counter_sale_same_party();--> statement-breakpoint
CREATE TRIGGER patient_payment_refund_counter_sale BEFORE INSERT ON public.patient_payment_refund FOR EACH ROW EXECUTE FUNCTION public.counter_sale_same_party();--> statement-breakpoint
CREATE TRIGGER payment_return_counter_sale BEFORE INSERT ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.counter_sale_same_party();--> statement-breakpoint

-- Después tampoco cambia de cuenta: lo del mostrador no pasa a una ficha ni lo de una
-- ficha queda sin ella. Pasar de una ficha a otra sigue como estaba.
CREATE FUNCTION public.counter_sale_stays() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.patient_id IS NULL) <> (NEW.patient_id IS NULL) THEN
    RAISE EXCEPTION 'Una venta de mostrador no cambia de cuenta (%)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_charge_counter_stays BEFORE UPDATE OF patient_id ON public.patient_charge FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint
CREATE TRIGGER patient_payment_counter_stays BEFORE UPDATE OF patient_id ON public.patient_payment FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint
CREATE TRIGGER patient_payment_application_counter_stays BEFORE UPDATE OF patient_id ON public.patient_payment_application FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint
CREATE TRIGGER patient_payment_refund_counter_stays BEFORE UPDATE OF patient_id ON public.patient_payment_refund FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint
CREATE TRIGGER payment_return_counter_stays BEFORE UPDATE OF patient_id ON public.payment_return FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint
CREATE TRIGGER payment_ticket_counter_stays BEFORE UPDATE OF patient_id ON public.payment_ticket FOR EACH ROW EXECUTE FUNCTION public.counter_sale_stays();--> statement-breakpoint

-- Argos ve la venta de mostrador como lo demás que se cobró: sus vistas de dinero ya
-- no la pierden al unirse con la ficha. Sin ficha, «paciente» dice «Venta de
-- mostrador» y `paciente_id` es nulo; el nombre que se escribió no entra (Argos no
-- lee texto libre). Mismas columnas, mismo orden y mismos GRANT.
CREATE OR REPLACE VIEW argos.cobros AS
SELECT x.momento, (x.momento AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, x.tipo,
  public.money_major(public.org_money_value(x.cents, x.amount, x.business, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
  x.medio, b.name AS sede, CASE WHEN x.patient_id IS NULL THEN 'Venta de mostrador'::text ELSE pp.display_name END AS paciente, x.patient_id AS paciente_id,
  public.money_major(public.org_money_value(x.tax_cents, x.amount, x.business, x.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS impuesto,
  CASE WHEN x.entered_currency <> op.currency THEN public.money_major(x.entered, x.entered_currency) END AS importe_otra_moneda,
  CASE WHEN x.entered_currency <> op.currency THEN x.entered_currency END AS otra_moneda
FROM (
  SELECT pay.organization_id, pay.paid_at AS momento, 'pago' AS tipo, pay.amount_cents AS cents, pay.method_name AS medio, pay.branch_id, pay.patient_id,
    pay.tax_cents, pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, COALESCE(pay.tender_cents, pay.amount_cents)::numeric AS entered, COALESCE(pay.tender_currency, pay.currency)::text AS entered_currency
  FROM public.patient_payment pay
  UNION ALL
  SELECT pay.organization_id, pay.voided_at, 'anulacion', -pay.amount_cents, pay.method_name, pay.branch_id, pay.patient_id, -pay.tax_cents,
    pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, -COALESCE(pay.tender_cents, pay.amount_cents)::numeric, COALESCE(pay.tender_currency, pay.currency)::text
  FROM public.patient_payment pay WHERE pay.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.refunded_at, 'devolucion', -r.amount_cents, pay.method_name, pay.branch_id, r.patient_id, -r.tax_cents,
    pay.amount_cents AS amount, pay.business_cents AS business, pay.currency::text AS currency, -COALESCE(r.tender_cents, r.amount_cents)::numeric, COALESCE(pay.tender_currency, pay.currency)::text
  FROM public.patient_payment_refund r JOIN public.patient_payment pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
) x
LEFT JOIN public.patient p ON p.organization_id = x.organization_id AND p.id = x.patient_id
LEFT JOIN public.contact pp ON pp.organization_id = p.organization_id AND pp.id = p.person_id
LEFT JOIN public.org_profile op ON op.organization_id = x.organization_id
LEFT JOIN public.branch b ON b.organization_id = x.organization_id AND b.id = x.branch_id;--> statement-breakpoint

CREATE OR REPLACE VIEW argos.pagos_por_venta AS
 SELECT pay.paid_at AS pagado_en,
    ((pay.paid_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    public.money_major(public.org_money_value(a.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    u.name AS profesional,
    b.name AS sede,
    CASE WHEN c.patient_id IS NULL THEN 'Venta de mostrador'::text ELSE pp.display_name END AS paciente,
    c.patient_id AS paciente_id,
    pay.method_name AS medio,
    c.id AS venta_id,
    os.name AS especialidad,
    CASE WHEN COALESCE(pay.tender_currency, pay.currency)::text <> op.currency THEN public.money_major(COALESCE(pay.tender_cents, pay.amount_cents)::numeric * a.amount_cents / NULLIF(pay.amount_cents, 0), COALESCE(pay.tender_currency, pay.currency)::text) END AS importe_otra_moneda,
    CASE WHEN COALESCE(pay.tender_currency, pay.currency)::text <> op.currency THEN COALESCE(pay.tender_currency, pay.currency)::text END AS otra_moneda
   FROM ((((((((((((((((public.patient_payment_application a
     JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
     JOIN public.patient_charge c ON (((c.organization_id = a.organization_id) AND (c.id = a.charge_id) AND (c.voided_at IS NULL))))
     LEFT JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     LEFT JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = a.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
  WHERE (a.voided_at IS NULL);--> statement-breakpoint

CREATE OR REPLACE VIEW argos.tickets AS
 SELECT t.ticket_number AS numero,
    t.created_at AS emitido_en,
    ((t.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    b.name AS sede,
    CASE WHEN t.patient_id IS NULL THEN 'Venta de mostrador'::text ELSE pp.display_name END AS paciente,
    t.patient_id AS paciente_id,
    public.money_major(CASE WHEN t.currency = op.currency THEN (t.total_cents)::numeric ELSE public.org_money_value(t.total_cents, paid.amount, paid.business, t.currency, op.currency, op.second_currency, op.exchange_factor) END, op.currency) AS total,
    public.money_major(CASE WHEN t.currency = op.currency THEN (t.credit_applied_cents)::numeric ELSE public.org_money_value(t.credit_applied_cents, paid.amount, paid.business, t.currency, op.currency, op.second_currency, op.exchange_factor) END, op.currency) AS a_favor_usado,
    (t.voided_at IS NOT NULL) AS anulado,
    CASE WHEN t.currency <> op.currency THEN public.money_major(t.total_cents, t.currency) END AS total_otra_moneda,
    CASE WHEN t.currency::text <> op.currency THEN t.currency::text END AS otra_moneda
   FROM (((((public.payment_ticket t
     LEFT JOIN public.patient p ON (((p.organization_id = t.organization_id) AND (p.id = t.patient_id))))
     LEFT JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = t.organization_id)))
     LEFT JOIN public.branch b ON (((b.organization_id = t.organization_id) AND (b.id = t.branch_id))))
     LEFT JOIN LATERAL ( SELECT sum(pay.amount_cents) AS amount, sum(pay.business_cents) AS business
           FROM public.patient_payment pay
          WHERE ((t.currency <> op.currency) AND (pay.organization_id = t.organization_id) AND (pay.ticket_id = t.id))) paid ON (true));--> statement-breakpoint

CREATE OR REPLACE VIEW argos.ventas AS
 SELECT c.id AS venta_id,
    c.created_at AS cargado_en,
    ((c.created_at AT TIME ZONE COALESCE(op.timezone, 'UTC'::text)))::date AS dia,
    c.patient_id AS paciente_id,
    CASE WHEN c.patient_id IS NULL THEN 'Venta de mostrador'::text ELSE pp.display_name END AS paciente,
    COALESCE(sep.name, spi.name, pr.name, c.description) AS concepto,
        CASE
            WHEN (c.product_id IS NULL) THEN 'tratamiento'::text
            ELSE 'producto'::text
        END AS tipo,
    COALESCE(c.product_quantity, (ep.quantity)::integer, 1) AS cantidad,
    public.money_major(COALESCE(ap.value, (0)::numeric) + public.org_money_value(c.amount_cents - COALESCE(ap.cents, (0)::bigint), NULL, NULL, c.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS importe,
    public.money_major(COALESCE(ap.value, (0)::numeric), op.currency) AS pagado,
    public.money_major(public.org_money_value(c.amount_cents - COALESCE(ap.cents, (0)::bigint), NULL, NULL, c.currency, op.currency, op.second_currency, op.exchange_factor), op.currency) AS saldo,
    b.name AS sede,
    u.name AS profesional,
    c.promotion_name AS promocion,
    os.name AS especialidad,
    CASE WHEN c.currency <> op.currency THEN public.money_major(c.amount_cents, c.currency) END AS importe_otra_moneda,
    CASE WHEN c.currency::text <> op.currency THEN c.currency::text END AS otra_moneda
   FROM (((((((((((((((public.patient_charge c
     LEFT JOIN public.patient p ON (((p.organization_id = c.organization_id) AND (p.id = c.patient_id))))
     LEFT JOIN public.contact pp ON (((pp.organization_id = p.organization_id) AND (pp.id = p.person_id))))
     LEFT JOIN public.org_profile op ON ((op.organization_id = c.organization_id)))
     LEFT JOIN public.encounter_procedure ep ON (((ep.organization_id = c.organization_id) AND (ep.id = c.encounter_procedure_id))))
     LEFT JOIN public.encounter e ON (((e.organization_id = c.organization_id) AND (e.id = ep.encounter_id))))
     LEFT JOIN auth."user" u ON ((u.id = e.professional_user_id)))
     LEFT JOIN public.service_catalog sep ON (((sep.organization_id = c.organization_id) AND (sep.id = ep.service_id))))
     LEFT JOIN public.treatment_plan_item pi ON (((pi.organization_id = c.organization_id) AND (pi.id = c.plan_item_id))))
     LEFT JOIN public.service_catalog spi ON (((spi.organization_id = c.organization_id) AND (spi.id = pi.service_id))))
     LEFT JOIN public.product pr ON (((pr.organization_id = c.organization_id) AND (pr.id = c.product_id))))
     LEFT JOIN public.branch b ON (((b.organization_id = c.organization_id) AND (b.id = c.branch_id))))
     LEFT JOIN public.treatment_budget_item bi ON (((bi.organization_id = c.organization_id) AND (bi.id = c.budget_item_id))))
     LEFT JOIN public.service_catalog sx ON (((sx.organization_id = c.organization_id) AND (sx.id = COALESCE(ep.service_id, bi.service_id, pi.service_id)))))
     LEFT JOIN public.org_specialty os ON (((os.organization_id = sx.organization_id) AND (os.id = sx.specialty_id))))
     LEFT JOIN LATERAL ( SELECT sum(a.amount_cents) AS cents,
            sum(public.org_money_value(a.amount_cents, pay.amount_cents, pay.business_cents, pay.currency, op.currency, op.second_currency, op.exchange_factor)) AS value
           FROM (public.patient_payment_application a
             JOIN public.patient_payment pay ON (((pay.organization_id = a.organization_id) AND (pay.id = a.payment_id) AND (pay.voided_at IS NULL))))
          WHERE ((a.organization_id = c.organization_id) AND (a.charge_id = c.id) AND (a.voided_at IS NULL))) ap ON (true))
  WHERE (c.voided_at IS NULL);
