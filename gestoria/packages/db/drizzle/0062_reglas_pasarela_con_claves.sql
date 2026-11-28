-- Las reglas de la pasarela con las claves de la tienda (Cobros; ADR 0232). Como en las migraciones
-- de reglas anteriores, se concede solo lo que la aplicación usa, dentro de la regla de la tienda que
-- ya tiene la tabla (`store_payment_link_store`, que Sofi y Argos no pasan: `0007`). Quién conecta lo
-- decide el servidor (`configuracion` en `permisos.ts`).
--
-- Al conectar (con la cuenta o con las claves) se escribe cómo se conectó y cuándo se revisó el
-- token. La revisión de cada día y marcar que Mercado Pago ya no lo reconoce las hace el sistema (el
-- dueño de la base).
GRANT UPDATE (connected_with, checked_at) ON TABLE store_payment_link TO gestoria_app;
