CREATE TABLE "saas_signup_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'invitacion' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_signup_policy_singleton_check" CHECK ("saas_signup_policy"."id" = 1),
	CONSTRAINT "saas_signup_policy_mode_check" CHECK ("saas_signup_policy"."mode" IN ('invitacion','abierta'))
);
--> statement-breakpoint
CREATE TABLE "saas_waitlist_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"clinic_name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"city" text NOT NULL,
	"dentists" text NOT NULL,
	"current_tool" text NOT NULL,
	"status" text DEFAULT 'por_revisar' NOT NULL,
	"note" text,
	"discard_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"plan_id" uuid,
	"token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"organization_id" text,
	"entered_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"invitation_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_waitlist_request_status_check" CHECK ("saas_waitlist_request"."status" IN ('por_revisar','invitada','entro','descartada')),
	CONSTRAINT "saas_waitlist_request_dentists_check" CHECK ("saas_waitlist_request"."dentists" IN ('1','2-3','4-9','10+')),
	CONSTRAINT "saas_waitlist_request_tool_check" CHECK ("saas_waitlist_request"."current_tool" IN ('nada','cuaderno_excel','otro_software')),
	CONSTRAINT "saas_waitlist_request_country_check" CHECK ("saas_waitlist_request"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "saas_waitlist_request_text_check" CHECK (length(trim("saas_waitlist_request"."first_name")) BETWEEN 1 AND 80 AND length(trim("saas_waitlist_request"."last_name")) BETWEEN 1 AND 80
        AND length(trim("saas_waitlist_request"."clinic_name")) BETWEEN 1 AND 120 AND length(trim("saas_waitlist_request"."city")) BETWEEN 1 AND 80
        AND length("saas_waitlist_request"."email") BETWEEN 3 AND 254 AND length("saas_waitlist_request"."phone") BETWEEN 6 AND 20
        AND ("saas_waitlist_request"."note" IS NULL OR length("saas_waitlist_request"."note") <= 2000)),
	CONSTRAINT "saas_waitlist_request_invite_check" CHECK (("saas_waitlist_request"."status" = 'por_revisar' AND "saas_waitlist_request"."token_hash" IS NULL AND "saas_waitlist_request"."organization_id" IS NULL)
        OR ("saas_waitlist_request"."status" = 'invitada' AND "saas_waitlist_request"."token_hash" IS NOT NULL AND "saas_waitlist_request"."plan_id" IS NOT NULL AND "saas_waitlist_request"."invite_expires_at" IS NOT NULL AND "saas_waitlist_request"."organization_id" IS NULL)
        OR ("saas_waitlist_request"."status" = 'entro' AND "saas_waitlist_request"."plan_id" IS NOT NULL AND "saas_waitlist_request"."entered_at" IS NOT NULL)
        OR ("saas_waitlist_request"."status" = 'descartada' AND "saas_waitlist_request"."organization_id" IS NULL AND length(trim(coalesce("saas_waitlist_request"."discard_reason", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "saas_negotiation" ADD COLUMN "discount_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "show_on_web" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "seat_limit" integer;--> statement-breakpoint
ALTER TABLE "saas_plan" ADD COLUMN "guarantee_months" integer;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "discount_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "guaranteed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_signup_policy" ADD CONSTRAINT "saas_signup_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_plan_id_saas_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."saas_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_waitlist_request_token_uidx" ON "saas_waitlist_request" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_waitlist_request_org_uidx" ON "saas_waitlist_request" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "saas_waitlist_request_status_idx" ON "saas_waitlist_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "saas_waitlist_request_email_idx" ON "saas_waitlist_request" USING btree ("email");--> statement-breakpoint
ALTER TABLE "saas_plan" ADD CONSTRAINT "saas_plan_founders_check" CHECK (("saas_plan"."seat_limit" IS NULL OR "saas_plan"."seat_limit" > 0) AND ("saas_plan"."guarantee_months" IS NULL OR "saas_plan"."guarantee_months" BETWEEN 1 AND 120));