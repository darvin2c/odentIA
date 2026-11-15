CREATE TABLE "admin"."saas_chat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"address" text NOT NULL,
	"wa_id" text,
	"display_name" text,
	"client_id" uuid,
	"contact_id" uuid,
	"matched_by_user" text,
	"matched_at" timestamp with time zone,
	"not_clinic_at" timestamp with time zone,
	"not_clinic_by" text,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_chat_channel_check" CHECK ("admin"."saas_chat"."channel" IN ('whatsapp','instagram','messenger')),
	CONSTRAINT "saas_chat_address_check" CHECK (length("admin"."saas_chat"."address") BETWEEN 1 AND 128 AND "admin"."saas_chat"."address" !~ '\s'
        AND ("admin"."saas_chat"."channel" <> 'whatsapp' OR "admin"."saas_chat"."address" ~ '^\+[1-9][0-9]{6,14}$')),
	CONSTRAINT "saas_chat_text_check" CHECK (("admin"."saas_chat"."display_name" IS NULL OR length("admin"."saas_chat"."display_name") <= 200)
        AND ("admin"."saas_chat"."wa_id" IS NULL OR length("admin"."saas_chat"."wa_id") BETWEEN 1 AND 256)),
	CONSTRAINT "saas_chat_not_clinic_check" CHECK (("admin"."saas_chat"."not_clinic_at" IS NULL OR "admin"."saas_chat"."client_id" IS NULL)
        AND ("admin"."saas_chat"."not_clinic_at" IS NOT NULL OR "admin"."saas_chat"."not_clinic_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_inbound_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"body" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"admin_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_inbound_message_text_check" CHECK (length("admin"."saas_inbound_message"."external_id") BETWEEN 1 AND 256
        AND ("admin"."saas_inbound_message"."body" IS NULL OR length("admin"."saas_inbound_message"."body") <= 10000)
        AND jsonb_typeof("admin"."saas_inbound_message"."media") = 'array')
);
--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" DROP CONSTRAINT "kairos_item_kind_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" DROP CONSTRAINT "saas_client_file_source_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" DROP CONSTRAINT "saas_outreach_channel_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" DROP CONSTRAINT "saas_outreach_client_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" DROP CONSTRAINT "saas_follow_up_kind_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD COLUMN "inbound_message_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "admin_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_contact_id_saas_client_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "admin"."saas_client_contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_matched_by_user_user_id_fk" FOREIGN KEY ("matched_by_user") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_not_clinic_by_user_id_fk" FOREIGN KEY ("not_clinic_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_message" ADD CONSTRAINT "saas_inbound_message_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_chat_address_uidx" ON "admin"."saas_chat" USING btree ("channel","address");--> statement-breakpoint
CREATE INDEX "saas_chat_client_idx" ON "admin"."saas_chat" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_inbound_message_external_uidx" ON "admin"."saas_inbound_message" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "saas_inbound_message_chat_idx" ON "admin"."saas_inbound_message" USING btree ("chat_id","received_at");--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_inbound_message_id_saas_inbound_message_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "admin"."saas_inbound_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_client_file_message_idx" ON "admin"."saas_client_file" USING btree ("inbound_message_id");--> statement-breakpoint
CREATE INDEX "saas_outreach_chat_idx" ON "admin"."saas_outreach" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_outreach_external_uidx" ON "admin"."saas_outreach" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "saas_follow_up_chat_idx" ON "admin"."saas_follow_up" USING btree ("chat_id");--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_kind_check" CHECK ("admin"."kairos_item"."kind" IN ('mensaje','propuesta','guion','dato','vinculo','duplicado','demo','presentacion_hecha','correo_sin_cliente','responder_correo','posible_carga','chat_sin_cliente','responder_chat'));--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_source_check" CHECK ("admin"."saas_client_file"."source" IS NULL OR "admin"."saas_client_file"."source" IN ('persona','kairos','correo','whatsapp','instagram','messenger'));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_chat_check" CHECK (("admin"."saas_outreach"."chat_id" IS NULL OR "admin"."saas_outreach"."channel" IN ('whatsapp','instagram','messenger'))
        AND ("admin"."saas_outreach"."channel" NOT IN ('instagram','messenger') OR "admin"."saas_outreach"."chat_id" IS NOT NULL)
        AND ("admin"."saas_outreach"."external_id" IS NULL OR length("admin"."saas_outreach"."external_id") BETWEEN 1 AND 256)
        AND ("admin"."saas_outreach"."template" IS NULL OR ("admin"."saas_outreach"."chat_id" IS NOT NULL AND "admin"."saas_outreach"."channel" = 'whatsapp' AND "admin"."saas_outreach"."template" ~ '^[a-z0-9_]{1,128}$')));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_channel_check" CHECK ("admin"."saas_outreach"."channel" IN ('correo','whatsapp','instagram','messenger'));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_client_check" CHECK ("admin"."saas_outreach"."client_id" IS NOT NULL OR "admin"."saas_outreach"."in_reply_to_email_id" IS NOT NULL OR "admin"."saas_outreach"."chat_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_kind_check" CHECK ("admin"."saas_follow_up"."kind" IN ('llamada','whatsapp','correo','reunion','presentacion','propuesta','nota','instagram','messenger'));