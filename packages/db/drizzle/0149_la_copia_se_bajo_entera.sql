-- Cuándo terminó de enviarse el ZIP de una descarga de la copia por su enlace: el tope cuenta los
-- inicios y «Se bajó» las terminadas. La aplicación la anota una vez, de nulo a la fecha.
ALTER TABLE "patient_record_download" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE(completed_at) ON TABLE public.patient_record_download TO dentalagent_app;
