-- El correo entrante se liga solo a su cliente únicamente con el remitente verificado (ADR 0184):
-- el worker lo dice por DMARC, o por SPF o DKIM alineados con el From, según Cloudflare.
ALTER TABLE "admin"."saas_inbound_email" ADD COLUMN "sender_verified" boolean DEFAULT false NOT NULL;
