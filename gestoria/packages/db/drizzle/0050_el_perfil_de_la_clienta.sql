-- El perfil de la clienta (lienzo «Clientas bien perfiladas y Argos que hace el marketing solo»):
-- lo que Argos sabe de ella con su fuente y su historial, el permiso para escribirle y hasta
-- dónde leyó Argos cada conversación. Todo nace vacío: nada se copia de lo de antes.
CREATE TABLE "argos_reading" (
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "argos_reading_store_id_conversation_id_pk" PRIMARY KEY("store_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "customer_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"message_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_consent_state_check" CHECK (state IN ('si','no','baja')),
	CONSTRAINT "customer_consent_channel_check" CHECK (channel IN ('whatsapp','instagram','messenger','prueba')),
	CONSTRAINT "customer_consent_quote_check" CHECK (char_length(btrim("customer_consent"."quote")) between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "customer_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"message_id" uuid,
	"order_id" uuid,
	"quote" text,
	"alternatives" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_fact_key_check" CHECK (key IN ('medida','distrito','cumpleanos','canal','instagram','gustos')),
	CONSTRAINT "customer_fact_source_check" CHECK (source IN ('chat','pedido','respuesta','tienda')),
	CONSTRAINT "customer_fact_value_check" CHECK (char_length(btrim("customer_fact"."value")) between 1 and 120 and ("customer_fact"."quote" is null or char_length("customer_fact"."quote") between 1 and 300) and cardinality("customer_fact"."alternatives") <= 4),
	CONSTRAINT "customer_fact_origin_check" CHECK (("customer_fact"."source" <> 'chat' or ("customer_fact"."message_id" is not null and "customer_fact"."quote" is not null)) and ("customer_fact"."source" <> 'pedido' or "customer_fact"."order_id" is not null)),
	CONSTRAINT "customer_fact_birthday_check" CHECK ("customer_fact"."key" <> 'cumpleanos' or "customer_fact"."value" ~ '^--(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
);
--> statement-breakpoint
ALTER TABLE "argos_reading" ADD CONSTRAINT "argos_reading_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_consent" ADD CONSTRAINT "customer_consent_customer_fkey" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_consent" ADD CONSTRAINT "customer_consent_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_fact" ADD CONSTRAINT "customer_fact_customer_fkey" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_consent_customer_idx" ON "customer_consent" USING btree ("store_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_consent_conversation_idx" ON "customer_consent" USING btree ("store_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_fact_customer_idx" ON "customer_fact" USING btree ("store_id","customer_id","key","created_at");