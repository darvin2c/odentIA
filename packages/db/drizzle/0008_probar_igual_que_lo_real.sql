ALTER TABLE "appointment" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "test_by_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_test_by_user_id_user_id_fk" FOREIGN KEY ("test_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;