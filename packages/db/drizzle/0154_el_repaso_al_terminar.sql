-- El repaso al terminar el dictado (mesa del 20 nov 2026, «Clío en una consulta conversada», P4):
-- lee toda la conversación una vez y anota en cada tramo que ya lo leyó; el siguiente repaso solo
-- se lanza si hay tramos sin leer. La aplicación lo anota como lo demás que pasa al ordenarlo.
ALTER TABLE "encounter_dictation_segment" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (reviewed_at) ON TABLE public.encounter_dictation_segment TO dentalagent_app;
