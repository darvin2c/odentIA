-- Respuesta del Libro de Reclamaciones desde la administración de odentIA: las
-- reglas que el esquema TypeScript no declara. Las columnas las crea 0005.
--
-- Lo enviado es lo que dice el libro: una hoja respondida no cambia su
-- respuesta, su fecha ni vuelve a «recibido». El resto de columnas sí (marcar
-- el correo enviado, `updated_at`, quién respondió si su cuenta se borra).
CREATE FUNCTION "consumer_complaint_response_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'respondido' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."provider_response" IS DISTINCT FROM OLD."provider_response"
    OR NEW."responded_at" IS DISTINCT FROM OLD."responded_at"
  ) THEN
    RAISE EXCEPTION 'La respuesta de una hoja de reclamación no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "consumer_complaint_response_immutable" BEFORE UPDATE ON "consumer_complaint" FOR EACH ROW EXECUTE FUNCTION "consumer_complaint_response_immutable"();
