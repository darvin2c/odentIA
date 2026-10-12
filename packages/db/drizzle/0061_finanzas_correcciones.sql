-- Correcciones de la revisión del plan de finanzas: nada atado a un país en
-- las monedas por defecto, comisiones con varios pagos por mes y ajustes,
-- cierre con el desglose completo del efectivo y restos que el plan quitaba.
ALTER TABLE "cash_movement" DROP CONSTRAINT "cash_movement_kind_check";--> statement-breakpoint
ALTER TABLE "commission_settlement" DROP CONSTRAINT "commission_settlement_status_check";--> statement-breakpoint
-- Los movimientos manuales «ajuste» dejan de existir: lo que hubiera pasa a
-- ser un ingreso o un retiro a mano, que es lo que eran.
DROP TRIGGER cash_movement_immutable ON cash_movement;
--> statement-breakpoint
UPDATE cash_movement SET kind = CASE WHEN direction = 'ingreso' THEN 'aporte' ELSE 'retiro' END WHERE kind = 'ajuste';
--> statement-breakpoint
CREATE TRIGGER cash_movement_immutable BEFORE UPDATE ON cash_movement FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at','voided_by','void_reason');
--> statement-breakpoint
-- Una liquidación en «borrador» nunca tuvo efecto: queda anulada, no borrada.
UPDATE commission_settlement_line l SET voided_at = now(), void_reason = 'Borrador anterior sin efecto'
FROM commission_settlement s
WHERE s.id = l.settlement_id AND s.organization_id = l.organization_id AND s.status = 'borrador' AND l.voided_at IS NULL;
--> statement-breakpoint
UPDATE commission_settlement SET status = 'anulada', voided_at = COALESCE(voided_at, now()), void_reason = COALESCE(void_reason, 'Borrador anterior sin efecto') WHERE status = 'borrador';
--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_supplier_id_supplier_id_fk";
--> statement-breakpoint
DROP INDEX "commission_settlement_month_uidx";--> statement-breakpoint
DROP INDEX "expense_org_supplier_idx";--> statement-breakpoint
ALTER TABLE "service_catalog" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "treatment_budget" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD COLUMN "cash_added_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD COLUMN "cash_withdrawn_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD COLUMN "cash_refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "kind" text DEFAULT 'cobro' NOT NULL;--> statement-breakpoint
CREATE INDEX "commission_settlement_month_idx" ON "commission_settlement" USING btree ("organization_id","professional_user_id","period_year","period_month");--> statement-breakpoint
ALTER TABLE "expense" DROP COLUMN "supplier_id";--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_method_type_check" CHECK ("patient_payment"."method_type_code" IS NULL OR "patient_payment"."method_type_code" IN ('10','48','30','68','20','1'));--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_split_check" CHECK ("cash_closure"."retained_cents" + "cash_closure"."delivered_cents" = "cash_closure"."counted_cents");--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_kind_check" CHECK ("cash_movement"."kind" IN ('apertura','cobro','gasto','aporte','retiro','devolucion'));--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_status_check" CHECK ("commission_settlement"."status" IN ('liquidada','anulada'));--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_line_kind_check" CHECK ("commission_settlement_line"."kind" IN ('cobro','ajuste'));--> statement-breakpoint
-- El medio y el importe de un pago quedan congelados en la base: solo admite anularse.
CREATE TRIGGER patient_payment_immutable BEFORE UPDATE ON patient_payment FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at','voided_by','void_reason','updated_at');
