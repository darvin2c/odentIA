CREATE TABLE "consumer_complaint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'recibido' NOT NULL,
	"consumer_name" text NOT NULL,
	"consumer_address" text NOT NULL,
	"document_type" text NOT NULL,
	"document_number" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"is_minor" boolean DEFAULT false NOT NULL,
	"guardian_name" text,
	"item_type" text NOT NULL,
	"item_description" text NOT NULL,
	"amount_minor" bigint,
	"amount_currency" text,
	"detail" text NOT NULL,
	"request" text NOT NULL,
	"provider_response" text,
	"responded_at" timestamp with time zone,
	"privacy_accepted_at" timestamp with time zone NOT NULL,
	"email_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_complaint_number_unique" UNIQUE("number"),
	CONSTRAINT "consumer_complaint_submission_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "consumer_complaint_counter" (
	"year" integer PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "consumer_complaint_status_idx" ON "consumer_complaint" USING btree ("status","created_at");