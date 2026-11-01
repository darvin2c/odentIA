-- Un horario activo es de quien puede atender (ADR 0128). La agenda, Sofi, el enlace
-- de reserva y el horario de la sede leen el horario activo, así que quien sale de la
-- clínica o cambia a un rol que no atiende deja de ofrecerse aquí, sea cual sea la vía
-- del cambio: el equipo, irse por su cuenta o la administración.

-- Cierra el horario como lo hace el servicio al cambiarlo (ADR 0060): lo de antes deja
-- de valer hoy, en el día de la sede, y sigue contando para Reportes en su tiempo; lo
-- que empezó hoy se borra, porque un horario no termina el día que empieza.
CREATE FUNCTION public.close_professional_schedule(p_org text, p_user text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH closing AS (
    SELECT s."id", s."valid_from",
      (now() AT TIME ZONE coalesce(b."timezone", p."timezone", 'UTC'))::date AS "today"
    FROM "professional_schedule" s
    JOIN "branch" b ON b."id" = s."branch_id"
    LEFT JOIN "org_profile" p ON p."organization_id" = s."organization_id"
    WHERE s."organization_id" = p_org AND s."professional_user_id" = p_user AND s."is_active"
  ), gone AS (
    DELETE FROM "professional_schedule" s USING closing c
    WHERE s."id" = c."id" AND c."valid_from" >= c."today"
  )
  UPDATE "professional_schedule" s
    SET "is_active" = false, "valid_until" = c."today", "updated_at" = now()
    FROM closing c
    WHERE s."id" = c."id" AND c."valid_from" < c."today";
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.close_professional_schedule(text, text) FROM PUBLIC;--> statement-breakpoint

-- Los roles son `ATTENDING_ROLES` de `packages/auth/src/permissions.ts`; `quien-atiende.test.ts`
-- recorre todos los roles y exige que esta lista, y la de `argos.equipo` abajo, digan lo mismo.
CREATE FUNCTION public.close_schedule_of_who_stops_attending() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."role" IN ('owner', 'admin', 'clinician') THEN
    RETURN NULL;
  END IF;
  PERFORM public.close_professional_schedule(OLD."organization_id", OLD."user_id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.close_schedule_of_who_stops_attending() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER member_close_schedule AFTER DELETE OR UPDATE OF "role" ON public.member
    FOR EACH ROW EXECUTE FUNCTION public.close_schedule_of_who_stops_attending();--> statement-breakpoint

-- Argos: quien atiende, además de tener horario o citas, puede atender. Las columnas son las mismas.
CREATE OR REPLACE VIEW argos.equipo AS
 SELECT u.name AS profesional,
    array_to_string(ARRAY( SELECT
                CASE TRIM(BOTH FROM r.r)
                    WHEN 'owner'::text THEN 'propietario'::text
                    WHEN 'admin'::text THEN 'administración'::text
                    WHEN 'clinician'::text THEN
                    CASE
                        WHEN (op.product = 'medical'::text) THEN 'medicina'::text
                        ELSE 'odontología'::text
                    END
                    WHEN 'reception'::text THEN 'recepción'::text
                    WHEN 'cashier'::text THEN 'caja'::text
                    ELSE 'otro'::text
                END AS "case"
           FROM unnest(string_to_array(m.role, ','::text)) r(r)), ', '::text) AS rol,
    ( SELECT string_agg(s.name, ', '::text ORDER BY s.name) AS string_agg
           FROM (public.professional_specialty ps
             JOIN public.org_specialty s ON (((s.organization_id = ps.organization_id) AND (s.id = ps.specialty_id))))
          WHERE ((ps.organization_id = m.organization_id) AND (ps.user_id = m.user_id))) AS especialidades,
    ((m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'clinician'::text])) AND ((EXISTS ( SELECT 1
           FROM public.professional_schedule s
          WHERE ((s.organization_id = m.organization_id) AND (s.professional_user_id = m.user_id)))) OR (EXISTS ( SELECT 1
           FROM public.appointment a
          WHERE ((a.organization_id = m.organization_id) AND (a.professional_user_id = m.user_id)))))) AS atiende
   FROM ((public.member m
     JOIN auth."user" u ON ((u.id = m.user_id)))
     LEFT JOIN public.org_profile op ON ((op.organization_id = m.organization_id)))
  WHERE (m.organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text));--> statement-breakpoint

-- Lo que ya había: quien hoy tiene horario sin poder atender o sin seguir en la clínica.
-- Las filas cerradas quedan con su `valid_until`: se pueden revisar y volver a abrir.
SELECT public.close_professional_schedule(x."organization_id", x."professional_user_id")
FROM (
  SELECT DISTINCT s."organization_id", s."professional_user_id"
  FROM "professional_schedule" s
  LEFT JOIN "member" m ON m."organization_id" = s."organization_id" AND m."user_id" = s."professional_user_id"
  WHERE s."is_active" AND (m."id" IS NULL OR m."role" NOT IN ('owner', 'admin', 'clinician'))
) x;
