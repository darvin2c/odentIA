CREATE TABLE "imaging_study" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"study_instance_uid" text NOT NULL,
	"dicom_patient_name" text,
	"modality" text,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"slice_count" integer NOT NULL,
	"voxel_mm" real,
	"thumbnail_key" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_study_file_count_check" CHECK ("imaging_study"."file_count" BETWEEN 1 AND 5000),
	CONSTRAINT "imaging_study_total_bytes_check" CHECK ("imaging_study"."total_bytes" BETWEEN 1 AND 1073741824),
	CONSTRAINT "imaging_study_slice_count_check" CHECK ("imaging_study"."slice_count" BETWEEN 1 AND 20000),
	CONSTRAINT "imaging_study_uid_check" CHECK (char_length("imaging_study"."study_instance_uid") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "imaging_study_file" (
	"organization_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"file_index" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sop_instance_uid" text NOT NULL,
	"series_instance_uid" text NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "imaging_study_file_document_id_file_index_pk" PRIMARY KEY("document_id","file_index"),
	CONSTRAINT "imaging_study_file_size_check" CHECK ("imaging_study_file"."size_bytes" BETWEEN 1 AND 1073741824)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_study_org_document_uidx" ON "imaging_study" USING btree ("organization_id","document_id");--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."patient_document"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study_file" ADD CONSTRAINT "imaging_study_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study_file" ADD CONSTRAINT "imaging_study_file_study_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."imaging_study"("organization_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_study_org_patient_study_idx" ON "imaging_study" USING btree ("organization_id","patient_id","study_instance_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_study_file_sop_uidx" ON "imaging_study_file" USING btree ("document_id","sop_instance_uid");