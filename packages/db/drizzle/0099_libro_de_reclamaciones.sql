-- Libro de Reclamaciones virtual de odentIA (Perú: Ley 29571 y D.S. 011-2011-PCM
-- con sus modificatorias). Es de la plataforma, no de una clínica: quien reclama
-- es un visitante o cliente de odentIA, así que la tabla no lleva organization_id
-- ni RLS. Solo el rol owner la toca (la API pública escribe con ownerDb).
--
-- Cada hoja guarda los campos del Anexo I. El número correlativo es por año
-- («2026-000001») y sale de `consumer_complaint_counter` con un upsert atómico en
-- la misma transacción que inserta la hoja: si la inserción falla, el contador
-- vuelve atrás y no quedan huecos. `submission_id` hace idempotente el envío.
CREATE TABLE "consumer_complaint_counter" (
  "year" integer PRIMARY KEY,
  "value" bigint NOT NULL DEFAULT 0 CHECK ("value" >= 0)
);--> statement-breakpoint
CREATE TABLE "consumer_complaint" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "number" text NOT NULL,
  "year" integer NOT NULL,
  "submission_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('reclamo', 'queja')),
  "status" text NOT NULL DEFAULT 'recibido' CHECK ("status" IN ('recibido', 'respondido')),
  -- 1) Identificación del consumidor reclamante.
  "consumer_name" text NOT NULL,
  "consumer_address" text NOT NULL,
  "document_type" text NOT NULL,
  "document_number" text NOT NULL,
  "phone" text NOT NULL,
  "email" text NOT NULL,
  "is_minor" boolean NOT NULL DEFAULT false,
  "guardian_name" text,
  -- 2) Identificación del bien contratado.
  "item_type" text NOT NULL CHECK ("item_type" IN ('producto', 'servicio')),
  "item_description" text NOT NULL,
  -- Importe entero en céntimos de la moneda (como el resto de importes del sistema).
  "amount_minor" bigint CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0),
  "amount_currency" text CHECK ("amount_currency" IS NULL OR "amount_currency" IN ('PEN', 'USD')),
  -- 3) Detalle de la reclamación y pedido del consumidor.
  "detail" text NOT NULL,
  "request" text NOT NULL,
  -- 4) Observaciones y acciones adoptadas por el proveedor (las llena odentIA).
  "provider_response" text,
  "responded_at" timestamptz,
  "privacy_accepted_at" timestamptz NOT NULL,
  "email_sent" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "consumer_complaint_number_unique" UNIQUE ("number"),
  CONSTRAINT "consumer_complaint_submission_unique" UNIQUE ("submission_id"),
  CONSTRAINT "consumer_complaint_number_year" CHECK ("number" LIKE "year"::text || '-%'),
  -- Un menor de edad reclama con el nombre de su padre, madre o apoderado.
  CONSTRAINT "consumer_complaint_minor_guardian" CHECK (NOT "is_minor" OR coalesce(btrim("guardian_name"), '') <> ''),
  -- El monto y su moneda van juntos o no van.
  CONSTRAINT "consumer_complaint_amount_currency" CHECK (("amount_minor" IS NULL) = ("amount_currency" IS NULL)),
  -- Respondida exige la respuesta y su fecha.
  CONSTRAINT "consumer_complaint_response" CHECK (
    "status" <> 'respondido' OR ("provider_response" IS NOT NULL AND "responded_at" IS NOT NULL)
  )
);--> statement-breakpoint
CREATE INDEX "consumer_complaint_status_idx" ON "consumer_complaint" USING btree ("status", "created_at");--> statement-breakpoint
-- Solo owner: la aplicación no toca estas tablas (ni siquiera lectura).
REVOKE ALL ON TABLE "consumer_complaint" FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE "consumer_complaint_counter" FROM dentalagent_app;
