-- «Tu marca», el nombre del link (tablero 04 del lienzo «gestorIA · Configuración, de nuevo»): la
-- pantalla dice al escribirlo si un nombre ya es de otra tienda y sugiere uno libre. Cada tienda ve
-- solo sus links (`store_link_read`), así que la pregunta pasa por esta función: responde solo
-- cuáles de los nombres pedidos tiene otra tienda, nunca cuál ni nada más. Es lo mismo que ya dice
-- cualquiera al abrir `nombre.gestoria24.com`. Necesita una tienda en curso (`app_store_id`).
CREATE FUNCTION store_link_taken(names text[]) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(name), '{}')
    FROM store_link
   WHERE name = ANY (names[1:10])
     AND app_store_id() IS NOT NULL
     AND store_id <> app_store_id()
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION store_link_taken(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION store_link_taken(text[]) TO gestoria_app;
