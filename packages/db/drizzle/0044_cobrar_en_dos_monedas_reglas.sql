-- La cuenta única del valor: cuánto vale un importe en moneda del negocio. La
-- comparten Reportes y Argos; `moneyValue` de @odentia/clinical es su espejo, y
-- una prueba compara los dos. No lee tablas y no redondea: se redondea solo al
-- mostrar o al congelar, nunca fila por fila, para que las partes de un importe
-- sumen su valor exacto. Con el valor congelado reparte en proporción; sin él,
-- la moneda del negocio vale lo que dice y otra moneda sale del factor de hoy. Sin
-- factor no hay valor: NULL no entra en una suma, igual que esas filas no entraban
-- cuando se filtraban por moneda.
CREATE FUNCTION public.money_value(parte numeric, importe numeric, valor numeric, moneda text, moneda_negocio text, factor numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN valor IS NOT NULL THEN
      CASE WHEN importe = 0 THEN 0 ELSE (parte * valor)::numeric(60, 30) / importe END
    WHEN moneda = moneda_negocio THEN parte
    WHEN factor IS NOT NULL THEN parte * factor
  END
$$;--> statement-breakpoint

-- Quien usa una vista debe poder llamar a sus funciones: también cada llave de Argos.
REVOKE ALL ON FUNCTION public.money_value(numeric, numeric, numeric, text, text, numeric) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.money_value(numeric, numeric, numeric, text, text, numeric) TO dentalagent_app, argos_dueno, argos_gestion, argos_recepcion, argos_clinico, argos_caja;
