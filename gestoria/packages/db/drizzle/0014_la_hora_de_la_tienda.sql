-- La hora de la tienda (ADR 0221): cada tienda guarda su zona horaria (IANA) y con ella se cuenta
-- qué es «hoy». Las de antes quedan en la de Lima. Cambiarla queda anotado en su registro.
ALTER TABLE "store_event" DROP CONSTRAINT "store_event_action_check";--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "time_zone" text DEFAULT 'America/Lima' NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_time_zone_check" CHECK (char_length("store"."time_zone") <= 64 and "store"."time_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$');--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada','configuracion.pago','configuracion.entrega','catalogo.producto','catalogo.hoja','configuracion.sofi','soporte.pedido','soporte.aceptado','soporte.rechazado','soporte.quitado','soporte.entro','soporte.salio','configuracion.tienda'));
