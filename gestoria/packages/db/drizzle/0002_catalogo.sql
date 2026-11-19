CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text DEFAULT '' NOT NULL,
	"list_price_cents" integer NOT NULL,
	"min_price_cents" integer,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "product_name_check" CHECK (char_length(btrim("product"."name")) between 1 and 120),
	CONSTRAINT "product_category_check" CHECK ("product"."category" is null or char_length(btrim("product"."category")) between 1 and 60),
	CONSTRAINT "product_description_check" CHECK (char_length("product"."description") <= 2000),
	CONSTRAINT "product_price_check" CHECK ("product"."list_price_cents" > 0),
	CONSTRAINT "product_min_price_check" CHECK ("product"."min_price_cents" is null or ("product"."min_price_cents" > 0 and "product"."min_price_cents" <= "product"."list_price_cents")),
	CONSTRAINT "product_options_check" CHECK (jsonb_typeof("product"."options") = 'array' and jsonb_array_length("product"."options") <= 3)
);
--> statement-breakpoint
CREATE TABLE "product_link" (
	"store_id" uuid NOT NULL,
	"product_a" uuid NOT NULL,
	"product_b" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "product_link_pkey" PRIMARY KEY("product_a","product_b","kind"),
	CONSTRAINT "product_link_kind_check" CHECK (kind IN ('parecido','combina')),
	CONSTRAINT "product_link_order_check" CHECK ("product_link"."product_a" < "product_link"."product_b")
);
--> statement-breakpoint
CREATE TABLE "product_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_photo_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "product_photo_type_check" CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "product_photo_size_check" CHECK (octet_length("product_photo"."content") between 1 and 1500000)
);
--> statement-breakpoint
CREATE TABLE "product_promotion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"percent_off" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_promotion_name_check" CHECK (char_length(btrim("product_promotion"."name")) between 1 and 60),
	CONSTRAINT "product_promotion_percent_check" CHECK ("product_promotion"."percent_off" between 1 and 90),
	CONSTRAINT "product_promotion_dates_check" CHECK ("product_promotion"."ends_on" >= "product_promotion"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "product_quantity_price" (
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"min_quantity" smallint NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "product_quantity_price_pkey" PRIMARY KEY("product_id","min_quantity"),
	CONSTRAINT "product_quantity_price_quantity_check" CHECK ("product_quantity_price"."min_quantity" between 2 and 1000),
	CONSTRAINT "product_quantity_price_price_check" CHECK ("product_quantity_price"."unit_price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"option_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"sku" text NOT NULL,
	"price_cents" integer,
	"photo_id" uuid,
	"stock" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variant_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "product_variant_sku_check" CHECK ("product_variant"."sku" ~ '^[A-Za-z0-9._/-]{1,40}$'),
	CONSTRAINT "product_variant_price_check" CHECK ("product_variant"."price_cents" is null or "product_variant"."price_cents" > 0),
	CONSTRAINT "product_variant_stock_check" CHECK ("product_variant"."stock" >= 0),
	CONSTRAINT "product_variant_values_check" CHECK (cardinality("product_variant"."option_values") <= 3)
);
--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer,
	"reason" text,
	"reference" text,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_kind_check" CHECK (kind IN ('entrada','venta','anulacion','ajuste')),
	CONSTRAINT "stock_movement_sign_check" CHECK (case "stock_movement"."kind" when 'entrada' then "stock_movement"."quantity" > 0 when 'anulacion' then "stock_movement"."quantity" > 0 when 'venta' then "stock_movement"."quantity" < 0 else "stock_movement"."quantity" <> 0 end),
	CONSTRAINT "stock_movement_reason_check" CHECK (("stock_movement"."kind" <> 'ajuste' or char_length(btrim(coalesce("stock_movement"."reason", ''))) >= 3) and ("stock_movement"."reason" is null or char_length("stock_movement"."reason") <= 300)),
	CONSTRAINT "stock_movement_cost_check" CHECK ("stock_movement"."unit_cost_cents" is null or ("stock_movement"."kind" = 'entrada' and "stock_movement"."unit_cost_cents" >= 0)),
	CONSTRAINT "stock_movement_reference_check" CHECK (("stock_movement"."kind" in ('venta','anulacion')) = ("stock_movement"."reference" is not null) and ("stock_movement"."reference" is null or char_length("stock_movement"."reference") between 1 and 80)),
	CONSTRAINT "stock_movement_balance_check" CHECK ("stock_movement"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_delivery_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"cost" text NOT NULL,
	"price_cents" integer,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eta" text DEFAULT '' NOT NULL,
	"accepts_pay_on_delivery" boolean DEFAULT false NOT NULL,
	"max_discount_cents" integer,
	"free_from_cents" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_delivery_method_name_check" CHECK (char_length(btrim("store_delivery_method"."name")) between 1 and 80),
	CONSTRAINT "store_delivery_method_type_check" CHECK (type IN ('DeliveryModeOwnFleet','OnSitePickup','ParcelService','DeliveryModeMail','LockerDelivery')),
	CONSTRAINT "store_delivery_method_cost_check" CHECK (cost IN ('gratis','fijo','por_zona','se_acuerda')),
	CONSTRAINT "store_delivery_method_price_check" CHECK (("store_delivery_method"."cost" = 'fijo') = ("store_delivery_method"."price_cents" is not null) and ("store_delivery_method"."price_cents" is null or "store_delivery_method"."price_cents" >= 0)),
	CONSTRAINT "store_delivery_method_zones_check" CHECK (jsonb_typeof("store_delivery_method"."zones") = 'array' and (("store_delivery_method"."cost" = 'por_zona') = (jsonb_array_length("store_delivery_method"."zones") > 0))),
	CONSTRAINT "store_delivery_method_deal_check" CHECK (("store_delivery_method"."max_discount_cents" is null and "store_delivery_method"."free_from_cents" is null) or "store_delivery_method"."cost" in ('fijo','por_zona')),
	CONSTRAINT "store_delivery_method_deal_amounts_check" CHECK (("store_delivery_method"."max_discount_cents" is null or "store_delivery_method"."max_discount_cents" > 0) and ("store_delivery_method"."free_from_cents" is null or "store_delivery_method"."free_from_cents" > 0)),
	CONSTRAINT "store_delivery_method_texts_check" CHECK (char_length("store_delivery_method"."details") <= 300 and char_length("store_delivery_method"."eta") <= 120)
);
--> statement-breakpoint
CREATE TABLE "store_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type_code" text NOT NULL,
	"collection" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_payment_method_name_check" CHECK (char_length(btrim("store_payment_method"."name")) between 1 and 80),
	CONSTRAINT "store_payment_method_type_check" CHECK (type_code IN ('68','30','48','10','1')),
	CONSTRAINT "store_payment_method_collection_check" CHECK (collection IN ('link','comprobante','al_recibir')),
	CONSTRAINT "store_payment_method_cash_check" CHECK ("store_payment_method"."type_code" <> '10' or "store_payment_method"."collection" = 'al_recibir'),
	CONSTRAINT "store_payment_method_details_check" CHECK (char_length("store_payment_method"."details") <= 500)
);
--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_link" ADD CONSTRAINT "product_link_a_fkey" FOREIGN KEY ("store_id","product_a") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_link" ADD CONSTRAINT "product_link_b_fkey" FOREIGN KEY ("store_id","product_b") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photo" ADD CONSTRAINT "product_photo_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_promotion" ADD CONSTRAINT "product_promotion_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_quantity_price" ADD CONSTRAINT "product_quantity_price_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_photo_fkey" FOREIGN KEY ("store_id","photo_id") REFERENCES "public"."product_photo"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_variant_fkey" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."product_variant"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD CONSTRAINT "store_delivery_method_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_payment_method" ADD CONSTRAINT "store_payment_method_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_store_name_uidx" ON "product" USING btree ("store_id",lower("name"));--> statement-breakpoint
CREATE INDEX "product_link_b_idx" ON "product_link" USING btree ("product_b");--> statement-breakpoint
CREATE INDEX "product_photo_product_idx" ON "product_photo" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "product_promotion_product_idx" ON "product_promotion" USING btree ("product_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variant_sku_uidx" ON "product_variant" USING btree ("store_id",lower("sku")) WHERE removed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variant_values_uidx" ON "product_variant" USING btree ("product_id","option_values") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "product_variant_product_idx" ON "product_variant" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_movement_variant_idx" ON "stock_movement" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_reference_uidx" ON "stock_movement" USING btree ("store_id","variant_id","reference","kind") WHERE reference is not null;--> statement-breakpoint
CREATE INDEX "store_delivery_method_store_idx" ON "store_delivery_method" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "store_payment_method_store_idx" ON "store_payment_method" USING btree ("store_id");--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja'));