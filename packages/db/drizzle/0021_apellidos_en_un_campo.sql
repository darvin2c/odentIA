-- «Nombres» y «Apellidos», dos campos (ADR 0058, decisión 11 del lienzo de
-- pacientes). Los apellidos van juntos en `family_name`, como el «family» de
-- HL7 FHIR HumanName: el primer apellido pasa entero y el segundo se le suma
-- detrás. El nombre visible no cambia: lo sigue derivando la base.
ALTER TABLE "contact" RENAME COLUMN "paternal_surname" TO "family_name";--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.derive_person_display_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE composed text;
BEGIN
  composed := NULLIF(btrim(regexp_replace(concat_ws(' ', NEW.given_names, NEW.family_name), '\s+', ' ', 'g')), '');
  IF TG_OP = 'INSERT' THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF (NEW.given_names, NEW.family_name) IS DISTINCT FROM (OLD.given_names, OLD.family_name) THEN
    IF composed IS NOT NULL THEN NEW.display_name := composed; END IF;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name AND composed IS NOT NULL THEN
    -- Solo cambió el nombre visible (una edición antigua): se conserva y queda por revisar.
    NEW.identity_needs_review := true;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
UPDATE "contact"
SET "family_name" = NULLIF(btrim(regexp_replace(concat_ws(' ', "family_name", "maternal_surname"), '\s+', ' ', 'g')), '')
WHERE NULLIF(btrim("maternal_surname"), '') IS NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" DROP COLUMN "maternal_surname";
