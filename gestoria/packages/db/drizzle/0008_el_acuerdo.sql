CREATE TABLE "contract_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe" text,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "contract_outbox_type_check" CHECK (type IN ('cuenta.abierta','uso.contado','soporte.pedido'))
);
--> statement-breakpoint
CREATE TABLE "contract_state" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb,
	"received_at" timestamp with time zone,
	"tried_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "contract_outbox" ADD CONSTRAINT "contract_outbox_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_state" ADD CONSTRAINT "contract_state_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_outbox_dedupe_uidx" ON "contract_outbox" USING btree ("store_id","dedupe");--> statement-breakpoint
CREATE INDEX "contract_outbox_pending_idx" ON "contract_outbox" USING btree ("next_attempt_at","created_at") WHERE sent_at is null;--> statement-breakpoint
CREATE INDEX "contract_outbox_store_idx" ON "contract_outbox" USING btree ("store_id","type","created_at");--> statement-breakpoint
CREATE INDEX "contract_outbox_conversation_idx" ON "contract_outbox" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_country_check" CHECK ("store"."country" is null or "store"."country" ~ '^[A-Z]{2}$');