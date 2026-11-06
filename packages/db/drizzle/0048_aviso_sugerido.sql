-- El aviso de privacidad que arma odentIA al nacer la clínica (ADR 0141) dice «Sugerido, sin
-- revisar» hasta que alguien de la clínica lo cambia o marca que lo revisó. Nulo: lo escribió o
-- lo revisó la clínica (todas las de antes).
ALTER TABLE "patient_registration_config" ADD COLUMN "notice_suggested_at" timestamp with time zone;
