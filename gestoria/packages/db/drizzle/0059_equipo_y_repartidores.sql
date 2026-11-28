-- Equipo y repartidores (lienzo «gestorIA · Configuración, de nuevo», tablero 9; ADR 0235). La
-- invitación al equipo lleva el nombre y el celular de quien se invita, para escribirle por
-- WhatsApp desde el celular de la tienda, y cuándo se abrió ese WhatsApp («enviada por ti»: lo envía
-- la persona, gestorIA no sabe si llegó). El repartidor lleva su celular y lo que la tienda le paga
-- por entrega (y si el viaje fallido se le paga): lo anota la tienda; gestorIA no le paga.
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "store_courier" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "store_courier" ADD COLUMN "pay_cents" integer;--> statement-breakpoint
ALTER TABLE "store_courier" ADD COLUMN "failed_trip_paid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD COLUMN "shared_by" text;--> statement-breakpoint
ALTER TABLE "store_courier" ADD CONSTRAINT "store_courier_pay_check" CHECK (("store_courier"."pay_cents" is null or "store_courier"."pay_cents" between 0 and 100000000) and ("store_courier"."phone" is null or "store_courier"."phone" ~ '^[+][1-9][0-9]{6,14}$'));--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','invitacion.enviada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro','soporte.salio','configuracion.tienda','configuracion.marca','repartidor.agregado','repartidor.cambiado','repartidor.quitado'));--> statement-breakpoint
ALTER TABLE "store_invitation" ADD CONSTRAINT "store_invitation_contact_check" CHECK (("store_invitation"."name" is null or char_length(btrim("store_invitation"."name")) between 1 and 80) and ("store_invitation"."phone" is null or "store_invitation"."phone" ~ '^[+][1-9][0-9]{6,14}$') and (("store_invitation"."shared_at" is null) = ("store_invitation"."shared_by" is null)));