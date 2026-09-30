CREATE TABLE "crm_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"opportunity_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD COLUMN "before_summary" text;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD COLUMN "after_summary" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunity" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_note_org_id_uidx" ON "crm_note" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "crm_note_org_contact_created_idx" ON "crm_note" USING btree ("organization_id","contact_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crm_note_org_conversation_idx" ON "crm_note" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "crm_note_org_opportunity_idx" ON "crm_note" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_opp_open_uidx" ON "task" USING btree ("organization_id","opportunity_id") WHERE "opportunity_id" IS NOT NULL AND "kind" = 'opportunity_follow_up' AND "status" = 'open';--> statement-breakpoint
CREATE INDEX "task_org_contact_idx" ON "task" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "task_org_conversation_idx" ON "task" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "task_org_opportunity_idx" ON "task" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "task_org_status_due_idx" ON "task" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX "opportunity_org_conversation_idx" ON "opportunity" USING btree ("organization_id","conversation_id");
--> statement-breakpoint
-- Notas operativas inmutables y vínculos nuevos aislados por organización.
ALTER TABLE "crm_note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "crm_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "crm_note_select" ON "crm_note" FOR SELECT TO dentalagent_app
  USING (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
CREATE POLICY "crm_note_insert" ON "crm_note" FOR INSERT TO dentalagent_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT ON "crm_note" TO dentalagent_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "crm_note" FROM dentalagent_app;
--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_body_check"
  CHECK (length(trim(body)) BETWEEN 1 AND 2000);
--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_contact_org_fk"
  FOREIGN KEY (organization_id, contact_id) REFERENCES contact (organization_id, id);
--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_conversation_org_fk"
  FOREIGN KEY (organization_id, conversation_id) REFERENCES conversation (organization_id, id);
--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_opportunity_org_fk"
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES opportunity (organization_id, id);
--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_conversation_org_fk"
  FOREIGN KEY (organization_id, conversation_id) REFERENCES conversation (organization_id, id);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_opportunity_org_fk"
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES opportunity (organization_id, id)
  ON DELETE SET NULL (opportunity_id);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_kind_check" CHECK (kind IN ('manual', 'opportunity_follow_up'));
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_status_check" CHECK (status IN ('open', 'done', 'cancelled'));
--> statement-breakpoint
-- Cada fecha comercial existente se convierte en una tarea real; no se infiere un hilo origen.
INSERT INTO task (organization_id, contact_id, conversation_id, opportunity_id, kind, title, assignee_user_id, due_at, created_by)
SELECT organization_id, contact_id, conversation_id, id, 'opportunity_follow_up',
  left(coalesce(nullif(trim(next_action_note), ''), 'Seguimiento: ' || title), 200),
  assigned_user_id, next_action_at, 'user'
FROM opportunity WHERE status = 'open' AND next_action_at IS NOT NULL;
--> statement-breakpoint
-- Drizzle no genera cambios de CHECK existentes: ampliar explícitamente los actos permitidos.
ALTER TABLE "agent_proposal" DROP CONSTRAINT "agent_proposal_action_check";
--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_action_check"
  CHECK (action IN ('reservar_cita', 'reprogramar_cita', 'cancelar_cita', 'enviar_mensaje',
    'mover_oportunidad', 'crear_oportunidad', 'actualizar_seguimiento', 'cerrar_oportunidad'));
--> statement-breakpoint
CREATE FUNCTION crm_contact_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation c WHERE c.id = NEW.conversation_id
      AND c.organization_id = NEW.organization_id AND c.contact_id = NEW.contact_id
  ) THEN
    RAISE EXCEPTION 'La conversación no pertenece al contacto de la organización' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('crm_note', 'task') THEN
    IF NEW.opportunity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity o WHERE o.id = NEW.opportunity_id
        AND o.organization_id = NEW.organization_id AND o.contact_id = NEW.contact_id
    ) THEN
      RAISE EXCEPTION 'La oportunidad no pertenece al contacto de la organización' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crm_note_links_guard BEFORE INSERT ON crm_note
  FOR EACH ROW EXECUTE FUNCTION crm_contact_links_guard();
--> statement-breakpoint
CREATE TRIGGER task_links_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id, opportunity_id ON task
  FOR EACH ROW EXECUTE FUNCTION crm_contact_links_guard();
--> statement-breakpoint
CREATE TRIGGER opportunity_conversation_guard BEFORE INSERT OR UPDATE OF organization_id, contact_id, conversation_id ON opportunity
  FOR EACH ROW EXECUTE FUNCTION crm_contact_links_guard();
--> statement-breakpoint
CREATE FUNCTION agent_proposal_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.before_summary IS DISTINCT FROM OLD.before_summary OR NEW.after_summary IS DISTINCT FROM OLD.after_summary THEN
    RAISE EXCEPTION 'La evidencia de una propuesta no se modifica después de crearla' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_proposal_evidence_immutable BEFORE UPDATE ON agent_proposal
  FOR EACH ROW EXECUTE FUNCTION agent_proposal_evidence_immutable();
--> statement-breakpoint
CREATE INDEX audit_event_org_entity_created_idx ON audit_event (organization_id, entity, created_at DESC);