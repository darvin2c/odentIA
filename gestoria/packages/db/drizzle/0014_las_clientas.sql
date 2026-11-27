-- Las clientas (entrega 4, tablero 8): la ficha de cada una y lo que una persona decidió sobre dos
-- fichas. Los pedidos de antes quedan sin ficha: no se unen solos por el teléfono (ADR 0221).
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"phone_digits" text GENERATED ALWAYS AS (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) STORED,
	"note" text DEFAULT '' NOT NULL,
	"note_by" text,
	"note_at" timestamp with time zone,
	"merged_into" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "customer_texts_check" CHECK (char_length(btrim("customer"."name")) between 1 and 120 and ("customer"."phone" is null or char_length("customer"."phone") between 1 and 30) and char_length("customer"."note") <= 1000),
	CONSTRAINT "customer_note_check" CHECK (("customer"."note_at" is null) = ("customer"."note_by" is null)),
	CONSTRAINT "customer_merged_check" CHECK ("customer"."merged_into" is null or "customer"."merged_into" <> "customer"."id")
);
--> statement-breakpoint
CREATE TABLE "customer_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"other_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_event_action_check" CHECK (action IN ('unida','separada','distintas')),
	CONSTRAINT "customer_event_pair_check" CHECK ("customer_event"."customer_id" <> "customer_event"."other_id")
);
--> statement-breakpoint
ALTER TABLE "sale_order" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_merged_into_fkey" FOREIGN KEY ("store_id","merged_into") REFERENCES "public"."customer"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_event" ADD CONSTRAINT "customer_event_customer_fkey" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_event" ADD CONSTRAINT "customer_event_other_fkey" FOREIGN KEY ("store_id","other_id") REFERENCES "public"."customer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_merged_idx" ON "customer" USING btree ("store_id","merged_into");--> statement-breakpoint
CREATE INDEX "customer_phone_idx" ON "customer" USING btree ("store_id","phone_digits");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "customer" USING btree ("store_id",lower("name"));--> statement-breakpoint
CREATE INDEX "customer_event_customer_idx" ON "customer_event" USING btree ("store_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_event_other_idx" ON "customer_event" USING btree ("store_id","other_id");--> statement-breakpoint
ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_customer_fkey" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customer"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_order_customer_idx" ON "sale_order" USING btree ("customer_id","created_at");