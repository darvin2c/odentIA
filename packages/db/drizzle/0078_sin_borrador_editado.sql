-- Sin borrador editado (ADR 0021): en una conversación el agente responde
-- directo, así que ningún mensaje de texto suyo espera que el equipo lo
-- apruebe corrigiéndolo. Se retiran el texto aprobado con edición y el motivo
-- de revisión que nacía de él. Una fila de revisión que quedara con ese motivo
-- (solo desarrollo; no hay producción) pasa a «la marcó alguien del equipo»,
-- que es lo que fue: no se borra porque una lección puede apuntarla.
ALTER TABLE "agent_review_item" DROP CONSTRAINT "agent_review_item_reason_check";--> statement-breakpoint
UPDATE "agent_review_item" SET "reason" = 'marcada' WHERE "reason" = 'editada';--> statement-breakpoint
ALTER TABLE "agent_proposal" DROP COLUMN "edited_text";--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_reason_check" CHECK ("agent_review_item"."reason" in ('equipo_tomo','repitio_pregunta','muestra','marcada'));
