-- El arco ajustado a mano de la tomografía se guarda con el estudio, uno por tomografía, con quién y cuándo
-- lo ajustó. La aplicación solo escribe esas tres columnas.
ALTER TABLE "imaging_study" ADD COLUMN "arch_control" jsonb;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD COLUMN "arch_updated_by" text;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD COLUMN "arch_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_arch_updated_by_user_id_fk" FOREIGN KEY ("arch_updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT UPDATE(arch_control, arch_updated_by, arch_updated_at) ON TABLE public.imaging_study TO dentalagent_app;
