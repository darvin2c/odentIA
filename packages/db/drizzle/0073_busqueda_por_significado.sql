-- Búsqueda por significado del agente (ADR 0021): pgvector en la misma base.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agent_search_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"text" text NOT NULL,
	"model" text,
	"embedding" vector,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_search_item_kind_check" CHECK ("agent_search_item"."kind" in ('servicio','promocion','profesional','respuesta'))
);
--> statement-breakpoint
ALTER TABLE "agent_search_item" ADD CONSTRAINT "agent_search_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_search_item_ref_uidx" ON "agent_search_item" USING btree ("organization_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "agent_search_item_pending_idx" ON "agent_search_item" USING btree ("organization_id") WHERE "agent_search_item"."embedding" is null;--> statement-breakpoint
ALTER TABLE "agent_search_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_search_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "agent_search_item" USING (organization_id = nullif(current_setting('app.org_id', true), '')) WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
