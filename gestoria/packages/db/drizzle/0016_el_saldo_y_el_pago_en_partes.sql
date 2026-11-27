-- Un solo saldo por pedido y el pago en partes (ADR 0222).
--
-- 1. Cada pago guarda su medio (el de la tienda, copiado como en el pedido) y su tipo de
--    UN/CEFACT 4461. Los pagos de antes toman el medio de su pedido; si ya no se sabe el tipo,
--    «1» (otro). Uno por el link en un pedido de otro medio queda como «Link de pago» (68).
-- 2. `order_balance`: el saldo de cada pedido, calculado en un solo lugar.
ALTER TABLE "order_payment" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "order_payment" ADD COLUMN "method_type" text;--> statement-breakpoint
UPDATE "order_payment" p SET
  "method_name" = CASE
    WHEN p.kind = 'link' AND o.payment_collection <> 'link' THEN 'Link de pago'
    ELSE o.payment_name
  END,
  "method_type" = CASE
    WHEN p.kind = 'link' AND o.payment_collection <> 'link' THEN '68'
    ELSE coalesce(m.type_code, '1')
  END
FROM "sale_order" o
LEFT JOIN "store_payment_method" m ON m.id = o.payment_method_id AND m.store_id = o.store_id
WHERE o.id = p.order_id;--> statement-breakpoint
ALTER TABLE "order_payment" ALTER COLUMN "method_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment" ALTER COLUMN "method_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_method_check" CHECK (char_length(btrim("order_payment"."method_name")) between 1 and 80 and method_type IN ('68','30','48','10','1'));--> statement-breakpoint
-- Falta cobrar = total − confirmado − por confirmar, nunca menos de 0 y 0 si se anuló. «Pagado»:
-- no debe nada y todo lo que entró está confirmado. Lo confirmado que pasa del total es un pago
-- doble. Corre con los permisos de quien la lee: las reglas de cada tienda siguen valiendo.
CREATE VIEW "order_balance" WITH (security_invoker = true) AS
SELECT
  s.order_id,
  s.store_id,
  s.total_cents,
  s.confirmed_cents,
  s.pending_cents,
  CASE WHEN s.state = 'anulado' THEN 0
    ELSE greatest(s.total_cents - s.confirmed_cents - s.pending_cents, 0) END AS due_cents,
  greatest(s.confirmed_cents - s.total_cents, 0) AS over_cents,
  (s.state <> 'anulado' AND s.pending_cents = 0 AND s.confirmed_cents >= s.total_cents) AS paid
FROM (
  SELECT
    o.id AS order_id,
    o.store_id,
    o.state,
    o.total_cents,
    coalesce(sum(p.amount_cents) FILTER (WHERE p.status = 'confirmado'), 0)::integer AS confirmed_cents,
    coalesce(sum(p.amount_cents) FILTER (WHERE p.status = 'por_confirmar'), 0)::integer AS pending_cents
  FROM "sale_order" o
  LEFT JOIN "order_payment" p ON p.order_id = o.id AND p.store_id = o.store_id
  GROUP BY o.id
) s;
