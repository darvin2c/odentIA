-- «Tu marca» y los datos de la tienda (lienzo «gestorIA como odentIA», tablero 10): el nombre que
-- ve el cliente y el color de marca en la tienda; el logo y la portada en `store_image`; el nombre
-- del link en `store_link`, uno vigente por tienda y los de antes guardados para ella.
CREATE TABLE "store_image" (
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_image_pkey" PRIMARY KEY("store_id","kind"),
	CONSTRAINT "store_image_kind_check" CHECK (kind IN ('logo','portada')),
	CONSTRAINT "store_image_type_check" CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "store_image_size_check" CHECK (octet_length("store_image"."content") between 1 and 1500000)
);
--> statement-breakpoint
CREATE TABLE "store_link" (
	"name" text PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_link_name_check" CHECK ("store_link"."name" ~ '^[a-z0-9](-?[a-z0-9]){2,62}$' and char_length("store_link"."name") <= 63)
);
--> statement-breakpoint
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "public_name" text;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "store_image" ADD CONSTRAINT "store_image_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_link" ADD CONSTRAINT "store_link_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_link_current_uidx" ON "store_link" USING btree ("store_id") WHERE "store_link"."current";--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_public_name_check" CHECK ("store"."public_name" is null or char_length(btrim("store"."public_name")) between 1 and 80);--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_brand_color_check" CHECK ("store"."brand_color" is null or "store"."brand_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro','soporte.salio','configuracion.tienda','configuracion.marca'));