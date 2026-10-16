-- «Enviar a odentIA»: el caso es la única fuente y el correo solo avisa.
-- 1) El pedido viejo (`help_request`) sobra: su estado y su respuesta nunca se
--    actualizaban y todo lo que guardaba ya está en `support_case`.
ALTER TABLE "support_case" DROP COLUMN IF EXISTS "help_request_id";--> statement-breakpoint
DROP TABLE IF EXISTS "help_request";--> statement-breakpoint
-- 2) Avisos por correo de un caso: a soporte (destinatario nulo = buzón) y a
--    quien preguntó. Se guardan y se reclaman antes de SMTP.
CREATE TABLE "support_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text,
	"kind" text NOT NULL,
	"recipient_user_id" text,
	"dedupe_key" text NOT NULL,
	"email_state" text DEFAULT 'pendiente' NOT NULL,
	"emailed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_notice_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "support_notice_kind_check" CHECK ("support_notice"."kind" in ('caso_nuevo','clinica_respondio','respuesta','necesita_algo')),
	CONSTRAINT "support_notice_state_check" CHECK ("support_notice"."email_state" in ('pendiente','reclamado','enviado','incierto','omitido')),
	CONSTRAINT "support_notice_recipient_check" CHECK (("support_notice"."kind" in ('caso_nuevo','clinica_respondio')) = ("support_notice"."recipient_user_id" is null))
);--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- La FK compuesta no mira filas con organización nula: el trigger iguala la del caso.
CREATE TRIGGER "support_notice_org_match" BEFORE INSERT OR UPDATE ON "support_notice" FOR EACH ROW EXECUTE FUNCTION "support_case_org_match"();--> statement-breakpoint
CREATE INDEX "support_notice_case_idx" ON "support_notice" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_notice_state_idx" ON "support_notice" USING btree ("email_state","created_at");--> statement-breakpoint
ALTER TABLE "support_notice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "support_notice"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
-- La aplicación crea y lee avisos de su clínica; reclamarlos y cerrarlos es del worker (owner).
GRANT SELECT, INSERT ON "support_notice" TO "dentalagent_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON "support_notice" FROM "dentalagent_app";
