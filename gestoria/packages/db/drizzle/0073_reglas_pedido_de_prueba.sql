-- Las reglas del pedido de prueba («Probar a Sofi», «Probar como clienta»; ADR 0237). Una prueba
-- no es una venta: se paga de prueba (sin cobrar ni mover stock), pero no sale, no se entrega y a
-- nadie se le avisa. El servidor ya lo frena (`notForTest` y `notifyCustomer` de `pedidos.ts`);
-- estas reglas lo frenan también en la base, para todos (el equipo y Sofi).
--
-- 1. Un pedido de prueba nunca va «en camino» ni «entregado».
-- 2. A un pedido de prueba no se le anota un aviso al cliente.
CREATE POLICY sale_order_test_not_shipped ON sale_order AS RESTRICTIVE FOR UPDATE TO gestoria_app
  USING (true)
  WITH CHECK (NOT test OR state NOT IN ('en_camino', 'entregado'));--> statement-breakpoint
CREATE POLICY sale_order_test_not_shipped_create ON sale_order AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (NOT test OR state NOT IN ('en_camino', 'entregado'));--> statement-breakpoint
CREATE POLICY order_event_test_no_notice ON order_event AS RESTRICTIVE FOR INSERT TO gestoria_app
  WITH CHECK (
    action <> 'aviso'
    OR NOT EXISTS (SELECT 1 FROM sale_order o WHERE o.id = order_id AND o.test)
  );
