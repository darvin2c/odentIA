ALTER TABLE "agent_proposal" ADD COLUMN "expected_state" jsonb;--> statement-breakpoint
--> statement-breakpoint
-- El esquema declaraba 3 actos pero la 0029 ya amplió el CHECK a 8 en la
-- base; se re-alinea de forma incremental (DROP+ADD idempotente).
ALTER TABLE "agent_proposal" DROP CONSTRAINT "agent_proposal_action_check";--> statement-breakpoint
--> statement-breakpoint
-- Las pendientes/aprobadas que pisan estado (mover/cerrar/seguimiento/cita)
-- sin expected_state no tienen evidencia para revalidar: caducan de forma
-- explícita y se recrean con snapshot fresco (nunca ejecutan a ciegas).
UPDATE "agent_proposal" SET "status" = 'expirada', "updated_at" = now()
WHERE "status" IN ('propuesta', 'aprobada')
  AND "action" IN ('mover_oportunidad', 'cerrar_oportunidad', 'actualizar_seguimiento', 'reprogramar_cita', 'cancelar_cita')
  AND "expected_state" IS NULL;
--> statement-breakpoint
-- La evidencia congelada incluye el estado esperado: la 0029 solo protegía
-- before/after; sin este guard la precondición aprobada podría reescribirse
-- por rol app. CREATE OR REPLACE incremental (no toca el trigger existente).
CREATE OR REPLACE FUNCTION agent_proposal_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.before_summary IS DISTINCT FROM OLD.before_summary
    OR NEW.after_summary IS DISTINCT FROM OLD.after_summary
    OR NEW.expected_state IS DISTINCT FROM OLD.expected_state THEN
    RAISE EXCEPTION 'La evidencia de una propuesta no se modifica después de crearla' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_action_check"
  CHECK (action IN ('reservar_cita', 'reprogramar_cita', 'cancelar_cita', 'enviar_mensaje',
    'mover_oportunidad', 'crear_oportunidad', 'actualizar_seguimiento', 'cerrar_oportunidad'));