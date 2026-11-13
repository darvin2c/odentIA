ALTER TABLE "admin"."kairos_item" DROP CONSTRAINT "kairos_item_kind_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" DROP CONSTRAINT "saas_inbound_email_mailbox_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" DROP CONSTRAINT "saas_inbound_email_matched_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" DROP CONSTRAINT "saas_inbound_email_text_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD COLUMN "staff_user_id" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD COLUMN "references" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "in_reply_to_email_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "from_address" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "references" text;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD COLUMN "mail_local" text;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD COLUMN "mail_copy_to" text;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD COLUMN "mail_first_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_in_reply_to_email_id_saas_inbound_email_id_fk" FOREIGN KEY ("in_reply_to_email_id") REFERENCES "admin"."saas_inbound_email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_inbound_email_staff_idx" ON "admin"."saas_inbound_email" USING btree ("staff_user_id","received_at");--> statement-breakpoint
CREATE INDEX "saas_outreach_reply_idx" ON "admin"."saas_outreach" USING btree ("in_reply_to_email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_outreach_message_uidx" ON "admin"."saas_outreach" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_staff_mail_local_uidx" ON "admin"."admin_staff" USING btree ("mail_local");--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_kind_check" CHECK ("admin"."kairos_item"."kind" IN ('mensaje','propuesta','guion','dato','vinculo','duplicado','demo','presentacion_hecha','correo_sin_cliente','responder_correo'));--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_staff_check" CHECK ("admin"."saas_inbound_email"."mailbox" = 'persona' OR "admin"."saas_inbound_email"."staff_user_id" IS NULL);--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_mailbox_check" CHECK ("admin"."saas_inbound_email"."mailbox" IN ('soporte','contacto','hola','fundadores','persona'));--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_matched_check" CHECK ("admin"."saas_inbound_email"."matched_by" IS NULL OR "admin"."saas_inbound_email"."matched_by" IN ('contacto','solicitud','miembro','hilo','persona'));--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_text_check" CHECK (length(trim("admin"."saas_inbound_email"."message_id")) BETWEEN 1 AND 998
        AND ("admin"."saas_inbound_email"."text_body" IS NULL OR length("admin"."saas_inbound_email"."text_body") <= 20000)
        AND ("admin"."saas_inbound_email"."subject" IS NULL OR length("admin"."saas_inbound_email"."subject") <= 998)
        AND ("admin"."saas_inbound_email"."in_reply_to" IS NULL OR length("admin"."saas_inbound_email"."in_reply_to") <= 998)
        AND ("admin"."saas_inbound_email"."references" IS NULL OR length("admin"."saas_inbound_email"."references") <= 8000));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_client_check" CHECK ("admin"."saas_outreach"."client_id" IS NOT NULL OR "admin"."saas_outreach"."in_reply_to_email_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_mail_check" CHECK (("admin"."saas_outreach"."from_address" IS NULL OR ("admin"."saas_outreach"."from_address" = lower("admin"."saas_outreach"."from_address") AND length("admin"."saas_outreach"."from_address") BETWEEN 3 AND 254))
        AND ("admin"."saas_outreach"."message_id" IS NULL OR length("admin"."saas_outreach"."message_id") BETWEEN 3 AND 998)
        AND ("admin"."saas_outreach"."references" IS NULL OR length("admin"."saas_outreach"."references") <= 8000)
        AND ("admin"."saas_outreach"."in_reply_to_email_id" IS NULL OR "admin"."saas_outreach"."channel" = 'correo'));--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD CONSTRAINT "admin_staff_mail_local_check" CHECK ("admin"."admin_staff"."mail_local" IS NULL OR ("admin"."admin_staff"."mail_local" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
      AND length("admin"."admin_staff"."mail_local") BETWEEN 2 AND 64
      AND "admin"."admin_staff"."mail_local" NOT IN ('soporte','hola','contacto','fundadores','privacidad','reclamaciones','redes','reply','no-reply','noreply','postmaster','abuse','admin','administracion','ventas','info','webmaster','hostmaster','mailer-daemon','security','seguridad')));--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD CONSTRAINT "admin_staff_mail_copy_check" CHECK ("admin"."admin_staff"."mail_copy_to" IS NULL OR ("admin"."admin_staff"."mail_copy_to" = lower("admin"."admin_staff"."mail_copy_to")
      AND length("admin"."admin_staff"."mail_copy_to") BETWEEN 3 AND 254 AND "admin"."admin_staff"."mail_copy_to" LIKE '_%@_%._%'
      AND strpos("admin"."admin_staff"."mail_copy_to", ' ') = 0));