-- Los avisos al celular (lienzo «gestorIA como odentIA», tablero 15): cada celular que recibe los
-- avisos de una persona (`push_device`, su suscripción del navegador) y lo que eligió recibir de
-- cada tienda, con hasta dónde ya miró el sistema (`push_choice`, unido a su lugar en el equipo).
CREATE TABLE "push_choice" (
	"store_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kinds" text[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_seq" bigint,
	"chats_seen" uuid[],
	CONSTRAINT "push_choice_pkey" PRIMARY KEY("store_id","user_id"),
	CONSTRAINT "push_choice_kinds_check" CHECK ("push_choice"."kinds" is null or "push_choice"."kinds" <@ array['pagos','chats','no_entregado','sofi_pedido','dinero']::text[])
);
--> statement-breakpoint
CREATE TABLE "push_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"welcomed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_device_endpoint_key" UNIQUE("endpoint"),
	CONSTRAINT "push_device_keys_check" CHECK (char_length("push_device"."endpoint") between 10 and 1000 and char_length("push_device"."p256dh") between 1 and 200 and char_length("push_device"."auth") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "push_choice" ADD CONSTRAINT "push_choice_member_fkey" FOREIGN KEY ("store_id","user_id") REFERENCES "public"."store_member"("store_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_device" ADD CONSTRAINT "push_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."account_copy"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_device_user_idx" ON "push_device" USING btree ("user_id","created_at");