-- Cambios y devoluciones después de entregar (entrega 8 de «gestorIA como odentIA», tablero 17).
-- El pedido entregado no se toca: el cambio es un pedido nuevo enlazado (`exchange_of_id`), con lo
-- que se lleva en sus líneas y lo que vuelve en `sale_order_return`. Lo que vuelve vale lo que se
-- pagó y se descuenta del total (`return_credit_cents`): un total bajo cero es lo que la tienda
-- devuelve. Lo que vuelve entra al kardex como «devolución», con su motivo y su pedido.
CREATE TABLE "sale_order_return" (
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
	"unit_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"returned_at" timestamp with time zone,
	CONSTRAINT "sale_order_return_quantity_check" CHECK ("sale_order_return"."quantity" between 1 and 1000),
	CONSTRAINT "sale_order_return_price_check" CHECK ("sale_order_return"."unit_cents" >= 0),
	CONSTRAINT "sale_order_return_reason_check" CHECK (char_length(btrim("sale_order_return"."reason")) between 3 and 120)
);
--> statement-breakpoint
ALTER TABLE "order_event" DROP CONSTRAINT "order_event_action_check";--> statement-breakpoint
ALTER TABLE "sale_order" DROP CONSTRAINT "sale_order_amounts_check";--> statement-breakpoint
ALTER TABLE "stock_movement" DROP CONSTRAINT "stock_movement_kind_check";--> statement-breakpoint
ALTER TABLE "stock_movement" DROP CONSTRAINT "stock_movement_sign_check";--> statement-breakpoint
ALTER TABLE "stock_movement" DROP CONSTRAINT "stock_movement_reason_check";--> statement-breakpoint
ALTER TABLE "stock_movement" DROP CONSTRAINT "stock_movement_reference_check";--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "exchange_of_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "return_credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_order_return" ADD CONSTRAINT "sale_order_return_order_fkey" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_return" ADD CONSTRAINT "sale_order_return_variant_fkey" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."product_variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_order_return_variant_uidx" ON "sale_order_return" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE INDEX "sale_order_return_variant_idx" ON "sale_order_return" USING btree ("variant_id");--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_exchange_fkey" FOREIGN KEY ("store_id","exchange_of_id") REFERENCES "public"."sale_order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_order_exchange_idx" ON "sale_order" USING btree ("exchange_of_id");--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_action_check" CHECK (action IN ('creado','link','comprobante','pago_confirmado','pago_no_coincide','pago_link','salio','entregado','anulado','aviso','cambiado','no_entregado','reprogramado','pago_deshecho','repartidor','envio','cambio'));--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_exchange_check" CHECK ("sale_order"."return_credit_cents" >= 0 and ("sale_order"."exchange_of_id" is not null or "sale_order"."return_credit_cents" = 0) and ("sale_order"."exchange_of_id" is null or "sale_order"."exchange_of_id" <> "sale_order"."id"));--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_amounts_check" CHECK ("sale_order"."delivery_cents" between 0 and "sale_order"."delivery_list_cents" and "sale_order"."subtotal_cents" >= 0 and "sale_order"."discount_cents" >= 0 and "sale_order"."gift_cents" >= 0 and "sale_order"."total_cents" = "sale_order"."subtotal_cents" + "sale_order"."delivery_cents" - "sale_order"."return_credit_cents" and "sale_order"."margin_used_cents" between 0 and "sale_order"."margin_cents");--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_kind_check" CHECK (kind IN ('entrada','venta','anulacion','ajuste','devolucion'));--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_sign_check" CHECK (case "stock_movement"."kind" when 'entrada' then "stock_movement"."quantity" > 0 when 'anulacion' then "stock_movement"."quantity" > 0 when 'devolucion' then "stock_movement"."quantity" > 0 when 'venta' then "stock_movement"."quantity" < 0 else "stock_movement"."quantity" <> 0 end);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_reason_check" CHECK (("stock_movement"."kind" not in ('ajuste','devolucion') or char_length(btrim(coalesce("stock_movement"."reason", ''))) >= 3) and ("stock_movement"."reason" is null or char_length("stock_movement"."reason") <= 300));--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_reference_check" CHECK (("stock_movement"."kind" in ('venta','anulacion','devolucion')) = ("stock_movement"."reference" is not null) and ("stock_movement"."reference" is null or char_length("stock_movement"."reference") between 1 and 80));