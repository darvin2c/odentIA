-- Los grupos de clientas (lienzo «Clientas bien perfiladas y Argos que hace el marketing solo»):
-- lo que Argos calcula de cada ficha con cuentas fijas (su grupo, sus compras, lo que se filtra) y
-- los grupos que guarda la tienda (sus filtros, nunca las clientas). Todo nace vacío: la primera
-- vuelta de la noche lo calcula.
CREATE TABLE "customer_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "customer_group_name_check" CHECK (char_length(btrim("customer_group"."name")) between 1 and 60),
	CONSTRAINT "customer_group_filters_check" CHECK (jsonb_typeof("customer_group"."filters") = 'object')
);
--> statement-breakpoint
CREATE TABLE "customer_profile" (
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"segment" text NOT NULL,
	"why" text NOT NULL,
	"orders_count" integer NOT NULL,
	"total_cents" bigint NOT NULL,
	"last_bought_on" date,
	"rhythm_days" integer,
	"measures" text[] DEFAULT '{}'::text[] NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"districts" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_sensitivity" text,
	"computed_for" date NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profile_store_id_customer_id_pk" PRIMARY KEY("store_id","customer_id"),
	CONSTRAINT "customer_profile_segment_check" CHECK (segment IN ('vip','frecuente','nueva','riesgo','dormida','perdida','sin_compras')),
	CONSTRAINT "customer_profile_sensitivity_check" CHECK ("customer_profile"."price_sensitivity" is null or price_sensitivity IN ('rebaja','liquidacion')),
	CONSTRAINT "customer_profile_counts_check" CHECK ("customer_profile"."orders_count" >= 0 and ("customer_profile"."rhythm_days" is null or "customer_profile"."rhythm_days" >= 0) and char_length("customer_profile"."why") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_store_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_customer_fkey" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_group_store_idx" ON "customer_group" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_profile_segment_idx" ON "customer_profile" USING btree ("store_id","segment");