-- Fichas de consulta «En uso / Sin usar» (14 nov, ADR 0117): lo que TS no declara. La columna
-- `clinical_form_template.in_use` la generó 0116 desde el esquema; la tabla ya tiene su RLS y su
-- GRANT (SELECT, INSERT, UPDATE al rol de la aplicación), que la columna nueva hereda.
--
-- Una versión publicada sigue sin cambiar su contenido. Ahora puede, además de archivarse
-- (publicar la siguiente), encenderse o apagarse: cambiar solo `in_use` (y `updated_at`), sin
-- tocar nada más. Una archivada sigue inmutable, también en `in_use`.
CREATE OR REPLACE FUNCTION public.clinical_forms_template_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'publicado' THEN
    IF NEW.status = 'archivado'
      AND (to_jsonb(NEW) - ARRAY['status','updated_at']) = (to_jsonb(OLD) - ARRAY['status','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'publicado'
      AND (to_jsonb(NEW) - ARRAY['in_use','updated_at']) = (to_jsonb(OLD) - ARRAY['in_use','updated_at'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Plantilla publicada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.status = 'archivado' THEN
    RAISE EXCEPTION 'Plantilla archivada inmutable (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;
