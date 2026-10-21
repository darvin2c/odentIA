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
-- Dos iguales en una clínica llevan -2, -3…
CREATE FUNCTION public.branch_slug_fill() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stem text;
  candidate text;
  n integer := 1;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    RETURN NEW;
  END IF;
  stem := public.branch_slug_stem(NEW.name);
  candidate := stem;
  WHILE EXISTS (SELECT 1 FROM public.branch WHERE organization_id = NEW.organization_id AND slug = candidate) LOOP
    n := n + 1;
    candidate := stem || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER branch_slug_fill BEFORE INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_slug_fill();--> statement-breakpoint
WITH numbered AS (
  SELECT "id", public.branch_slug_stem("name") AS "stem",
    row_number() OVER (PARTITION BY "organization_id", public.branch_slug_stem("name") ORDER BY "created_at", "id") AS "n"
  FROM "branch"
)
UPDATE "branch" AS b SET "slug" = CASE WHEN n."n" = 1 THEN n."stem" ELSE n."stem" || '-' || n."n" END
  FROM numbered AS n
  WHERE n."id" = b."id";--> statement-breakpoint
ALTER TABLE "branch" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_org_slug_uidx" ON "branch" USING btree ("organization_id","slug");
