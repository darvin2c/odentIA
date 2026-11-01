-- Enviar un consentimiento a firmar y que la persona lo firme en su enlace no
-- quedaban en su historia: parecía pendiente de firma aunque ya estuviera firmado.
-- Desde ahora se anotan al hacerlo; lo de antes se agrega con las fechas que guardó.
INSERT INTO "consent_event" ("organization_id", "document_id", "from_status", "to_status", "created_at")
SELECT "organization_id", "id", 'pendiente', 'enlace_enviado', "link_sent_at"
FROM "consent_document"
WHERE "link_sent_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "consent_event" ("organization_id", "document_id", "from_status", "to_status", "reason", "created_at")
SELECT "organization_id", "id", 'pendiente', 'enlace_firmado', "signer_kind" || ': ' || "signer_name", "person_signed_at"
FROM "consent_document"
WHERE "person_signed_at" IS NOT NULL;
