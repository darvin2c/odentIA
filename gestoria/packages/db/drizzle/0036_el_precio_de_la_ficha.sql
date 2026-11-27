-- El precio de la ficha del producto (lienzo «La ficha del producto», tablero 15): el precio para
-- revendedoras (por mayor), el combo con lo que combina, lo que Sofi puede ofrecer de cada producto
-- y las promociones solo de un color o de una talla. Todo se calcula en `apps/api/src/precio.ts`,
-- la misma regla para la ficha, los pedidos y Sofi (ADR 0207 y 0224). Lo que ya había queda como
-- estaba: sin por mayor ni combo, las promociones de todo el producto y Sofi ofrece lo de siempre
-- (el envío y unos soles), sin regalo hasta que la tienda diga cuál.
ALTER TABLE "product" ADD COLUMN "wholesale_min_quantity" smallint;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "wholesale_price_cents" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "combo_percent_off" smallint;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "offer_delivery" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "offer_discount" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "offer_second_unit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "offer_gift" text;--> statement-breakpoint
ALTER TABLE "product_promotion" ADD COLUMN "option_index" smallint;--> statement-breakpoint
ALTER TABLE "product_promotion" ADD COLUMN "option_value" text;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_wholesale_check" CHECK (("product"."wholesale_min_quantity" is null) = ("product"."wholesale_price_cents" is null) and ("product"."wholesale_min_quantity" is null or ("product"."wholesale_min_quantity" between 2 and 10000 and "product"."wholesale_price_cents" > 0 and "product"."wholesale_price_cents" < "product"."list_price_cents")));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_offers_check" CHECK (("product"."combo_percent_off" is null or "product"."combo_percent_off" between 1 and 90) and ("product"."offer_gift" is null or char_length(btrim("product"."offer_gift")) between 1 and 80));--> statement-breakpoint
ALTER TABLE "product_promotion" ADD CONSTRAINT "product_promotion_scope_check" CHECK (("product_promotion"."option_index" is null) = ("product_promotion"."option_value" is null) and ("product_promotion"."option_index" is null or ("product_promotion"."option_index" between 0 and 2 and char_length(btrim("product_promotion"."option_value")) between 1 and 30)));