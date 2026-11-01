ALTER TABLE "agent_review_item" DROP CONSTRAINT "agent_review_item_reason_check";--> statement-breakpoint
ALTER TABLE "agent_review_item" ALTER COLUMN "trace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD COLUMN "review_item_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD COLUMN "trigger_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD COLUMN "query" text;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_review_item_id_agent_review_item_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."agent_review_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_knowledge_gap_review_idx" ON "agent_knowledge_gap" USING btree ("review_item_id");--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_reason_check" CHECK ("agent_review_item"."reason" in ('no_encontro','equipo_tomo','repitio_pregunta','muestra','marcada'));