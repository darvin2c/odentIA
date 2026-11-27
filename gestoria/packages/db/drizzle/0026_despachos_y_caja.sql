-- Despachos y Caja (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17, 23 y 24; ADR
-- 0228): las franjas de entrega de la tienda, quién lleva cada pedido (una persona del equipo o un
-- nombre externo, listo para enlazarse a su cuenta con gestorIA Reparto), la franja y la agencia de
-- cada pedido, a nombre de quién queda lo cobrado en la puerta y el «Recibí» del efectivo en Caja.
CREATE TABLE "cash_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"courier_id" uuid,
	"expected_cents" integer NOT NULL,
	"received_cents" integer NOT NULL,
	"note" text,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_handover_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "cash_handover_amounts_check" CHECK ("cash_handover"."expected_cents" > 0 and "cash_handover"."received_cents" >= 0),
	CONSTRAINT "cash_handover_note_check" CHECK (("cash_handover"."note" is null or char_length(btrim("cash_handover"."note")) between 3 and 300) and ("cash_handover"."received_cents" = "cash_handover"."expected_cents" or "cash_handover"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE "cash_handover_payment" (
	"store_id" uuid NOT NULL,
	"handover_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	CONSTRAINT "cash_handover_payment_payment_id_pk" PRIMARY KEY("payment_id")
);
--> statement-breakpoint
CREATE TABLE "store_courier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_courier_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "store_courier_name_check" CHECK (char_length(btrim("store_courier"."name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "order_event" DROP CONSTRAINT "order_event_action_check";--> statement-breakpoint
ALTER TABLE "order_payment" ADD COLUMN "courier_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "slot_start" smallint;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "slot_end" smallint;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "courier_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "agency" text;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "delivery_slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_handover" ADD CONSTRAINT "cash_handover_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handover" ADD CONSTRAINT "cash_handover_courier_fkey" FOREIGN KEY ("store_id","courier_id") REFERENCES "public"."store_courier"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handover_payment" ADD CONSTRAINT "cash_handover_payment_handover_fkey" FOREIGN KEY ("store_id","handover_id") REFERENCES "public"."cash_handover"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handover_payment" ADD CONSTRAINT "cash_handover_payment_payment_fkey" FOREIGN KEY ("store_id","payment_id") REFERENCES "public"."order_payment"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_courier" ADD CONSTRAINT "store_courier_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_courier" ADD CONSTRAINT "store_courier_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."account_copy"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_handover_store_idx" ON "cash_handover" USING btree ("store_id","received_at");--> statement-breakpoint
CREATE INDEX "cash_handover_payment_handover_idx" ON "cash_handover_payment" USING btree ("handover_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_courier_user_uidx" ON "store_courier" USING btree ("store_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "store_courier_name_uidx" ON "store_courier" USING btree ("store_id",lower(btrim("name"))) WHERE user_id is null;--> statement-breakpoint
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_courier_fkey" FOREIGN KEY ("store_id","courier_id") REFERENCES "public"."store_courier"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_courier_fkey" FOREIGN KEY ("store_id","courier_id") REFERENCES "public"."store_courier"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_order_deliver_on_idx" ON "sale_order" USING btree ("store_id","deliver_on");--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_action_check" CHECK (action IN ('creado','link','comprobante','pago_confirmado','pago_no_coincide','pago_link','salio','entregado','anulado','aviso','cambiado','no_entregado','reprogramado','pago_deshecho','repartidor','envio'));--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_slot_check" CHECK (("sale_order"."slot_start" is null) = ("sale_order"."slot_end" is null) and ("sale_order"."slot_start" is null or ("sale_order"."slot_start" >= 0 and "sale_order"."slot_start" < "sale_order"."slot_end" and "sale_order"."slot_end" <= 1440)));--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_agency_check" CHECK ("sale_order"."agency" is null or char_length(btrim("sale_order"."agency")) between 1 and 60);--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_delivery_slots_check" CHECK (jsonb_typeof("store"."delivery_slots") = 'array' and jsonb_array_length("store"."delivery_slots") <= 8);