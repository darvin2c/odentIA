CREATE TABLE "admin"."saas_client_milestone" (
	"client_id" uuid NOT NULL,
	"step" text NOT NULL,
	"reached_at" timestamp with time zone,
	"source" text,
	"lost_at" timestamp with time zone,
	"lost_reason" text,
	"na_reason" text,
	"na_by" text,
	"na_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_client_milestone_pkey" PRIMARY KEY("client_id","step"),
	CONSTRAINT "saas_client_milestone_step_check" CHECK ("admin"."saas_client_milestone"."step" IN ('entro','contrato','carta','archivos','configuracion','pacientes','informe','equipo','whatsapp','primer_uso','primer_pago')),
	CONSTRAINT "saas_client_milestone_source_check" CHECK (("admin"."saas_client_milestone"."source" IS NULL OR "admin"."saas_client_milestone"."source" IN ('hecho','respaldo'))
        AND ("admin"."saas_client_milestone"."reached_at" IS NULL OR "admin"."saas_client_milestone"."source" IS NOT NULL)
        AND ("admin"."saas_client_milestone"."source" IS DISTINCT FROM 'respaldo' OR "admin"."saas_client_milestone"."step" = 'archivos')),
	CONSTRAINT "saas_client_milestone_na_check" CHECK (("admin"."saas_client_milestone"."na_reason" IS NULL AND "admin"."saas_client_milestone"."na_at" IS NULL AND "admin"."saas_client_milestone"."na_by" IS NULL)
        OR ("admin"."saas_client_milestone"."na_reason" IS NOT NULL AND "admin"."saas_client_milestone"."na_at" IS NOT NULL
          AND length(trim("admin"."saas_client_milestone"."na_reason")) BETWEEN 1 AND 500
          AND "admin"."saas_client_milestone"."step" IN ('equipo','whatsapp','pacientes'))),
	CONSTRAINT "saas_client_milestone_lost_check" CHECK (("admin"."saas_client_milestone"."lost_at" IS NULL AND "admin"."saas_client_milestone"."lost_reason" IS NULL)
        OR ("admin"."saas_client_milestone"."lost_at" IS NOT NULL AND "admin"."saas_client_milestone"."reached_at" IS NULL
          AND (("admin"."saas_client_milestone"."lost_reason" = 'pago_revertido' AND "admin"."saas_client_milestone"."step" = 'primer_pago')
            OR ("admin"."saas_client_milestone"."lost_reason" = 'borrados_sin_cargar' AND "admin"."saas_client_milestone"."step" = 'archivos')))),
	CONSTRAINT "saas_client_milestone_nonempty_check" CHECK ("admin"."saas_client_milestone"."reached_at" IS NOT NULL OR "admin"."saas_client_milestone"."lost_at" IS NOT NULL OR "admin"."saas_client_milestone"."na_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" DROP CONSTRAINT "kairos_item_kind_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD COLUMN "received_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD COLUMN "inbound_email_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD COLUMN "carga_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD COLUMN "admin_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_milestone" ADD CONSTRAINT "saas_client_milestone_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_milestone" ADD CONSTRAINT "saas_client_milestone_na_by_user_id_fk" FOREIGN KEY ("na_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_inbound_email_id_saas_inbound_email_id_fk" FOREIGN KEY ("inbound_email_id") REFERENCES "admin"."saas_inbound_email"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_client_file_email_idx" ON "admin"."saas_client_file" USING btree ("inbound_email_id");--> statement-breakpoint
CREATE INDEX "admin_audit_org_action_idx" ON "admin"."admin_audit" USING btree ("organization_id","action","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_kind_check" CHECK ("admin"."kairos_item"."kind" IN ('mensaje','propuesta','guion','dato','vinculo','duplicado','demo','presentacion_hecha','correo_sin_cliente','responder_correo','posible_carga'));--> statement-breakpoint

-- Kairós vigila el alta (14 nov): el relleno de lo que ya había, escrito a mano antes del check de
-- la carga (drizzle-kit lo deja al final). En una base nueva no hace nada.
--
-- 1. Cuándo llegó cada archivo: el de un correo, con la hora del correo (o la de subida, si fue
-- antes) y su correo; lo demás, cuándo se subió.
UPDATE admin.saas_client_file f SET received_at = least(e.received_at, f.created_at), inbound_email_id = e.id
FROM admin.saas_inbound_email e CROSS JOIN LATERAL jsonb_array_elements(e.attachments) a
WHERE a->>'fileId' = f.id::text;--> statement-breakpoint
UPDATE admin.saas_client_file SET received_at = created_at WHERE inbound_email_id IS NULL;--> statement-breakpoint

-- 2. Lo que una persona subió como lo que mandó la clínica ya es la carga: queda marcada cuando
-- se subió y se borra, a más tardar, a los 30 días de llegar (día de Lima). Lo ya borrado conserva
-- su día (solo se llena si faltaba, para el check).
UPDATE admin.saas_client_file SET carga_at = created_at WHERE kind = 'archivo_clinica';--> statement-breakpoint
UPDATE admin.saas_client_file SET delete_after = CASE
    WHEN deleted_at IS NULL THEN least(delete_after, (received_at AT TIME ZONE 'America/Lima')::date + 30)
    ELSE coalesce(delete_after, (received_at AT TIME ZONE 'America/Lima')::date + 30)
  END
WHERE kind = 'archivo_clinica';--> statement-breakpoint

-- 3. Lo de un correo que estaba por borrarse deja de estarlo: ahora solo se borra lo que
-- Administración marca como la carga. Queda constancia de cada uno, con el día que tenía, para
-- que Kairós lo sugiera una vez. Lo ya borrado sigue borrado.
INSERT INTO admin.admin_audit (actor_role, action, organization_id, entity_id, metadata)
SELECT 'system', 'client_file.retention_lifted', c.organization_id, f.id::text,
  jsonb_build_object('clientId', f.client_id, 'deleteAfter', f.delete_after)
FROM admin.saas_client_file f JOIN admin.saas_client c ON c.id = f.client_id
WHERE f.kind = 'correo' AND f.deleted_at IS NULL AND f.delete_after IS NOT NULL;--> statement-breakpoint
UPDATE admin.saas_client_file SET delete_after = NULL
WHERE kind = 'correo' AND deleted_at IS NULL AND delete_after IS NOT NULL;--> statement-breakpoint

-- 4. Las tareas solo de Administración: las de cobro y las que Kairós creó como solo de
-- Administración (lo anotó en su auditoría).
UPDATE admin.saas_task t SET admin_only = true
WHERE t.kind = 'cobro'
  OR EXISTS (SELECT 1 FROM admin.admin_audit a WHERE a.action = 'kairos.task_created' AND a.entity_id = t.id::text
    AND coalesce((a.metadata->>'adminOnly')::boolean, false));--> statement-breakpoint

ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_carga_check" CHECK (("admin"."saas_client_file"."kind" <> 'archivo_clinica' OR "admin"."saas_client_file"."delete_after" IS NOT NULL) AND ("admin"."saas_client_file"."carga_at" IS NULL OR "admin"."saas_client_file"."kind" = 'archivo_clinica'));