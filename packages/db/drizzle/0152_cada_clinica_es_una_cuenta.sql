-- Cada clínica es una cuenta (ADR 0210, paso 3 del lienzo A). La suscripción, los cargos, los
-- pagos, lo que se cuenta para cobrar y los casos de soporte cuelgan de la cuenta de cliente
-- (`admin.saas_account`), no de la organización: así sirven también para una cuenta de una app
-- que es otro sistema (gestorIA), que no tiene clínica. Ningún dato se mueve ni cambia: cada
-- clínica es la cuenta con su mismo id, y las columnas siguen siendo `organization_id`.
-- `saas_account` no recibe ningún GRANT (ADR 0063): solo la toca la conexión propietaria, y las
-- claves foráneas de las tablas de la clínica la comprueban con el dueño de la tabla.
CREATE TABLE "admin"."saas_account" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"app" text,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_account_kind_check" CHECK ((organization_id IS NOT NULL AND id = organization_id AND app IS NULL AND external_ref IS NULL)
        OR (organization_id IS NULL AND app IN ('odentia','latidia','vistia','gestoria')
          AND external_ref IS NOT NULL AND length(trim(external_ref)) BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD CONSTRAINT "saas_account_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "saas_account_organization_uidx" ON "admin"."saas_account" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "saas_account_external_uidx" ON "admin"."saas_account" USING btree ("app","external_ref");
--> statement-breakpoint
-- Una cuenta por cada clínica que ya existe, con su mismo id. Determinista e idempotente: volver
-- a correrla no crea ni cambia nada.
INSERT INTO "admin"."saas_account" ("id", "organization_id")
SELECT "id", "id" FROM "organization"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- La clínica nueva nace con su cuenta, por cualquier vía (el alta, la administración, una demo o
-- una prueba), también desde el rol de la aplicación. Corre antes que `saas_trial_on_org_create`
-- (los disparadores del mismo evento van por orden alfabético), que ya le escribe la suscripción.
-- Sin ON CONFLICT: un id que ya es de una cuenta no se vuelve clínica en silencio.
CREATE FUNCTION public.saas_account_on_org_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'catalog', 'auth', 'admin', 'dental', 'optical'
    AS $$
BEGIN
  INSERT INTO "saas_account" ("id", "organization_id") VALUES (NEW.id, NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER saas_account_on_org_create AFTER INSERT ON public.organization FOR EACH ROW EXECUTE FUNCTION public.saas_account_on_org_create();
--> statement-breakpoint
-- Lo que colgaba de la organización pasa a colgar de su cuenta, con lo mismo al borrarse: la
-- organización se lleva su cuenta y la cuenta lo suyo, como antes. El acceso de soporte a los
-- datos de una clínica (`support_access_grant`, `support_access_audit`) sigue con la organización.
ALTER TABLE "support_attachment" DROP CONSTRAINT "support_attachment_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "support_case" DROP CONSTRAINT "support_case_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "support_message" DROP CONSTRAINT "support_message_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "support_notice" DROP CONSTRAINT "support_notice_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "saas_action" DROP CONSTRAINT "saas_action_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "saas_action_review" DROP CONSTRAINT "saas_action_review_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "saas_charge" DROP CONSTRAINT "saas_charge_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" DROP CONSTRAINT "saas_commission_adjustment_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" DROP CONSTRAINT "saas_settlement_line_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "admin"."saas_negotiation" DROP CONSTRAINT "saas_negotiation_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "saas_notice" DROP CONSTRAINT "saas_notice_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "saas_payment" DROP CONSTRAINT "saas_payment_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "admin"."saas_seller_commission" DROP CONSTRAINT "saas_seller_commission_org_cascade_fk";
--> statement-breakpoint
ALTER TABLE "saas_subscription" DROP CONSTRAINT "saas_subscription_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "storage_usage_day" DROP CONSTRAINT "storage_usage_day_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_action" ADD CONSTRAINT "saas_action_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" ADD CONSTRAINT "saas_settlement_line_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin"."saas_negotiation" ADD CONSTRAINT "saas_negotiation_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_notice" ADD CONSTRAINT "saas_notice_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin"."saas_seller_commission" ADD CONSTRAINT "saas_seller_commission_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "storage_usage_day" ADD CONSTRAINT "storage_usage_day_organization_id_saas_account_id_fk" FOREIGN KEY ("organization_id") REFERENCES "admin"."saas_account"("id") ON DELETE no action ON UPDATE no action;
