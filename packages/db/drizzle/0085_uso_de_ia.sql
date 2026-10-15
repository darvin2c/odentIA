-- Uso de IA por origen (fase 1 del cobro por acción, ADR 0030): cada llamada
-- pagada a un proveedor queda con su origen, lo que el proveedor reportó y su
-- costo en millonésimas de USD (null si no hay precio conocido: nunca se estima).
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
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
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_origin_check" CHECK ("ai_usage"."origin" in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion')),
	CONSTRAINT "ai_usage_calls_check" CHECK ("ai_usage"."calls" >= 1),
	CONSTRAINT "ai_usage_cost_check" CHECK ("ai_usage"."cost_micros" is null or "ai_usage"."cost_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_org_idx" ON "ai_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "ai_usage"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Libro append-only: el rol app registra y lee, nunca corrige ni borra.
GRANT SELECT, INSERT ON "ai_usage" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ai_usage" FROM dentalagent_app;
