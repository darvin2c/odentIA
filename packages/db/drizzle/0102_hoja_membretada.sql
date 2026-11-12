CREATE TABLE "clinic_letterhead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"pdf_key" text NOT NULL,
	"top_band_url" text NOT NULL,
	"bottom_band_url" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"page_width_pt" numeric NOT NULL,
	"page_height_pt" numeric NOT NULL,
	"top_mm" numeric NOT NULL,
	"bottom_mm" numeric NOT NULL,
	"left_mm" numeric NOT NULL,
	"right_mm" numeric NOT NULL,
	"has_contact" boolean DEFAULT false NOT NULL,
	"file_name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	CONSTRAINT "clinic_letterhead_page_check" CHECK ("clinic_letterhead"."page_width_pt" > 0 and "clinic_letterhead"."page_height_pt" > 0),
	CONSTRAINT "clinic_letterhead_margins_check" CHECK ("clinic_letterhead"."top_mm" >= 0 and "clinic_letterhead"."bottom_mm" >= 0 and "clinic_letterhead"."left_mm" >= 0 and "clinic_letterhead"."right_mm" >= 0),
	CONSTRAINT "clinic_letterhead_removed_check" CHECK (("clinic_letterhead"."removed_at" is null) = ("clinic_letterhead"."removed_by" is null))
);
--> statement-breakpoint
ALTER TABLE "clinic_letterhead" ADD CONSTRAINT "clinic_letterhead_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_letterhead" ADD CONSTRAINT "clinic_letterhead_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_letterhead" ADD CONSTRAINT "clinic_letterhead_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_letterhead_current_uidx" ON "clinic_letterhead" USING btree ("organization_id") WHERE "clinic_letterhead"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "clinic_letterhead_org_created_idx" ON "clinic_letterhead" USING btree ("organization_id","created_at");