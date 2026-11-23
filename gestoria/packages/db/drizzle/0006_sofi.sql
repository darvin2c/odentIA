CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"customer_name" text,
	"handler" text DEFAULT 'sofi' NOT NULL,
	"waiting_reason" text,
	"last_customer_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "conversation_channel_check" CHECK (channel IN ('whatsapp','instagram','messenger','prueba')),
	CONSTRAINT "conversation_handler_check" CHECK (handler IN ('sofi','persona')),
	CONSTRAINT "conversation_texts_check" CHECK (("conversation"."customer_name" is null or char_length(btrim("conversation"."customer_name")) between 1 and 120) and ("conversation"."waiting_reason" is null or char_length(btrim("conversation"."waiting_reason")) between 3 and 200))
);
--> statement-breakpoint
CREATE TABLE "conversation_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "conversation_message_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"author" text NOT NULL,
	"text" text NOT NULL,
	"delivery" text,
	"needs_template" boolean DEFAULT false NOT NULL,
	"follow_up" text,
	"follow_up_ref" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_message_author_check" CHECK (author IN ('cliente','sofi','persona')),
	CONSTRAINT "conversation_message_text_check" CHECK (char_length(btrim("conversation_message"."text")) between 1 and 4000),
	CONSTRAINT "conversation_message_delivery_check" CHECK (("conversation_message"."delivery" is null or delivery IN ('prueba','sin_enviar')) and (("conversation_message"."author" = 'cliente') = ("conversation_message"."delivery" is null))),
	CONSTRAINT "conversation_message_follow_check" CHECK (("conversation_message"."follow_up" is null) = ("conversation_message"."follow_up_ref" is null) and ("conversation_message"."follow_up" is null or (follow_up IN ('pago','gracias','volvio','volver') and "conversation_message"."author" = 'sofi')))
);
--> statement-breakpoint
CREATE TABLE "stock_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "store_agent" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"knowledge" text DEFAULT '' NOT NULL,
	"follow_payment" boolean DEFAULT true NOT NULL,
	"follow_thanks" boolean DEFAULT true NOT NULL,
	"follow_restock" boolean DEFAULT true NOT NULL,
	"follow_return" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_agent_texts_check" CHECK (("store_agent"."display_name" is null or char_length(btrim("store_agent"."display_name")) between 1 and 60) and char_length("store_agent"."knowledge") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "sale_order" ALTER COLUMN "conversation_id" SET DATA TYPE uuid USING "conversation_id"::uuid;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_request" ADD CONSTRAINT "stock_request_variant_fkey" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."product_variant"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_request" ADD CONSTRAINT "stock_request_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_agent" ADD CONSTRAINT "store_agent_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_store_idx" ON "conversation" USING btree ("store_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_message_conversation_idx" ON "conversation_message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_message_follow_uidx" ON "conversation_message" USING btree ("store_id","conversation_id","follow_up","follow_up_ref") WHERE follow_up is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_request_open_uidx" ON "stock_request" USING btree ("variant_id","conversation_id") WHERE notified_at is null;--> statement-breakpoint
CREATE INDEX "stock_request_store_idx" ON "stock_request" USING btree ("store_id","variant_id");--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_order_conversation_idx" ON "sale_order" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi'));