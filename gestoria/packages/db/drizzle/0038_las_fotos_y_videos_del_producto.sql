-- Las fotos y los videos del producto fuera de la base (ADR 0236): la foto guarda dónde está en el
-- almacenamiento (`object_key`), su peso, su tamaño y la propuesta de quitar el fondo; el video
-- corto de un producto o de un color es `product_video`; «Cargar muchos» es `bulk_load`, con sus
-- productos (`bulk_load_item`) y sus fotos (`bulk_load_photo`); `media_trash`, lo que queda por
-- borrar del almacenamiento. `content` queda por ahora: la imagen anterior del servidor lo lee
-- mientras se cambia, y las fotos de antes se mudan solas.
CREATE TABLE "bulk_load" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"state" text DEFAULT 'abierta' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_by" text,
	"finished_at" timestamp with time zone,
	"created_products" integer,
	CONSTRAINT "bulk_load_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "bulk_load_state_check" CHECK (state IN ('abierta','creada','descartada') and ("bulk_load"."state" = 'abierta') = ("bulk_load"."finished_at" is null) and ("bulk_load"."state" = 'creada') = ("bulk_load"."created_products" is not null))
);
--> statement-breakpoint
CREATE TABLE "bulk_load_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'revisar' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"category" text,
	"description" text DEFAULT '' NOT NULL,
	"list_price_cents" bigint,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"doubt" text,
	"sheet_row" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_load_item_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "bulk_load_item_check" CHECK (state IN ('revisar','listo','quitado') and char_length("bulk_load_item"."name") <= 120 and ("bulk_load_item"."category" is null or char_length("bulk_load_item"."category") <= 60) and char_length("bulk_load_item"."description") <= 2000 and ("bulk_load_item"."doubt" is null or char_length("bulk_load_item"."doubt") <= 200) and ("bulk_load_item"."list_price_cents" is null or "bulk_load_item"."list_price_cents" between 1 and 100000000) and jsonb_typeof("bulk_load_item"."options") = 'array' and jsonb_typeof("bulk_load_item"."variants") = 'array' and jsonb_array_length("bulk_load_item"."variants") <= 200)
);
--> statement-breakpoint
CREATE TABLE "bulk_load_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"item_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_load_photo_check" CHECK (content_type IN ('image/jpeg','image/png','image/webp') and char_length("bulk_load_photo"."file_name") <= 200 and "bulk_load_photo"."object_key" ~ '^[a-z0-9/-]{1,200}$' and "bulk_load_photo"."size_bytes" between 1 and 8000000)
);
--> statement-breakpoint
CREATE TABLE "media_trash" (
	"object_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_video" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"color_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_video_check" CHECK (char_length("product_video"."label") <= 60 and "product_video"."object_key" ~ '^[a-z0-9/-]{1,200}$' and "product_video"."size_bytes" between 1 and 16000000 and "product_video"."duration_ms" between 1 and 30000 and "product_video"."width" between 1 and 4096 and "product_video"."height" between 1 and 4096)
);
--> statement-breakpoint
ALTER TABLE "product_photo" DROP CONSTRAINT "product_photo_size_check";--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "product_photo" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "product_photo" ADD COLUMN "cutout" text;--> statement-breakpoint
ALTER TABLE "bulk_load" ADD CONSTRAINT "bulk_load_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_load_item" ADD CONSTRAINT "bulk_load_item_load_fkey" FOREIGN KEY ("store_id","load_id") REFERENCES "public"."bulk_load"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_load_photo" ADD CONSTRAINT "bulk_load_photo_load_fkey" FOREIGN KEY ("store_id","load_id") REFERENCES "public"."bulk_load"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_load_photo" ADD CONSTRAINT "bulk_load_photo_item_fkey" FOREIGN KEY ("store_id","item_id") REFERENCES "public"."bulk_load_item"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_video" ADD CONSTRAINT "product_video_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_video" ADD CONSTRAINT "product_video_color_fkey" FOREIGN KEY ("store_id","color_id") REFERENCES "public"."product_color"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_load_store_idx" ON "bulk_load" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "bulk_load_item_load_idx" ON "bulk_load_item" USING btree ("load_id","position");--> statement-breakpoint
CREATE INDEX "bulk_load_photo_load_idx" ON "bulk_load_photo" USING btree ("load_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_video_color_uidx" ON "product_video" USING btree ("product_id",coalesce("color_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "product_photo" ADD CONSTRAINT "product_photo_where_check" CHECK (("product_photo"."content" is not null or "product_photo"."object_key" is not null) and ("product_photo"."object_key" is null or "product_photo"."object_key" ~ '^[a-z0-9/-]{1,200}$') and ("product_photo"."size_bytes" is null or "product_photo"."size_bytes" between 1 and 8000000) and ("product_photo"."cutout" is null or ("product_photo"."object_key" is not null and cutout IN ('propuesta','usada'))));--> statement-breakpoint
ALTER TABLE "product_photo" ADD CONSTRAINT "product_photo_size_check" CHECK ("product_photo"."content" is null or octet_length("product_photo"."content") between 1 and 1500000);--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro','soporte.salio','configuracion.tienda','configuracion.marca','catalogo.plantilla','catalogo.carga'));