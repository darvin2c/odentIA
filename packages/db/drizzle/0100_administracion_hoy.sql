CREATE TABLE "admin"."support_guide_gap" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"marked_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_follow_up" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"organization_id" text,
	"author_user_id" text,
	"body" text NOT NULL,
	"follow_up_on" date,
	"admin_only" boolean DEFAULT false NOT NULL,
	"from_note" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_follow_up_subject_check" CHECK (num_nonnulls("admin"."saas_follow_up"."request_id", "admin"."saas_follow_up"."organization_id") = 1),
	CONSTRAINT "saas_follow_up_body_check" CHECK (length(trim("admin"."saas_follow_up"."body")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "saas_payment" DROP CONSTRAINT "saas_payment_status_check";--> statement-breakpoint
ALTER TABLE "support_case" ADD COLUMN "access_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD COLUMN "rejected_by" text;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "admin"."support_guide_gap" ADD CONSTRAINT "support_guide_gap_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."support_guide_gap" ADD CONSTRAINT "support_guide_gap_marked_by_user_id_fk" FOREIGN KEY ("marked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_request_id_saas_waitlist_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "admin"."saas_waitlist_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_guide_gap_marked_idx" ON "admin"."support_guide_gap" USING btree ("marked_at");--> statement-breakpoint
CREATE INDEX "saas_follow_up_request_idx" ON "admin"."saas_follow_up" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "saas_follow_up_org_idx" ON "admin"."saas_follow_up" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_rejection_check" CHECK (CASE WHEN "saas_payment"."status" = 'rechazado'
        THEN "saas_payment"."rejected_at" IS NOT NULL AND "saas_payment"."rejected_by" IS NOT NULL
          AND length(trim(coalesce("saas_payment"."reject_reason", ''))) BETWEEN 1 AND 500
        ELSE "saas_payment"."rejected_at" IS NULL AND "saas_payment"."rejected_by" IS NULL AND "saas_payment"."reject_reason" IS NULL END);--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_status_check" CHECK ("saas_payment"."status" IN ('pendiente','confirmado','reversado','devuelto','rechazado'));