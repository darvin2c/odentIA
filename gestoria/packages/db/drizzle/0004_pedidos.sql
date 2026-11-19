CREATE TABLE "order_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_event_action_check" CHECK (action IN ('creado','link','comprobante','pago_confirmado','pago_no_coincide','pago_link','salio','entregado','anulado','aviso'))
);
--> statement-breakpoint
CREATE TABLE "order_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"operation" text,
	"provider" text,
	"provider_ref" text,
	"photo_type" text,
	"photo" "bytea",
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "order_payment_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "order_payment_kind_check" CHECK (kind IN ('link','comprobante','al_recibir')),
	CONSTRAINT "order_payment_status_check" CHECK (status IN ('por_confirmar','confirmado','no_coincide')),
	CONSTRAINT "order_payment_amount_check" CHECK ("order_payment"."amount_cents" >= 0),
	CONSTRAINT "order_payment_texts_check" CHECK (("order_payment"."operation" is null or char_length("order_payment"."operation") between 1 and 60) and ("order_payment"."note" is null or char_length("order_payment"."note") <= 300)),
	CONSTRAINT "order_payment_photo_check" CHECK (("order_payment"."photo" is null) = ("order_payment"."photo_type" is null) and ("order_payment"."photo_type" is null or photo_type IN ('image/jpeg','image/png','image/webp')) and ("order_payment"."photo" is null or octet_length("order_payment"."photo") between 1 and 1500000)),
	CONSTRAINT "order_payment_reviewed_check" CHECK (("order_payment"."status" = 'por_confirmar') = ("order_payment"."reviewed_at" is null) and ("order_payment"."status" <> 'no_coincide' or char_length(btrim(coalesce("order_payment"."note", ''))) >= 3))
);
--> statement-breakpoint
CREATE TABLE "sale_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"channel" text NOT NULL,
	"conversation_id" text,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"address" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"delivery_method_id" uuid,
	"delivery_name" text NOT NULL,
	"delivery_type" text NOT NULL,
	"delivery_zone" text,
	"delivery_list_cents" integer NOT NULL,
	"delivery_cents" integer NOT NULL,
	"delivery_free_by_policy" boolean DEFAULT false NOT NULL,
	"payment_method_id" uuid,
	"payment_name" text NOT NULL,
	"payment_collection" text NOT NULL,
	"payment_details" text DEFAULT '' NOT NULL,
	"items_auto_cents" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"gift_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"margin_cents" integer DEFAULT 0 NOT NULL,
	"margin_used_cents" integer DEFAULT 0 NOT NULL,
	"price_expires_at" timestamp with time zone,
	"deliver_on" date,
	"tracking" text,
	"link_url" text,
	"link_ref" text,
	"link_expires_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_order_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "sale_order_number_key" UNIQUE("store_id","number"),
	CONSTRAINT "sale_order_state_check" CHECK (state IN ('por_pagar','por_confirmar','por_salir','en_camino','entregado','anulado')),
	CONSTRAINT "sale_order_channel_check" CHECK (channel IN ('whatsapp','instagram','messenger','otro')),
	CONSTRAINT "sale_order_number_check" CHECK ("sale_order"."number" > 0),
	CONSTRAINT "sale_order_customer_check" CHECK (char_length(btrim("sale_order"."customer_name")) between 1 and 120 and ("sale_order"."customer_phone" is null or char_length("sale_order"."customer_phone") <= 30) and char_length("sale_order"."address") <= 300 and char_length("sale_order"."notes") <= 500),
	CONSTRAINT "sale_order_payment_collection_check" CHECK (payment_collection IN ('link','comprobante','al_recibir')),
	CONSTRAINT "sale_order_amounts_check" CHECK ("sale_order"."delivery_cents" between 0 and "sale_order"."delivery_list_cents" and "sale_order"."subtotal_cents" >= 0 and "sale_order"."discount_cents" >= 0 and "sale_order"."gift_cents" >= 0 and "sale_order"."total_cents" = "sale_order"."subtotal_cents" + "sale_order"."delivery_cents" and "sale_order"."margin_used_cents" between 0 and "sale_order"."margin_cents"),
	CONSTRAINT "sale_order_cancel_check" CHECK (("sale_order"."state" = 'anulado') = ("sale_order"."cancel_reason" is not null) and ("sale_order"."cancel_reason" is null or char_length(btrim("sale_order"."cancel_reason")) between 3 and 300)),
	CONSTRAINT "sale_order_tracking_check" CHECK ("sale_order"."tracking" is null or char_length("sale_order"."tracking") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "sale_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"variant_name" text NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"list_unit_cents" integer NOT NULL,
	"auto_unit_cents" integer NOT NULL,
	"floor_unit_cents" integer NOT NULL,
	"unit_cents" integer NOT NULL,
	"gift" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sale_order_line_quantity_check" CHECK ("sale_order_line"."quantity" between 1 and 1000),
	CONSTRAINT "sale_order_line_price_check" CHECK ("sale_order_line"."floor_unit_cents" <= "sale_order_line"."auto_unit_cents" and "sale_order_line"."auto_unit_cents" <= "sale_order_line"."list_unit_cents" and (case when "sale_order_line"."gift" then "sale_order_line"."unit_cents" = 0 else "sale_order_line"."unit_cents" between "sale_order_line"."floor_unit_cents" and "sale_order_line"."auto_unit_cents" end))
);
--> statement-breakpoint
CREATE TABLE "store_payment_link" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"webhook_secret_enc" text,
	"hint" text NOT NULL,
	"connected_by" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_payment_link_provider_check" CHECK (provider IN ('mercadopago')),
	CONSTRAINT "store_payment_link_hint_check" CHECK (char_length("store_payment_link"."hint") between 1 and 8)
);
--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_order_fkey" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_order_fkey" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_line" ADD CONSTRAINT "sale_order_line_order_fkey" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_line" ADD CONSTRAINT "sale_order_line_variant_fkey" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."product_variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD CONSTRAINT "store_payment_link_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_event_order_idx" ON "order_event" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_provider_uidx" ON "order_payment" USING btree ("store_id","provider","provider_ref") WHERE provider_ref is not null;--> statement-breakpoint
CREATE INDEX "order_payment_order_idx" ON "order_payment" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_order_state_idx" ON "sale_order" USING btree ("store_id","state","created_at");--> statement-breakpoint
CREATE INDEX "sale_order_line_order_idx" ON "sale_order_line" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "sale_order_line_variant_idx" ON "sale_order_line" USING btree ("variant_id");