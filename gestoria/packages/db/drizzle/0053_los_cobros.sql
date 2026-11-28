-- Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6; ADR 0232). Cada forma de cobro
-- con sus datos: Yape y Plin con su celular (E.164), su titular y su QR (en la base, por su
-- contenido); la transferencia con su banco, su cuenta y su CCI. La pasarela se conecta entrando a
-- la cuenta (OAuth, con su intento de 10 minutos), se renueva sola, guarda su modo (prueba o real)
-- y su link de prueba de S/ 1. Los tipos de UN/CEFACT 4461 siguen igual.
CREATE TABLE "store_payment_link_attempt" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"verifier" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "store_payment_link_attempt_provider_check" CHECK (provider IN ('mercadopago')),
	CONSTRAINT "store_payment_link_attempt_mode_check" CHECK (mode IN ('prueba','real')),
	CONSTRAINT "store_payment_link_attempt_hash_check" CHECK ("store_payment_link_attempt"."state_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "store_payment_link_trial" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"url" text NOT NULL,
	"ref" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_cents" integer,
	"payment_ref" text,
	CONSTRAINT "store_payment_link_trial_provider_check" CHECK (provider IN ('mercadopago')),
	CONSTRAINT "store_payment_link_trial_amount_check" CHECK ("store_payment_link_trial"."amount_cents" > 0),
	CONSTRAINT "store_payment_link_trial_url_check" CHECK ("store_payment_link_trial"."url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "store_payment_qr" (
	"store_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_payment_qr_pkey" PRIMARY KEY("method_id"),
	CONSTRAINT "store_payment_qr_type_check" CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "store_payment_qr_size_check" CHECK (octet_length("store_payment_qr"."content") between 1 and 1500000)
);
--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "mode" text DEFAULT 'real' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "provider_user_id" text;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "kind" text DEFAULT 'otro' NOT NULL;--> statement-breakpoint
-- Lo que ya estaba guardado: el link, el efectivo y el POS al recibir se reconocen por su tipo; lo
-- demás (un Yape escrito a mano) queda como «otro», con su texto, hasta que la tienda lo complete.
UPDATE "store_payment_method" SET "kind" = CASE
  WHEN "collection" = 'link' THEN 'link'
  WHEN "type_code" = '10' THEN 'efectivo'
  WHEN "type_code" = '48' AND "collection" = 'al_recibir' THEN 'pos'
  ELSE 'otro' END;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "holder" text;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "bank_code" text;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "account_number" text;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD COLUMN "cci" text;--> statement-breakpoint
ALTER TABLE "store_payment_link_attempt" ADD CONSTRAINT "store_payment_link_attempt_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payment_link_trial" ADD CONSTRAINT "store_payment_link_trial_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_store_id_key" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "store_payment_qr" ADD CONSTRAINT "store_payment_qr_method_fkey" FOREIGN KEY ("store_id","method_id") REFERENCES "public"."store_payment_method"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_payment_link_attempt_store_idx" ON "store_payment_link_attempt" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "store_payment_link_trial_store_idx" ON "store_payment_link_trial" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "store_payment_link_user_idx" ON "store_payment_link" USING btree ("provider","provider_user_id");--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD CONSTRAINT "store_payment_link_mode_check" CHECK (mode IN ('prueba','real'));--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD CONSTRAINT "store_payment_link_label_check" CHECK (char_length("store_payment_link"."account_label") between 1 and 120);--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_kind_check" CHECK (kind IN ('yape','plin','transferencia','efectivo','pos','link','otro'));--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_kind_type_check" CHECK (case "store_payment_method"."kind"
        when 'yape' then "store_payment_method"."type_code" = '68' and "store_payment_method"."collection" = 'comprobante'
        when 'plin' then "store_payment_method"."type_code" = '68' and "store_payment_method"."collection" = 'comprobante'
        when 'transferencia' then "store_payment_method"."type_code" = '30' and "store_payment_method"."collection" = 'comprobante'
        when 'efectivo' then "store_payment_method"."type_code" = '10' and "store_payment_method"."collection" = 'al_recibir'
        when 'pos' then "store_payment_method"."type_code" = '48' and "store_payment_method"."collection" = 'al_recibir'
        when 'link' then "store_payment_method"."collection" = 'link'
        else "store_payment_method"."collection" <> 'link' end);--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_kind_data_check" CHECK (("store_payment_method"."kind" not in ('yape', 'plin') or ("store_payment_method"."phone" is not null and "store_payment_method"."holder" is not null))
        and ("store_payment_method"."kind" <> 'transferencia' or ("store_payment_method"."bank_code" is not null and "store_payment_method"."account_number" is not null and "store_payment_method"."holder" is not null)));--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_phone_check" CHECK ("store_payment_method"."phone" ~ '^[+][1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_holder_check" CHECK (char_length(btrim("store_payment_method"."holder")) between 1 and 80);--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_bank_check" CHECK ("store_payment_method"."bank_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_account_check" CHECK ("store_payment_method"."account_number" ~ '^[0-9][0-9 -]{4,28}[0-9]$');--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_cci_check" CHECK ("store_payment_method"."cci" ~ '^[0-9]{20}$');