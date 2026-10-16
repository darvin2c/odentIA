-- La conversación que llevó a una cita recuperada se cobra en su tramo; si la
-- persona asiste, el cargo en que se cobra la cita la devuelve con una línea
-- `devolucion` (ADR 0031). Es la única línea que resta.
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_kind_check";--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_kind_check" CHECK ("saas_charge_line"."kind" IN ('cuota','conversacion','consulta','cita','devolucion','credito','impuesto'));--> statement-breakpoint
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_amount_check";--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_amount_check" CHECK ("saas_charge_line"."quantity" >= 0 AND CASE WHEN "saas_charge_line"."kind" = 'devolucion' THEN "saas_charge_line"."amount_cents" <= 0 ELSE "saas_charge_line"."amount_cents" >= 0 END);
