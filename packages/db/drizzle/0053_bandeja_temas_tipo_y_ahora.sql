ALTER TABLE "agent_handoff" ADD COLUMN "kind" text DEFAULT 'otro' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD COLUMN "urgent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_kind_check" CHECK ("agent_handoff"."kind" in ('cita','precio','clinico','pago','otro'));