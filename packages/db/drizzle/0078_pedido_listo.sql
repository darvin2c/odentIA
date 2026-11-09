ALTER TABLE "job_order" ADD COLUMN "ready_message_id" uuid;--> statement-breakpoint
ALTER TABLE "job_order" ADD COLUMN "ready_notice_note" text;--> statement-breakpoint

-- «Pedido listo» (ADR 0172): la aplicación guarda el mensaje del aviso, o por qué no salió.
GRANT UPDATE (ready_message_id, ready_notice_note) ON TABLE public.job_order TO dentalagent_app;
