CREATE TABLE "admin"."saas_commercial_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"conversation_window_hours" integer NOT NULL,
	"recovery_window_days" integer NOT NULL,
	"review_auto_percent" integer NOT NULL,
	"review_answer_days" integer NOT NULL,
	"review_read_days" integer NOT NULL,
	"payment_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"proof_extension_days" integer NOT NULL,
	"proof_extension_max" integer NOT NULL,
	"half_cycle_days" integer NOT NULL,
	"trial_days" integer NOT NULL,
	"warn_percent" integer NOT NULL,
	"alarm_percent" integer NOT NULL,
	"waitlist_answer_days" integer NOT NULL,
	"commission_months" integer NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_commercial_terms_effective_uidx" UNIQUE("effective_from"),
	CONSTRAINT "saas_commercial_terms_limits_check" CHECK ("admin"."saas_commercial_terms"."conversation_window_hours" BETWEEN 1 AND 72
        AND "admin"."saas_commercial_terms"."recovery_window_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."review_auto_percent" BETWEEN 0 AND 30
        AND "admin"."saas_commercial_terms"."review_answer_days" BETWEEN 1 AND 10
        AND "admin"."saas_commercial_terms"."review_read_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."payment_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."grace_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."proof_extension_days" BETWEEN 0 AND 10
        AND "admin"."saas_commercial_terms"."proof_extension_max" BETWEEN 0 AND 3
        AND "admin"."saas_commercial_terms"."half_cycle_days" BETWEEN 7 AND 21
        AND "admin"."saas_commercial_terms"."trial_days" BETWEEN 7 AND 90
        AND "admin"."saas_commercial_terms"."warn_percent" BETWEEN 50 AND 99
        AND "admin"."saas_commercial_terms"."alarm_percent" BETWEEN 50 AND 99
        AND "admin"."saas_commercial_terms"."warn_percent" < "admin"."saas_commercial_terms"."alarm_percent"
        AND "admin"."saas_commercial_terms"."waitlist_answer_days" BETWEEN 1 AND 10
        AND "admin"."saas_commercial_terms"."commission_months" BETWEEN 1 AND 36),
	CONSTRAINT "saas_commercial_terms_reason_check" CHECK ("admin"."saas_commercial_terms"."reason" IS NULL OR length("admin"."saas_commercial_terms"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_commercial_terms" ADD CONSTRAINT "saas_commercial_terms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;