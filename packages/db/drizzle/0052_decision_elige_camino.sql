ALTER TABLE "agent_decision_log" DROP CONSTRAINT "agent_decision_log_mode_check";--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "decision_routing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_decision_log" ADD CONSTRAINT "agent_decision_log_mode_check" CHECK ("agent_decision_log"."mode" in ('shadow','retrieval','route'));