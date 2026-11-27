-- Corregir sin anular (ADR 0224): la historia del pedido anota cuándo se cambió, cuándo volvió sin
-- entregar, cuándo se pasó a otro día y cuándo se deshizo la confirmación de un pago.
ALTER TABLE "order_event" DROP CONSTRAINT "order_event_action_check";--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_action_check" CHECK (action IN ('creado','link','comprobante','pago_confirmado','pago_no_coincide','pago_link','salio','entregado','anulado','aviso','cambiado','no_entregado','reprogramado','pago_deshecho'));