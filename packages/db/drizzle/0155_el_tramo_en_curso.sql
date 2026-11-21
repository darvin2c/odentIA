-- Un tramo o un repaso «en curso» (revisión del 21 nov 2026, «Clío en una consulta conversada»):
-- mientras Clío ordena un tramo o repasa la conversación, un segundo pedido igual (el reintento de
-- la pestaña tras un corte, otra pestaña) no vuelve a llamar al modelo ni a cobrarlo. La marca la
-- pone y la quita la aplicación, como lo demás que pasa al ordenarlo, y vence sola.
ALTER TABLE "encounter_dictation_segment" ADD COLUMN "organizing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter_dictation_segment" ADD COLUMN "reviewing_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (organizing_at, reviewing_at) ON TABLE public.encounter_dictation_segment TO dentalagent_app;
