-- La ficha del producto (lienzo «La ficha del producto»): el rubro y sus datos con la plantilla que
-- ajusta cada tienda, los colores (su hex y su foto), a qué color pertenece cada foto, el estado que
-- pone la tienda, el paquete para la agencia, el código del producto y el de barras de cada
-- variante, las palabras con que lo buscan, si se ve en la web, lo que Sofi no supo y el historial
-- de cada cambio. Lo del precio va aparte (`0036_el_precio_de_la_ficha.sql`).
CREATE TABLE "product_color" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"value" text NOT NULL,
	"hex" text,
	"hex2" text,
	"photo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_color_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "product_color_value_check" CHECK (char_length(btrim("product_color"."value")) between 1 and 30),
	CONSTRAINT "product_color_hex_check" CHECK (("product_color"."hex" is null or "product_color"."hex" ~ '^#[0-9a-f]{6}$') and ("product_color"."hex2" is null or ("product_color"."hex" is not null and "product_color"."hex2" ~ '^#[0-9a-f]{6}$')))
);
--> statement-breakpoint
CREATE TABLE "product_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_event_action_check" CHECK (action IN ('creado','cambiado','cuadricula','foto','pregunta')),
	CONSTRAINT "product_event_changes_check" CHECK (jsonb_typeof("product_event"."changes") = 'array' and ("product_event"."reason" is null or char_length("product_event"."reason") <= 300))
);
--> statement-breakpoint
CREATE TABLE "product_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"conversation_id" uuid,
	"question" text NOT NULL,
	"asked_by" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"save_requested" boolean DEFAULT false NOT NULL,
	"saved_by" text,
	"saved_at" timestamp with time zone,
	CONSTRAINT "product_question_texts_check" CHECK (char_length(btrim("product_question"."question")) between 3 and 500 and ("product_question"."answer" is null or char_length(btrim("product_question"."answer")) between 1 and 1000)),
	CONSTRAINT "product_question_answer_check" CHECK (("product_question"."answer" is null) = ("product_question"."answered_by" is null) and ("product_question"."answer" is null) = ("product_question"."answered_at" is null) and ("product_question"."saved_at" is null) = ("product_question"."saved_by" is null) and ("product_question"."saved_at" is null or "product_question"."answer" is not null) and (not "product_question"."save_requested" or ("product_question"."answer" is not null and "product_question"."saved_at" is null)))
);
--> statement-breakpoint
CREATE TABLE "store_template_field" (
	"store_id" uuid NOT NULL,
	"rubro" text NOT NULL,
	"key" text NOT NULL,
	"position" smallint NOT NULL,
	"needed" boolean NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"label" text,
	"type" text,
	"options" text[],
	"columns" text[],
	"unit" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_template_field_pkey" PRIMARY KEY("store_id","rubro","key"),
	CONSTRAINT "store_template_field_rubro_check" CHECK (rubro IN ('calzado','ropa','cosmetica','tecnologia','hogar')),
	CONSTRAINT "store_template_field_key_check" CHECK ("store_template_field"."key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "store_template_field_own_check" CHECK (("store_template_field"."label" is null) = ("store_template_field"."type" is null) and ("store_template_field"."type" is null or type IN ('opcion','numero','texto','por_talla','tabla','fecha')) and ("store_template_field"."label" is null or char_length(btrim("store_template_field"."label")) between 1 and 60) and ("store_template_field"."label" is not null or ("store_template_field"."options" is null and "store_template_field"."columns" is null and "store_template_field"."unit" is null))),
	CONSTRAINT "store_template_field_values_check" CHECK (("store_template_field"."options" is null or cardinality("store_template_field"."options") between 1 and 20) and ("store_template_field"."columns" is null or cardinality("store_template_field"."columns") between 1 and 6) and ("store_template_field"."unit" is null or char_length(btrim("store_template_field"."unit")) between 1 and 12))
);
--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "color_option" smallint;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "rubro" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "rubro_data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "status_days" smallint;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "status_per_day" smallint;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "status_date" date;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_weight_g" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_length_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_width_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "package_height_mm" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "web_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "web_slug" text;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "color_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "product_color" ADD CONSTRAINT "product_color_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_color" ADD CONSTRAINT "product_color_photo_fkey" FOREIGN KEY ("store_id","photo_id") REFERENCES "public"."product_photo"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_event" ADD CONSTRAINT "product_event_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_question" ADD CONSTRAINT "product_question_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_question" ADD CONSTRAINT "product_question_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_template_field" ADD CONSTRAINT "store_template_field_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_color_value_uidx" ON "product_color" USING btree ("product_id",lower("value"));--> statement-breakpoint
CREATE INDEX "product_event_product_idx" ON "product_event" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "product_question_product_idx" ON "product_question" USING btree ("product_id","asked_at");--> statement-breakpoint
CREATE INDEX "product_question_open_idx" ON "product_question" USING btree ("store_id","asked_at") WHERE answer is null or save_requested;--> statement-breakpoint
ALTER TABLE "product_photo" ADD CONSTRAINT "product_photo_color_fkey" FOREIGN KEY ("store_id","color_id") REFERENCES "public"."product_color"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_store_code_uidx" ON "product" USING btree ("store_id",lower("code")) WHERE code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_store_web_slug_uidx" ON "product" USING btree ("store_id","web_slug") WHERE web_slug is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variant_barcode_uidx" ON "product_variant" USING btree ("store_id","barcode") WHERE removed_at is null and barcode is not null;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_color_option_check" CHECK ("product"."color_option" is null or "product"."color_option" between 0 and 2);--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_rubro_check" CHECK ("product"."rubro" is null or rubro IN ('calzado','ropa','cosmetica','tecnologia','hogar'));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_rubro_data_check" CHECK (jsonb_typeof("product"."rubro_data") = 'object');--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_code_check" CHECK ("product"."code" is null or "product"."code" ~ '^[A-Za-z0-9._/-]{1,40}$');--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_status_check" CHECK (("product"."status" is null or status IN ('encargo','cupo','preventa','liquidacion','no_se_vende')) and coalesce("product"."status" = 'encargo', false) = ("product"."status_days" is not null) and coalesce("product"."status" = 'cupo', false) = ("product"."status_per_day" is not null) and coalesce("product"."status" = 'preventa', false) = ("product"."status_date" is not null) and ("product"."status_days" is null or "product"."status_days" between 1 and 365) and ("product"."status_per_day" is null or "product"."status_per_day" between 1 and 1000));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_package_check" CHECK (("product"."package_weight_g" is null or "product"."package_weight_g" between 1 and 1000000) and (("product"."package_length_mm" is null and "product"."package_width_mm" is null and "product"."package_height_mm" is null) or ("product"."package_length_mm" between 1 and 10000 and "product"."package_width_mm" between 1 and 10000 and "product"."package_height_mm" between 1 and 10000)));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_keywords_check" CHECK (cardinality("product"."keywords") <= 30);--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_web_slug_check" CHECK ("product"."web_slug" is null or ("product"."web_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("product"."web_slug") <= 80));--> statement-breakpoint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_barcode_check" CHECK ("product_variant"."barcode" is null or "product_variant"."barcode" ~ '^([0-9]{8}|[0-9]{12,14})$');--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro','soporte.salio','configuracion.tienda','configuracion.marca','catalogo.plantilla'));--> statement-breakpoint
-- La opción del color de los productos que ya existen: la que se llama así.
UPDATE "product" SET "color_option" = found.i
FROM (
  SELECT p.id, min(e.ordinality - 1)::smallint AS i
  FROM "product" p, jsonb_array_elements(p.options) WITH ORDINALITY e
  WHERE lower(btrim(e.value->>'name')) IN ('color', 'colores', 'tono', 'tonos')
  GROUP BY p.id
) found
WHERE "product".id = found.id;
