CREATE TABLE "patient_data_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requester_contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"requested_on" date NOT NULL,
	"due_on" date NOT NULL,
	"said" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"verified_how" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_data_request_kind_check" CHECK ("patient_data_request"."kind" IN ('copia','corregir','mensajes')),
	CONSTRAINT "patient_data_request_channel_check" CHECK ("patient_data_request"."channel" IN ('clinica','whatsapp','correo','portal')),
	CONSTRAINT "patient_data_request_status_check" CHECK ("patient_data_request"."status" IN ('pendiente','respondida','denegada')),
	CONSTRAINT "patient_data_request_verified_check" CHECK ("patient_data_request"."verified_how" IS NULL OR "patient_data_request"."verified_how" IN ('documento','portal','representante')),
	CONSTRAINT "patient_data_request_resolved_check" CHECK (("patient_data_request"."status" = 'pendiente') = ("patient_data_request"."resolved_at" IS NULL)),
	CONSTRAINT "patient_data_request_due_check" CHECK ("patient_data_request"."due_on" >= "patient_data_request"."requested_on")
);
--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_requester_fk" FOREIGN KEY ("organization_id","patient_id","requester_contact_id") REFERENCES "public"."patient_contact"("organization_id","patient_id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_data_request_org_patient_idx" ON "patient_data_request" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_data_request_org_pending_idx" ON "patient_data_request" USING btree ("organization_id","due_on") WHERE "patient_data_request"."status" = 'pendiente';