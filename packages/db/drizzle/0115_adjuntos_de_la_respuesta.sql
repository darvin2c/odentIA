ALTER TABLE "admin"."saas_outreach" ADD COLUMN "file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_files_check" CHECK (cardinality("admin"."saas_outreach"."file_ids") <= 5 AND (cardinality("admin"."saas_outreach"."file_ids") = 0 OR "admin"."saas_outreach"."channel" = 'correo'));--> statement-breakpoint
-- Solo lo de la carga de datos (soporte@ con adjuntos) se borra a los 30 días: los adjuntos de los demás correos se guardan.
UPDATE "admin"."saas_client_file" f SET "delete_after" = NULL
WHERE f."kind" = 'correo' AND f."deleted_at" IS NULL AND f."delete_after" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "admin"."saas_inbound_email" e CROSS JOIN LATERAL jsonb_array_elements(e."attachments") a
    WHERE a->>'fileId' = f."id"::text AND e."mailbox" = 'soporte'
  );
