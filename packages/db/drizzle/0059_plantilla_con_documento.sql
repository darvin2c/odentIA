-- Una plantilla con un documento en el encabezado (ADR 0152): odentIA la envía solo con el PDF de cada envío.
ALTER TABLE public.channel_template DROP CONSTRAINT channel_template_unsupported_check;--> statement-breakpoint
ALTER TABLE public.channel_template ADD CONSTRAINT channel_template_unsupported_check CHECK (((unsupported IS NULL) OR (unsupported = ANY (ARRAY['encabezado'::text, 'datos_por_nombre'::text, 'encabezado_documento'::text]))));
