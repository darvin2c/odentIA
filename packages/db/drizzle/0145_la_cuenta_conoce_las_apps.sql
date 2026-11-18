CREATE TABLE "auth"."account_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"app" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "account_event_app_check" CHECK (app IN ('odentia','latidia','vistia','gestoria')),
	CONSTRAINT "account_event_type_check" CHECK (type IN ('cuenta.cerrada'))
);
--> statement-breakpoint
CREATE TABLE "auth"."jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "signup_app" text;--> statement-breakpoint
CREATE INDEX "account_event_pending_idx" ON "auth"."account_event" USING btree ("app","next_attempt_at") WHERE delivered_at IS NULL;--> statement-breakpoint
ALTER TABLE "auth"."user" ADD CONSTRAINT "user_signup_app_check" CHECK (signup_app IS NULL OR signup_app IN ('odentia','latidia','vistia','gestoria'));--> statement-breakpoint
-- Reglas (ADR 0063 y 0201). Better Auth lee y crea las llaves del token firmado con el rol de
-- la aplicación: solo leer y agregar (no las cambia ni las borra; rotar es agregar otra).
-- `account_event` no recibe nada: la escriben y la mandan la conexión propietaria (cerrar
-- una cuenta) y el trabajador.
GRANT SELECT, INSERT ON TABLE auth.jwks TO dentalagent_app;