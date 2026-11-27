CREATE TABLE "admin"."app_ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"origin" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"audio_seconds" integer,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_ai_usage_app_check" CHECK ("admin"."app_ai_usage"."app" IN ('gestoria')),
	CONSTRAINT "app_ai_usage_origin_check" CHECK ("admin"."app_ai_usage"."origin" IN ('ayuda')),
	CONSTRAINT "app_ai_usage_calls_check" CHECK ("admin"."app_ai_usage"."calls" >= 1),
	CONSTRAINT "app_ai_usage_cost_check" CHECK ("admin"."app_ai_usage"."cost_micros" IS NULL OR "admin"."app_ai_usage"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin"."app_help_ask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"via" text,
	"verdict" text,
	"helpful" boolean,
	"none_fits" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_help_ask_app_check" CHECK ("admin"."app_help_ask"."app" IN ('gestoria')),
	CONSTRAINT "app_help_ask_via_check" CHECK ("admin"."app_help_ask"."via" IS NULL OR "admin"."app_help_ask"."via" IN ('jev','respaldo')),
	CONSTRAINT "app_help_ask_verdict_check" CHECK ("admin"."app_help_ask"."verdict" IS NULL OR "admin"."app_help_ask"."verdict" IN ('seguro','duda','ninguna','datos','redactada'))
);
--> statement-breakpoint
CREATE INDEX "app_ai_usage_app_date_idx" ON "admin"."app_ai_usage" USING btree ("app","created_at");--> statement-breakpoint
CREATE INDEX "app_help_ask_app_date_idx" ON "admin"."app_help_ask" USING btree ("app","created_at");