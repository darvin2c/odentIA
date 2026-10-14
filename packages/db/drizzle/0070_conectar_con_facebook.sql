ALTER TABLE "channel_connection" ADD COLUMN "account_external_id" text;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD COLUMN "signup" jsonb;--> statement-breakpoint
CREATE INDEX "channel_connection_account_idx" ON "channel_connection" USING btree ("provider","account_external_id") WHERE "account_external_id" is not null;