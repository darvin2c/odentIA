-- Las reglas de la hora de la tienda (ADR 0222). Como en las migraciones de reglas anteriores,
-- se concede solo lo que la aplicación usa.
--
-- La cambia quien tiene `configuracion` (lo decide el servidor), solo en la tienda en la que está
-- y solo esa columna: el nombre, la moneda y el país no se tocan desde aquí. El agente no la
-- cambia (`store_agent_change`, de `0007_reglas_sofi.sql`).
GRANT UPDATE (time_zone) ON TABLE store TO gestoria_app;--> statement-breakpoint
CREATE POLICY store_change ON store FOR UPDATE TO gestoria_app
  USING (id = app_store_id()) WITH CHECK (id = app_store_id());
