-- Medios iniciales: los comunes para todas las clínicas y billeteras solo según el perfil peruano.
INSERT INTO organization_payment_method (organization_id,name,type_code,sort_order)
SELECT p.organization_id, v.name, v.type_code, v.sort_order FROM org_profile p
CROSS JOIN (VALUES ('Efectivo','10',0),('Tarjeta','48',30),('Transferencia','30',40)) AS v(name,type_code,sort_order);
--> statement-breakpoint
INSERT INTO organization_payment_method (organization_id,name,type_code,sort_order)
SELECT p.organization_id,v.name,'68',v.sort_order FROM org_profile p
CROSS JOIN (VALUES ('Yape',10),('Plin',20)) AS v(name,sort_order)
WHERE p.country_code='PE';
--> statement-breakpoint
-- El snapshot conserva exactamente el método registrado; no se asignan sedes desconocidas.
UPDATE patient_payment SET method_name = CASE method WHEN 'efectivo' THEN 'Efectivo' WHEN 'tarjeta' THEN 'Tarjeta' WHEN 'transferencia' THEN 'Transferencia' WHEN 'yape' THEN 'Yape' WHEN 'plin' THEN 'Plin' ELSE method END,
method_type_code = CASE method WHEN 'efectivo' THEN '10' WHEN 'tarjeta' THEN '48' WHEN 'transferencia' THEN '30' WHEN 'yape' THEN '68' WHEN 'plin' THEN '68' ELSE '1' END;
--> statement-breakpoint
UPDATE patient_payment p SET payment_method_id=m.id FROM organization_payment_method m WHERE m.organization_id=p.organization_id AND m.name=p.method_name AND m.type_code=p.method_type_code;
--> statement-breakpoint
UPDATE patient_payment p SET branch_id=s.branch_id FROM cash_movement m JOIN cash_shift s ON s.id=m.shift_id AND s.organization_id=m.organization_id WHERE m.patient_payment_id=p.id AND m.organization_id=p.organization_id AND m.kind='cobro';
--> statement-breakpoint
UPDATE patient_charge c SET branch_id=e.branch_id FROM encounter_procedure ep JOIN encounter e ON e.id=ep.encounter_id AND e.organization_id=ep.organization_id WHERE c.encounter_procedure_id=ep.id AND c.organization_id=ep.organization_id;
--> statement-breakpoint
DROP TRIGGER cash_movement_immutable ON cash_movement;
--> statement-breakpoint
UPDATE cash_movement SET method_type_code=CASE WHEN method IS NULL THEN NULL WHEN method='efectivo' THEN '10' WHEN method='tarjeta' THEN '48' WHEN method='transferencia' THEN '30' WHEN method IN ('yape','plin') THEN '68' ELSE '1' END;
--> statement-breakpoint
CREATE TRIGGER cash_movement_immutable BEFORE UPDATE ON cash_movement FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at','voided_by','void_reason');
--> statement-breakpoint
UPDATE treatment_budget_item SET tariff_price_cents=price_cents;
--> statement-breakpoint
-- Los rangos anteriores permanecen como histórico, sin inventar un mes ni un pago.
DROP TRIGGER commission_settlement_line_immutable ON commission_settlement_line;
--> statement-breakpoint
UPDATE commission_settlement_line l SET application_id=a.id FROM patient_payment_application a WHERE l.source_key='app:'||a.id::text AND l.organization_id=a.organization_id;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_line_immutable BEFORE UPDATE ON commission_settlement_line FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at','voided_by','void_reason');
--> statement-breakpoint
-- Aislamiento y privilegios de las nuevas tablas económicas.
ALTER TABLE "organization_payment_method" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_payment_method" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "organization_payment_method" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_payment_method" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "organization_payment_method" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER organization_payment_method_no_delete BEFORE DELETE ON "organization_payment_method" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
ALTER TABLE "payment_ticket" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_ticket" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "payment_ticket" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_ticket" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "payment_ticket" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER payment_ticket_no_delete BEFORE DELETE ON "payment_ticket" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
ALTER TABLE "ticket_counter" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_counter" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "ticket_counter" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ticket_counter" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "ticket_counter" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER ticket_counter_no_delete BEFORE DELETE ON "ticket_counter" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
ALTER TABLE "cash_closure" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_closure" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "cash_closure" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cash_closure" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "cash_closure" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER cash_closure_no_delete BEFORE DELETE ON "cash_closure" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "promotion" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "promotion" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "promotion" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON "promotion" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
ALTER TABLE "promotion_service_price" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion_service_price" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON "promotion_service_price" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "promotion_service_price" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "promotion_service_price" FROM dentalagent_app;
--> statement-breakpoint
CREATE TRIGGER promotion_service_price_no_delete BEFORE DELETE ON "promotion_service_price" FOR EACH ROW EXECUTE FUNCTION finance_no_delete();
--> statement-breakpoint
CREATE TRIGGER payment_ticket_immutable BEFORE UPDATE ON payment_ticket FOR EACH ROW EXECUTE FUNCTION finance_allow_only('voided_at','voided_by','void_reason');
--> statement-breakpoint
CREATE TRIGGER ticket_counter_immutable BEFORE UPDATE ON ticket_counter FOR EACH ROW EXECUTE FUNCTION finance_allow_only('next_number');
--> statement-breakpoint
CREATE TRIGGER cash_closure_immutable BEFORE UPDATE ON cash_closure FOR EACH ROW EXECUTE FUNCTION finance_allow_only();
--> statement-breakpoint
DROP TRIGGER cash_shift_immutable ON cash_shift;
--> statement-breakpoint
CREATE TRIGGER cash_shift_immutable BEFORE UPDATE ON cash_shift FOR EACH ROW EXECUTE FUNCTION finance_allow_only('status','closed_by','closed_at','expected_cents','electronic_cents','counted_cents','difference_cents','close_notes','retained_cents','delivered_cents');
--> statement-breakpoint
DROP TRIGGER commission_rule_immutable ON commission_rule;
--> statement-breakpoint
CREATE TRIGGER commission_rule_immutable BEFORE UPDATE ON commission_rule FOR EACH ROW EXECUTE FUNCTION finance_allow_only('rate_bps','updated_at');
--> statement-breakpoint
DROP TRIGGER commission_settlement_immutable ON commission_settlement;
--> statement-breakpoint
CREATE TRIGGER commission_settlement_immutable BEFORE UPDATE ON commission_settlement FOR EACH ROW EXECUTE FUNCTION finance_allow_only('status','voided_at','voided_by','void_reason','updated_at','expense_id');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION treatment_budget_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Las líneas del presupuesto no se borran'; END IF;
  SELECT status INTO budget_status FROM treatment_budget WHERE id = NEW.budget_id AND organization_id = NEW.organization_id;
  IF TG_OP = 'INSERT' AND budget_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Solo se agregan líneas a presupuestos en borrador';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id,NEW.patient_id,NEW.plan_id,NEW.budget_id,NEW.plan_item_id) IS DISTINCT FROM (OLD.organization_id,OLD.patient_id,OLD.plan_id,OLD.budget_id,OLD.plan_item_id) THEN
      RAISE EXCEPTION 'La identidad de la línea de presupuesto es inmutable';
    END IF;
    IF budget_status IS DISTINCT FROM 'borrador' AND (to_jsonb(NEW)-'decision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'decision'-'updated_at') THEN
      RAISE EXCEPTION 'El presupuesto entregado solo admite cambios de decisión';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS branch_org_id_finance_uidx ON branch(organization_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_org_id_finance_uidx ON service_catalog(organization_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS promotion_org_id_finance_uidx ON promotion(organization_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_ticket_org_id_finance_uidx ON payment_ticket(organization_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cash_shift_org_id_finance_uidx ON cash_shift(organization_id,id);
--> statement-breakpoint
ALTER TABLE payment_ticket ADD CONSTRAINT payment_ticket_patient_id_org_fk FOREIGN KEY (organization_id,patient_id) REFERENCES patient(organization_id,id);
--> statement-breakpoint
ALTER TABLE payment_ticket ADD CONSTRAINT payment_ticket_branch_id_org_fk FOREIGN KEY (organization_id,branch_id) REFERENCES branch(organization_id,id);
--> statement-breakpoint
ALTER TABLE cash_closure ADD CONSTRAINT cash_closure_branch_id_org_fk FOREIGN KEY (organization_id,branch_id) REFERENCES branch(organization_id,id);
--> statement-breakpoint
ALTER TABLE cash_closure ADD CONSTRAINT cash_closure_shift_id_org_fk FOREIGN KEY (organization_id,shift_id) REFERENCES cash_shift(organization_id,id);
--> statement-breakpoint
ALTER TABLE promotion_service_price ADD CONSTRAINT promotion_service_price_promotion_id_org_fk FOREIGN KEY (organization_id,promotion_id) REFERENCES promotion(organization_id,id);
--> statement-breakpoint
ALTER TABLE promotion_service_price ADD CONSTRAINT promotion_service_price_service_id_org_fk FOREIGN KEY (organization_id,service_id) REFERENCES service_catalog(organization_id,id);
--> statement-breakpoint
ALTER TABLE patient_payment ADD CONSTRAINT patient_payment_payment_method_id_org_fk FOREIGN KEY (organization_id,payment_method_id) REFERENCES organization_payment_method(organization_id,id);
--> statement-breakpoint
ALTER TABLE patient_payment ADD CONSTRAINT patient_payment_ticket_id_org_fk FOREIGN KEY (organization_id,ticket_id) REFERENCES payment_ticket(organization_id,id);
--> statement-breakpoint
ALTER TABLE patient_payment ADD CONSTRAINT patient_payment_branch_id_org_fk FOREIGN KEY (organization_id,branch_id) REFERENCES branch(organization_id,id);
--> statement-breakpoint
ALTER TABLE patient_payment_application ADD CONSTRAINT patient_payment_application_ticket_id_org_fk FOREIGN KEY (organization_id,ticket_id) REFERENCES payment_ticket(organization_id,id);
--> statement-breakpoint
ALTER TABLE patient_charge ADD CONSTRAINT patient_charge_branch_id_org_fk FOREIGN KEY (organization_id,branch_id) REFERENCES branch(organization_id,id);
--> statement-breakpoint
ALTER TABLE treatment_budget_item ADD CONSTRAINT treatment_budget_item_promotion_id_org_fk FOREIGN KEY (organization_id,promotion_id) REFERENCES promotion(organization_id,id);
--> statement-breakpoint
