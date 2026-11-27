-- El dinero que la tienda devuelve (entrega 8 de «gestorIA como odentIA», tablero 17). Lo que
-- sobra de un pedido (un cambio que cuesta menos, una devolución o un pago doble) se devuelve fuera
-- de gestorIA y se anota con su medio y quién lo hizo (`order_refund`). El saldo único
-- (`order_balance`, ADR 0222) lo resta de lo pagado.
CREATE TABLE "order_refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method_name" text NOT NULL,
	"method_type" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_refund_amount_check" CHECK ("order_refund"."amount_cents" > 0),
	CONSTRAINT "order_refund_method_check" CHECK (char_length(btrim("order_refund"."method_name")) between 1 and 80 and method_type IN ('68','30','48','10','1'))
);
--> statement-breakpoint
ALTER TABLE "order_event" DROP CONSTRAINT "order_event_action_check";--> statement-breakpoint
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_order_fkey" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_refund_order_idx" ON "order_refund" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_refund_store_idx" ON "order_refund" USING btree ("store_id","created_at");--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_action_check" CHECK (action IN ('creado','link','comprobante','pago_confirmado','pago_no_coincide','pago_link','salio','entregado','anulado','aviso','cambiado','no_entregado','reprogramado','pago_deshecho','cambio','dinero_devuelto'));--> statement-breakpoint
-- Lo pagado es lo confirmado menos lo devuelto. Falta cobrar = total − pagado − por confirmar, nunca
-- menos de 0 y 0 si se anuló. «Pagado»: no debe nada y todo lo que entró está confirmado. Lo pagado
-- que pasa del total sobra: un pago doble o lo que la tienda devuelve de un cambio (un total bajo
-- cero). Cada suma va en su propia consulta para que los pagos y lo devuelto no se multipliquen.
-- Corre con los permisos de quien la lee: las reglas de cada tienda siguen valiendo.
CREATE OR REPLACE VIEW "order_balance" WITH (security_invoker = true) AS
SELECT
  s.order_id,
  s.store_id,
  s.total_cents,
  s.confirmed_cents,
  s.pending_cents,
  CASE WHEN s.state = 'anulado' THEN 0
    ELSE greatest(s.total_cents - (s.confirmed_cents - s.refunded_cents) - s.pending_cents, 0) END AS due_cents,
  greatest(s.confirmed_cents - s.refunded_cents - s.total_cents, 0) AS over_cents,
  (s.state <> 'anulado' AND s.pending_cents = 0
    AND s.confirmed_cents - s.refunded_cents >= s.total_cents) AS paid,
  s.refunded_cents
FROM (
  SELECT
    o.id AS order_id,
    o.store_id,
    o.state,
    o.total_cents,
    coalesce((SELECT sum(p.amount_cents) FROM "order_payment" p
      WHERE p.order_id = o.id AND p.store_id = o.store_id AND p.status = 'confirmado'), 0)::integer AS confirmed_cents,
    coalesce((SELECT sum(p.amount_cents) FROM "order_payment" p
      WHERE p.order_id = o.id AND p.store_id = o.store_id AND p.status = 'por_confirmar'), 0)::integer AS pending_cents,
    coalesce((SELECT sum(r.amount_cents) FROM "order_refund" r
      WHERE r.order_id = o.id AND r.store_id = o.store_id), 0)::integer AS refunded_cents
  FROM "sale_order" o
) s;
