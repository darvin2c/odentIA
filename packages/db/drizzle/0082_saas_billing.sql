-- Facturación SaaS: planes por moneda, suscripción con
-- prueba/gracia/pausa, cargos, pagos con comprobante privado, comisiones de
-- vendedor y avisos persistidos. Tablas globales sin RLS (solo owner las
-- escribe; el rol app solo lee planes y métodos activos). Tablas de tenant
-- con RLS por organización e inmutabilidad reforzada en DB.
--> statement-breakpoint
CREATE TABLE "saas_plan" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "currency" char(3) NOT NULL,
  "price_cents" integer NOT NULL,
  "billing_period" text DEFAULT 'mensual' NOT NULL,
  "max_branches" integer,
  "max_seats" integer,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "saas_plan_code_uidx" UNIQUE("code"),
  CONSTRAINT "saas_plan_price_check" CHECK ("price_cents" >= 0),
  CONSTRAINT "saas_plan_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "saas_plan_code_check" CHECK (length(trim("code")) BETWEEN 1 AND 80),
  CONSTRAINT "saas_plan_limits_check" CHECK (
    ("max_branches" IS NULL OR "max_branches" > 0)
    AND ("max_seats" IS NULL OR "max_seats" > 0)
  )
);
--> statement-breakpoint
CREATE INDEX "saas_plan_currency_active_idx" ON "saas_plan" USING btree ("currency","is_active");--> statement-breakpoint
CREATE TABLE "saas_payment_method" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "code" text NOT NULL, "name" text NOT NULL, "instructions" text, "is_active" boolean DEFAULT true NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_payment_method_code_uidx" UNIQUE("code"), CONSTRAINT "saas_payment_method_code_check" CHECK (length(trim("saas_payment_method"."code")) BETWEEN 1 AND 80), CONSTRAINT "saas_payment_method_name_check" CHECK (length(trim("saas_payment_method"."name")) BETWEEN 1 AND 120));--> statement-breakpoint
CREATE TABLE "saas_seller" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" text REFERENCES "user"("id"), "display_name" text NOT NULL, "rate_bps" integer NOT NULL, "window_days" integer DEFAULT 90 NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_seller_user_uidx" UNIQUE("user_id"), CONSTRAINT "saas_seller_rate_check" CHECK ("saas_seller"."rate_bps" BETWEEN 0 AND 10000), CONSTRAINT "saas_seller_window_check" CHECK ("saas_seller"."window_days" BETWEEN 0 AND 730));--> statement-breakpoint
CREATE TABLE "saas_subscription" ("organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE, "plan_id" uuid REFERENCES "saas_plan"("id"), "status" text DEFAULT 'prueba' NOT NULL, "is_demo" boolean DEFAULT false NOT NULL, "trial_started_at" timestamp with time zone, "trial_ends_at" timestamp with time zone, "current_period_start" timestamp with time zone, "current_period_end" timestamp with time zone, "grace_ends_at" timestamp with time zone, "restrict_reason" text, "pause_reason" text, "proof_extension_until" timestamp with time zone, "proof_extension_count" integer DEFAULT 0 NOT NULL, "seller_id" uuid REFERENCES "saas_seller"("id"), "billing_email" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_subscription_status_check" CHECK ("saas_subscription"."status" IN ('prueba','activa','gracia','restringida','pausada','cancelada')));--> statement-breakpoint
CREATE INDEX "saas_subscription_status_idx" ON "saas_subscription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "saas_subscription_period_end_idx" ON "saas_subscription" USING btree ("current_period_end");--> statement-breakpoint
CREATE TABLE "saas_charge" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "plan_id" uuid REFERENCES "saas_plan"("id"), "plan_code" text NOT NULL, "plan_name" text NOT NULL, "period_start" timestamp with time zone NOT NULL, "period_end" timestamp with time zone NOT NULL, "amount_cents" integer NOT NULL, "currency" char(3) NOT NULL, "paid_cents" integer DEFAULT 0 NOT NULL, "status" text DEFAULT 'pendiente' NOT NULL, "due_at" timestamp with time zone, "created_by" text REFERENCES "user"("id"), "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "voided_at" timestamp with time zone, "voided_by" text REFERENCES "user"("id"), "void_reason" text, CONSTRAINT "saas_charge_org_id_uidx" UNIQUE("organization_id","id"), CONSTRAINT "saas_charge_amount_check" CHECK ("saas_charge"."amount_cents" >= 0), CONSTRAINT "saas_charge_paid_check" CHECK ("saas_charge"."paid_cents" >= 0), CONSTRAINT "saas_charge_status_check" CHECK ("saas_charge"."status" IN ('pendiente','parcial','pagada','reversada','anulada')));--> statement-breakpoint
CREATE INDEX "saas_charge_org_status_idx" ON "saas_charge" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "saas_charge_org_period_idx" ON "saas_charge" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE TABLE "saas_payment" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "charge_id" uuid, "amount_cents" integer NOT NULL, "currency" char(3) NOT NULL, "method_code" text NOT NULL, "status" text DEFAULT 'pendiente' NOT NULL, "receipt_object_key" text, "receipt_filename" text, "receipt_mime" text, "receipt_size" integer, "idempotency_key" text NOT NULL, "notes" text, "created_by" text REFERENCES "user"("id"), "confirmed_at" timestamp with time zone, "confirmed_by" text REFERENCES "user"("id"), "reversed_at" timestamp with time zone, "reversed_by" text REFERENCES "user"("id"), "reverse_reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_payment_org_id_uidx" UNIQUE("organization_id","id"), CONSTRAINT "saas_payment_org_key_uidx" UNIQUE("organization_id","idempotency_key"), CONSTRAINT "saas_payment_amount_check" CHECK ("saas_payment"."amount_cents" > 0), CONSTRAINT "saas_payment_status_check" CHECK ("saas_payment"."status" IN ('pendiente','confirmado','reversado','devuelto')), FOREIGN KEY ("organization_id","charge_id") REFERENCES "saas_charge"("organization_id","id"));--> statement-breakpoint
CREATE INDEX "saas_payment_org_charge_idx" ON "saas_payment" USING btree ("organization_id","charge_id");--> statement-breakpoint
CREATE INDEX "saas_payment_org_status_idx" ON "saas_payment" USING btree ("organization_id","status");--> statement-breakpoint
CREATE TABLE "saas_seller_commission" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "payment_id" uuid, "seller_id" uuid NOT NULL REFERENCES "saas_seller"("id"), "rate_bps" integer NOT NULL, "window_days" integer NOT NULL, "base_cents" integer NOT NULL, "commission_cents" integer NOT NULL, "currency" char(3) NOT NULL, "adjustable_until" timestamp with time zone NOT NULL, "status" text DEFAULT 'pendiente' NOT NULL, "settled_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_seller_commission_payment_uidx" UNIQUE("payment_id"), CONSTRAINT "saas_seller_commission_amount_check" CHECK ("saas_seller_commission"."commission_cents" >= 0), CONSTRAINT "saas_seller_commission_status_check" CHECK ("saas_seller_commission"."status" IN ('pendiente','liquidada','ajustada')), FOREIGN KEY ("organization_id","payment_id") REFERENCES "saas_payment"("organization_id","id"));--> statement-breakpoint
CREATE INDEX "saas_seller_commission_seller_status_idx" ON "saas_seller_commission" USING btree ("seller_id","status");--> statement-breakpoint
CREATE TABLE "saas_commission_adjustment" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "commission_id" uuid NOT NULL REFERENCES "saas_seller_commission"("id"), "payment_id" uuid, "seller_id" uuid NOT NULL REFERENCES "saas_seller"("id"), "amount_cents" integer NOT NULL, "currency" char(3) NOT NULL, "reason" text NOT NULL, "created_by" text REFERENCES "user"("id"), "applied_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_commission_adjustment_amount_check" CHECK ("saas_commission_adjustment"."amount_cents" > 0));--> statement-breakpoint
CREATE TABLE "saas_commission_settlement" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "seller_id" uuid NOT NULL REFERENCES "saas_seller"("id"), "period_year" integer NOT NULL, "period_month" integer NOT NULL, "currency" char(3) NOT NULL, "gross_cents" integer DEFAULT 0 NOT NULL, "adjustment_cents" integer DEFAULT 0 NOT NULL, "total_cents" integer DEFAULT 0 NOT NULL, "status" text DEFAULT 'liquidada' NOT NULL, "notes" text, "settled_by" text REFERENCES "user"("id"), "settled_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "voided_at" timestamp with time zone, "voided_by" text REFERENCES "user"("id"), "void_reason" text, CONSTRAINT "saas_settlement_month_check" CHECK ("saas_commission_settlement"."period_month" BETWEEN 1 AND 12), CONSTRAINT "saas_settlement_status_check" CHECK ("saas_commission_settlement"."status" IN ('liquidada','anulada')));--> statement-breakpoint
CREATE INDEX "saas_settlement_seller_period_idx" ON "saas_commission_settlement" USING btree ("seller_id","period_year","period_month");--> statement-breakpoint
CREATE TABLE "saas_commission_settlement_line" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "settlement_id" uuid NOT NULL REFERENCES "saas_commission_settlement"("id") ON DELETE CASCADE, "kind" text DEFAULT 'cobro' NOT NULL, "source_key" text NOT NULL, "commission_id" uuid REFERENCES "saas_seller_commission"("id"), "adjustment_id" uuid REFERENCES "saas_commission_adjustment"("id"), "organization_id" text REFERENCES "organization"("id"), "description" text NOT NULL, "amount_cents" integer NOT NULL, "currency" char(3) NOT NULL, "occurred_at" timestamp with time zone NOT NULL, CONSTRAINT "saas_settlement_line_source_uidx" UNIQUE("source_key"), CONSTRAINT "saas_settlement_line_kind_check" CHECK ("saas_commission_settlement_line"."kind" IN ('cobro','ajuste')));--> statement-breakpoint
CREATE INDEX "saas_settlement_line_settlement_idx" ON "saas_commission_settlement_line" USING btree ("settlement_id");--> statement-breakpoint
CREATE TABLE "saas_notice" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "kind" text NOT NULL, "dedupe_key" text NOT NULL, "sent_at" timestamp with time zone, "email_to" text, "emailed_at" timestamp with time zone, "email_state" text DEFAULT 'pendiente' NOT NULL, "metadata" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_notice_dedupe_uidx" UNIQUE("organization_id","dedupe_key"), CONSTRAINT "saas_notice_email_state_check" CHECK ("saas_notice"."email_state" IN ('pendiente','reclamado','enviado','incierto')));--> statement-breakpoint
CREATE TABLE "saas_usage_daily" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" text NOT NULL REFERENCES "organization"("id"), "day" date NOT NULL, "agent_runs" integer DEFAULT 0 NOT NULL, "llm_calls" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "saas_usage_org_day_uidx" UNIQUE("organization_id","day"));--> statement-breakpoint
-- RLS por tenant: las tablas con organization_id solo ven la org del GUC.
--> statement-breakpoint
ALTER TABLE "saas_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_subscription" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_charge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_charge" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_charge" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_payment" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_seller_commission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_seller_commission" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_seller_commission" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_commission_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_commission_adjustment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_commission_adjustment" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_notice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_notice" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_notice" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "saas_usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saas_usage_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_usage_daily" USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- Rol app: CRUD de tenant salvo borrado; globales de sólo lectura segura.
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "saas_subscription", "saas_charge", "saas_payment", "saas_seller_commission", "saas_commission_adjustment", "saas_notice", "saas_usage_daily" TO dentalagent_app;--> statement-breakpoint
REVOKE DELETE ON "saas_subscription", "saas_charge", "saas_payment", "saas_seller_commission", "saas_commission_adjustment", "saas_notice", "saas_usage_daily" FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT ON "saas_plan", "saas_payment_method", "saas_seller" TO dentalagent_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "saas_plan", "saas_payment_method", "saas_seller", "saas_commission_settlement", "saas_commission_settlement_line" FROM dentalagent_app;--> statement-breakpoint
-- Históricos inmutables: cargos, pagos y comisiones no se reescriben ni borran por app.
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "saas_seller_commission", "saas_commission_settlement_line" FROM dentalagent_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION saas_charge_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.plan_code IS DISTINCT FROM NEW.plan_code
    OR OLD.period_start IS DISTINCT FROM NEW.period_start
    OR OLD.period_end IS DISTINCT FROM NEW.period_end THEN
    RAISE EXCEPTION 'Cargo SaaS inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_charge_immutable ON "saas_charge";--> statement-breakpoint
CREATE TRIGGER saas_charge_immutable
  BEFORE UPDATE ON "saas_charge"
  FOR EACH ROW EXECUTE FUNCTION saas_charge_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION saas_payment_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.charge_id IS DISTINCT FROM NEW.charge_id
    OR OLD.receipt_object_key IS DISTINCT FROM NEW.receipt_object_key THEN
    RAISE EXCEPTION 'Pago SaaS inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_payment_immutable ON "saas_payment";--> statement-breakpoint
CREATE TRIGGER saas_payment_immutable
  BEFORE UPDATE ON "saas_payment"
  FOR EACH ROW EXECUTE FUNCTION saas_payment_immutable();
--> statement-breakpoint
-- Garantía transaccional del alta: cada organización nace con su prueba de
-- 14 días en la misma transacción (databaseHooks de Better Auth no cubre el
-- modelo organization). El servicio `startSaasTrial` solo rellena plan y
-- datos en esa fila. Las organizaciones previas conservan su acceso sin
-- facturación ni restricción hasta asignación explícita de suscripción.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION saas_trial_on_org_create() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "saas_subscription"
    ("organization_id", "status", "is_demo", "trial_started_at", "trial_ends_at",
     "current_period_start", "current_period_end", "proof_extension_count")
  VALUES
    (NEW.id, 'prueba', false, now(), now() + make_interval(days => 14),
     now(), now() + make_interval(days => 14), 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_trial_on_org_create ON "organization";--> statement-breakpoint
CREATE TRIGGER saas_trial_on_org_create
  AFTER INSERT ON "organization"
  FOR EACH ROW EXECUTE FUNCTION saas_trial_on_org_create();
--> statement-breakpoint
-- Tope de personas reforzado en DB (el chequeo pre-auth tiene race con dos
-- invitaciones concurrentes): serializa por organización y cuenta la UNIÓN
-- por correo de miembros e invitaciones pendientes, excluyendo el correo que
-- se suma. Aceptar al límite exacto pasa porque el asiento ya lo reserva su
-- invitación; invitar un correo nuevo suma uno. Sin doble conteo en ningún
-- orden. Fail-open sin suscripción (legado exento), en demo o sin tope.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION saas_seat_cap_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sub_row RECORD;
  plan_cap integer;
  used_count integer;
  newcomer text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('saas-seats:' || NEW.organization_id));
  SELECT * INTO sub_row FROM "saas_subscription" WHERE "organization_id" = NEW.organization_id;
  IF NOT FOUND OR sub_row.is_demo THEN
    RETURN NEW;
  END IF;
  IF sub_row.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "max_seats" INTO plan_cap FROM "saas_plan" WHERE "id" = sub_row.plan_id;
  IF plan_cap IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'member' THEN
    SELECT lower("email") INTO newcomer FROM "user" WHERE "id" = NEW.user_id;
  ELSE
    newcomer := lower(trim(NEW.email));
  END IF;
  SELECT count(*) INTO used_count FROM (
    SELECT lower("u"."email") AS "email" FROM "member" AS "m"
      JOIN "user" AS "u" ON "u"."id" = "m"."user_id"
      WHERE "m"."organization_id" = NEW.organization_id
    UNION
    SELECT lower(trim("email")) AS "email" FROM "invitation"
      WHERE "organization_id" = NEW.organization_id AND "status" = 'pending'
  ) AS "seats" WHERE "email" IS DISTINCT FROM newcomer;
  IF used_count >= plan_cap THEN
    RAISE EXCEPTION 'Plan sin cupo para más personas (%)', NEW.organization_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_seat_cap_member ON "member";--> statement-breakpoint
CREATE TRIGGER saas_seat_cap_member
  BEFORE INSERT ON "member"
  FOR EACH ROW EXECUTE FUNCTION saas_seat_cap_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_seat_cap_invitation ON "invitation";--> statement-breakpoint
CREATE TRIGGER saas_seat_cap_invitation
  BEFORE INSERT ON "invitation"
  FOR EACH ROW WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION saas_seat_cap_check();
--> statement-breakpoint
-- Tope de sedes reforzado en DB (race + otros caminos; app.ts intacto): cuenta
-- solo sedes ACTIVAS (desactivar libera cupo, no borra). Fail-open sin
-- suscripción (legado exento), en demo o sin tope. Sin grants nuevos: el rol
-- app ya lee suscripción/planes y escribe su propia tabla.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION saas_branch_cap_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sub_row RECORD;
  plan_cap integer;
  used_count integer;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('saas-branch:' || NEW.organization_id));
  SELECT * INTO sub_row FROM "saas_subscription" WHERE "organization_id" = NEW.organization_id;
  IF NOT FOUND OR sub_row.is_demo THEN
    RETURN NEW;
  END IF;
  IF sub_row.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "max_branches" INTO plan_cap FROM "saas_plan" WHERE "id" = sub_row.plan_id;
  IF plan_cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO used_count FROM "branch"
    WHERE "organization_id" = NEW.organization_id AND "is_active";
  IF used_count >= plan_cap THEN
    RAISE EXCEPTION 'Plan sin cupo para más sedes (%)', NEW.organization_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_branch_cap_insert ON "branch";--> statement-breakpoint
CREATE TRIGGER saas_branch_cap_insert
  BEFORE INSERT ON "branch"
  FOR EACH ROW EXECUTE FUNCTION saas_branch_cap_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_branch_cap_activate ON "branch";--> statement-breakpoint
CREATE TRIGGER saas_branch_cap_activate
  BEFORE UPDATE OF "is_active" ON "branch"
  FOR EACH ROW EXECUTE FUNCTION saas_branch_cap_check();
--> statement-breakpoint
-- Anular una liquidación libera sus fuentes: las líneas se marcan (no se
-- borran) y la unicidad solo rige entre vigentes, así se reliquida igual.
--> statement-breakpoint
ALTER TABLE "saas_commission_settlement_line" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_commission_settlement_line" DROP CONSTRAINT "saas_settlement_line_source_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "saas_settlement_line_source_uidx" ON "saas_commission_settlement_line" USING btree ("source_key") WHERE "voided_at" IS NULL;--> statement-breakpoint
-- Cobro recurrente automático: el cargo del mes lo genera el tick (idempotente
-- por `dedupe_key` = periodo:AAAA-MM; manual deja null). Atribución vendedor
-- congelada en la suscripción (porcentaje/plazo/inicio/fin).
--> statement-breakpoint
ALTER TABLE "saas_charge" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_charge_org_dedupe_uidx" ON "saas_charge" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "seller_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "seller_window_days" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "seller_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "seller_ended_at" timestamp with time zone;--> statement-breakpoint
-- Borrado de la organización (wipe de semilla) arrastra sus filas SaaS.
--> statement-breakpoint
ALTER TABLE "saas_charge" DROP CONSTRAINT "saas_charge_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_payment" DROP CONSTRAINT "saas_payment_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_seller_commission" DROP CONSTRAINT "saas_seller_commission_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_seller_commission" ADD CONSTRAINT "saas_seller_commission_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_commission_adjustment" DROP CONSTRAINT "saas_commission_adjustment_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_notice" DROP CONSTRAINT "saas_notice_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_notice" ADD CONSTRAINT "saas_notice_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_usage_daily" DROP CONSTRAINT "saas_usage_daily_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_usage_daily" ADD CONSTRAINT "saas_usage_daily_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saas_commission_settlement_line" DROP CONSTRAINT "saas_commission_settlement_line_organization_id_fkey";--> statement-breakpoint
ALTER TABLE "saas_commission_settlement_line" ADD CONSTRAINT "saas_settlement_line_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
