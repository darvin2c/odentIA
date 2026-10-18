CREATE UNIQUE INDEX "message_conversation_id_uidx" ON "message" USING btree ("conversation_id","id");--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD COLUMN "asked_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD COLUMN "asked_again_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "emergency_phone" text;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_conversation_id_source_message_id_message_conversation_id_id_fk" FOREIGN KEY ("conversation_id","source_message_id") REFERENCES "public"."message"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_reply_to_message_id_message_conversation_id_id_fk" FOREIGN KEY ("conversation_id","reply_to_message_id") REFERENCES "public"."message"("conversation_id","id") ON DELETE no action ON UPDATE no action;
