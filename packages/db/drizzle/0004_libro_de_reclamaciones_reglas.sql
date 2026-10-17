-- Libro de Reclamaciones virtual de odentIA (Perú: Ley 29571 y D.S. 011-2011-PCM
-- con sus modificatorias): las reglas que el esquema TypeScript no declara. Las
-- tablas las crea 0003 desde packages/db/src/schema/consumer-complaints.ts.
--
-- Es de la plataforma, no de una clínica: quien reclama es un visitante o cliente
-- de odentIA, así que no lleva organization_id ni RLS. Solo el rol owner la toca
-- (la API pública escribe con ownerDb); el rol de la aplicación no la lee.
--
-- El número correlativo es por año («2026-000001») y sale de
-- `consumer_complaint_counter` con un upsert atómico en la misma transacción que
-- inserta la hoja: si la inserción falla, el contador vuelve atrás y no quedan
-- huecos. `submission_id` hace idempotente el envío.
ALTER TABLE "consumer_complaint_counter" ADD CONSTRAINT "consumer_complaint_counter_value" CHECK ("value" >= 0);--> statement-breakpoint
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_kind" CHECK ("kind" IN ('reclamo', 'queja'));--> statement-breakpoint
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_status" CHECK ("status" IN ('recibido', 'respondido'));--> statement-breakpoint
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_item_type" CHECK ("item_type" IN ('producto', 'servicio'));--> statement-breakpoint
-- Importe entero en céntimos de la moneda, como el resto de importes del sistema.
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_amount" CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_currency" CHECK ("amount_currency" IS NULL OR "amount_currency" IN ('PEN', 'USD'));--> statement-breakpoint
-- El monto y su moneda van juntos o no van.
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_amount_currency" CHECK (("amount_minor" IS NULL) = ("amount_currency" IS NULL));--> statement-breakpoint
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_number_year" CHECK ("number" LIKE "year"::text || '-%');--> statement-breakpoint
-- Un menor de edad reclama con el nombre de su padre, madre o apoderado.
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_minor_guardian" CHECK (NOT "is_minor" OR coalesce(btrim("guardian_name"), '') <> '');--> statement-breakpoint
-- Respondida exige la respuesta y su fecha.
ALTER TABLE "consumer_complaint" ADD CONSTRAINT "consumer_complaint_response" CHECK ("status" <> 'respondido' OR ("provider_response" IS NOT NULL AND "responded_at" IS NOT NULL));--> statement-breakpoint
-- Solo owner: la aplicación no toca estas tablas (ni siquiera para leerlas).
REVOKE ALL ON TABLE "consumer_complaint" FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE "consumer_complaint_counter" FROM dentalagent_app;
