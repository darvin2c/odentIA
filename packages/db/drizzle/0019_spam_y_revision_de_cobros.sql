CREATE TABLE "saas_action_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"requested_by_user_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_until" timestamp with time zone,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_staff_id" text,
	"answer" text,
	"support_case_id" uuid,
	"credit_charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_action_review_reason_check" CHECK ("saas_action_review"."reason" IN ('spam','agente','doble','otro')),
	CONSTRAINT "saas_action_review_note_check" CHECK ("saas_action_review"."note" IS NULL OR length("saas_action_review"."note") <= 1000),
	CONSTRAINT "saas_action_review_decision_check" CHECK (("saas_action_review"."status" = 'pendiente' AND "saas_action_review"."decided_at" IS NULL AND "saas_action_review"."decided_by_staff_id" IS NULL AND "saas_action_review"."answer" IS NULL AND NOT "saas_action_review"."automatic")
        OR ("saas_action_review"."status" = 'devuelta' AND "saas_action_review"."automatic" AND "saas_action_review"."decided_at" IS NOT NULL AND "saas_action_review"."decided_by_staff_id" IS NULL)
        OR ("saas_action_review"."status" IN ('devuelta','mantenida') AND NOT "saas_action_review"."automatic" AND "saas_action_review"."decided_at" IS NOT NULL
          AND "saas_action_review"."decided_by_staff_id" IS NOT NULL AND length(trim("saas_action_review"."answer")) > 0)),
	CONSTRAINT "saas_action_review_credit_check" CHECK ("saas_action_review"."credit_charge_id" IS NULL OR "saas_action_review"."status" = 'devuelta')
);
--> statement-breakpoint
ALTER TABLE "support_case" DROP CONSTRAINT "support_case_kind_check";--> statement-breakpoint
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_kind_check";--> statement-breakpoint
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_amount_check";--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screen" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screened_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screen_reason" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "screen_note" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "not_spam_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "not_spam_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contact_identity" ADD COLUMN "provider_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_action_id_saas_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."saas_action"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_decided_by_staff_id_user_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_case_fk" FOREIGN KEY ("support_case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_credit_charge_fk" FOREIGN KEY ("organization_id","credit_charge_id") REFERENCES "public"."saas_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_action_review_action_uidx" ON "saas_action_review" USING btree ("organization_id","action_id");--> statement-breakpoint
CREATE INDEX "saas_action_review_status_idx" ON "saas_action_review" USING btree ("status","requested_at");--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_screened_by_user_id_user_id_fk" FOREIGN KEY ("screened_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_not_spam_by_user_id_user_id_fk" FOREIGN KEY ("not_spam_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_org_screen_idx" ON "contact" USING btree ("organization_id","screen") WHERE "screen" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_kind_check" CHECK ("support_case"."kind" in ('pregunta','problema','acceso','cobro'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_screen_check" CHECK (("contact"."screen" IS NULL AND "contact"."screened_at" IS NULL AND "contact"."screened_by_user_id" IS NULL
        AND "contact"."screen_reason" IS NULL AND "contact"."screen_note" IS NULL)
      OR ("contact"."screen" = 'spam' AND "contact"."screened_at" IS NOT NULL
        AND "contact"."screen_reason" IN ('repeticion','publicidad','estafa','cadena','respuesta_automatica','venta','equipo'))
      OR ("contact"."screen" = 'blocked' AND "contact"."screened_at" IS NOT NULL AND "contact"."screened_by_user_id" IS NOT NULL
        AND "contact"."screen_reason" IN ('acoso','amenazas','estafa','otro') AND length(trim("contact"."screen_note")) > 0));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_not_spam_check" CHECK (("contact"."not_spam_at" IS NULL) = ("contact"."not_spam_by_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_kind_check" CHECK ("saas_charge_line"."kind" IN ('cuota','conversacion','consulta','cita','devolucion','revision','credito','impuesto'));--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_amount_check" CHECK ("saas_charge_line"."quantity" >= 0 AND CASE WHEN "saas_charge_line"."kind" IN ('devolucion','revision') THEN "saas_charge_line"."amount_cents" <= 0 ELSE "saas_charge_line"."amount_cents" >= 0 END);