-- Las reglas de Entregas por distrito (tablero 7). Las columnas nuevas son de tablas que ya
-- tienen sus reglas por tienda: solo se concede cambiarlas. Las cambia quien tiene
-- `configuracion` (lo decide el servidor); Sofi y Argos no tocan la tienda (`store_no_agent_change`)
-- ni las formas de entrega (`0007_reglas_sofi.sql`).
GRANT UPDATE (ship_from, failed_trip) ON TABLE store TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (opening_hours, ready_in, agencies, freight, freight_cents) ON TABLE store_delivery_method TO gestoria_app;
