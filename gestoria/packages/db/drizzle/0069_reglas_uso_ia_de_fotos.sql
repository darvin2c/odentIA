-- El uso de la IA de fotos sale del saldo del plan (`uso.contado` con `kind: "ia_fotos"` del
-- acuerdo): lo anota el servidor en la transacción de la persona que pidió mirar, al cerrar su
-- `ai_look`. Hasta ahora solo el agente anotaba uso (`0009_reglas_acuerdo.sql`); eso sigue igual,
-- y una persona anota solo el uso de una mirada suya, ya terminada, de su tienda: con la misma id
-- de la mirada como clave del aviso y sus mismas fotos. Así nadie cuenta de más ni a nombre de otro.
DROP POLICY contract_outbox_create ON contract_outbox;--> statement-breakpoint
CREATE POLICY contract_outbox_create ON contract_outbox FOR INSERT TO gestoria_app
  WITH CHECK (
    store_id = app_store_id() AND sent_at IS NULL AND attempts = 0
    AND (
      (type = 'uso.contado') = app_is_agent()
      OR (
        type = 'uso.contado' AND NOT app_is_agent()
        AND payload -> 'data' ->> 'kind' = 'ia_fotos'
        AND EXISTS (
          SELECT 1 FROM ai_look l
          WHERE l.id = contract_outbox.id
            AND l.store_id = contract_outbox.store_id
            AND l.id::text = contract_outbox.payload -> 'data' ->> 'look'
            AND l.photos::text = contract_outbox.payload -> 'data' ->> 'photos'
            AND l.requested_by = app_user_id()
            AND l.state <> 'mirando'
        )
      )
    )
  );
