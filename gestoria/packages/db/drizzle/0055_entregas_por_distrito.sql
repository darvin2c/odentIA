-- Entregas por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7): desde dónde
-- despacha la tienda y quién paga el viaje fallido; el recojo con su horario y en cuánto está
-- listo; la agencia con sus nombres y su flete. Las zonas siguen en `zones` (jsonb), ahora con
-- sus distritos (UBIGEO del INEI), cuándo llegan, sus franjas, pago al recibir y envío gratis.
ALTER TABLE "store" ADD COLUMN "ship_from" text;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "failed_trip" text DEFAULT 'primera_tienda' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD COLUMN "opening_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD COLUMN "ready_in" text;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD COLUMN "agencies" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD COLUMN "freight" text;--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD COLUMN "freight_cents" integer;--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_ship_from_check" CHECK ("store"."ship_from" is null or "store"."ship_from" ~ '^[0-9]{6}$');--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_failed_trip_check" CHECK (failed_trip IN ('primera_tienda','clienta','tienda'));--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD CONSTRAINT "store_delivery_method_pickup_check" CHECK (jsonb_typeof("store_delivery_method"."opening_hours") = 'array' and jsonb_array_length("store_delivery_method"."opening_hours") <= 7 and ("store_delivery_method"."ready_in" is null or ready_in IN ('1h','2h','dia_siguiente')));--> statement-breakpoint
ALTER TABLE "store_delivery_method" ADD CONSTRAINT "store_delivery_method_agency_check" CHECK (jsonb_typeof("store_delivery_method"."agencies") = 'array' and jsonb_array_length("store_delivery_method"."agencies") <= 10 and ("store_delivery_method"."freight" is null or freight IN ('al_recoger','antes')) and (("store_delivery_method"."freight" = 'antes') = ("store_delivery_method"."freight_cents" is not null)) and ("store_delivery_method"."freight_cents" is null or "store_delivery_method"."freight_cents" > 0));--> statement-breakpoint
-- Las zonas de antes eran solo un nombre y un precio: quedan sin distritos, al día siguiente,
-- con el pago al recibir de su forma de entrega y con el envío gratis que ya tenía.
UPDATE "store_delivery_method" SET "zones" = (
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('districts', '[]'::jsonb, 'lead', 'manana', 'cutoff', null,
      'weekdays', '[]'::jsonb, 'slots', '[]'::jsonb,
      'payOnDelivery', "store_delivery_method"."accepts_pay_on_delivery", 'freeShipping', true)
    || z.value ORDER BY z.ordinality), '[]'::jsonb)
  FROM jsonb_array_elements("store_delivery_method"."zones") WITH ORDINALITY AS z(value, ordinality)
) WHERE jsonb_array_length("zones") > 0;
