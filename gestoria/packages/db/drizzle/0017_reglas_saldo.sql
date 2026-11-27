-- Las reglas del saldo (ADR 0221). La vista solo se lee, con las reglas de `sale_order` y
-- `order_payment` (corre con los permisos de quien la lee). Los medios de cada pago van con el
-- INSERT de `order_payment` que ya se concede (`0005_reglas_pedidos.sql`): no se cambian después.
GRANT SELECT ON TABLE order_balance TO gestoria_app;
