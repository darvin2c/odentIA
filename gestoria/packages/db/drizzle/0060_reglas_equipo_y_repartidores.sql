-- Las reglas de Equipo y repartidores (tablero 9; ADR 0235). Como en las migraciones de reglas
-- anteriores, se concede solo lo que la aplicación usa, dentro de las reglas de cada tienda que ya
-- tienen las dos tablas. Quién puede hacerlo lo decide el servidor (`equipo.gestionar` en
-- `permisos.ts`).
--
-- 1. Una invitación no cambia lo que dice: lo único nuevo que se escribe después de crearla es
--    cuándo se abrió el WhatsApp con ella y quién (`store_invitation_close`: solo en su tienda).
-- 2. El celular y el pago por entrega de un repartidor los cambia el equipo de la tienda, nunca
--    Sofi (`store_courier_change` ya se lo niega al agente).
GRANT UPDATE (shared_at, shared_by) ON TABLE store_invitation TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (phone, pay_cents, failed_trip_paid) ON TABLE store_courier TO gestoria_app;
