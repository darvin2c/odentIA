ALTER TABLE "branch" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "google_place_id" text;--> statement-breakpoint
-- El enlace corto de cada sede para llegar (issue 36) nace de su nombre, sin
-- «Sede» delante y sin tildes: «Sede Miraflores» → «miraflores». Lo pone la
-- base al crearla (también las semillas y las pruebas que insertan directo) y
-- no cambia al renombrarla: los enlaces ya enviados siguen sirviendo.
CREATE FUNCTION public.branch_slug_stem(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT coalesce(
  nullif(trim(both '-' from regexp_replace(public.search_fold(regexp_replace(coalesce(value, ''), '^\s*sede\s+', '', 'i')), '[^a-z0-9]+', '-', 'g')), ''),
  'sede'
) $$;--> statement-breakpoint
-- Dos iguales en una clínica llevan -2, -3…: el primero libre, aunque otra
-- sede ya se llame así («Sede Norte» dos veces y «Norte 2»).
CREATE FUNCTION public.branch_slug_free(org text, stem text) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  candidate text := stem;
  n integer := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.branch WHERE organization_id = org AND slug = candidate) LOOP
    n := n + 1;
    candidate := stem || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.branch_slug_fill() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  -- Dos altas a la vez en la misma clínica no eligen el mismo hueco.
  PERFORM pg_advisory_xact_lock(hashtext('branch_slug:' || NEW.organization_id));
  NEW.slug := public.branch_slug_free(NEW.organization_id, public.branch_slug_stem(NEW.name));
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER branch_slug_fill BEFORE INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_slug_fill();--> statement-breakpoint
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT "id", "organization_id", "name" FROM "branch" ORDER BY "created_at", "id" LOOP
    UPDATE "branch" SET "slug" = public.branch_slug_free(item."organization_id", public.branch_slug_stem(item."name"))
      WHERE "id" = item."id";
  END LOOP;
END;
$$;--> statement-breakpoint
ALTER TABLE "branch" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_org_slug_uidx" ON "branch" USING btree ("organization_id","slug");
