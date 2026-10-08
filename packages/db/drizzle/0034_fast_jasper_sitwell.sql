ALTER TABLE "agent_run_ledger" DROP CONSTRAINT "agent_run_ledger_status_check";--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD COLUMN "llm_calls" integer;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_status_check" CHECK ("agent_run_ledger"."status" in ('ok','handoff','error','omitida','sin_respuesta'));