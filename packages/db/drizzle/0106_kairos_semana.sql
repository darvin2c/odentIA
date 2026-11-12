CREATE TABLE "admin"."kairos_weekly" (
	"week_start" date PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"figures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_weekly_monday_check" CHECK (extract(isodow from "admin"."kairos_weekly"."week_start") = 1),
	CONSTRAINT "kairos_weekly_text_check" CHECK (char_length(btrim("admin"."kairos_weekly"."text")) BETWEEN 1 AND 4000)
);
