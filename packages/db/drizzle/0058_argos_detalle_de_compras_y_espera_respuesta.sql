-- Argos (ADR 0075 y 0076): dos datos que ya están en odentIA y las vistas no mostraban.
-- El detalle de cada orden de compra (qué producto, cuánto, a qué precio y a qué proveedor): solo quien dirige la clínica,
-- como las compras; recepción ve el inventario sin precios.
-- Si una conversación espera respuesta de la clínica: su último mensaje es de la persona. Solo la dirección del mensaje,
-- nunca su texto.
-- Las columnas nuevas van al final: una vista se reemplaza sin cambiar sus columnas de antes.
CREATE VIEW argos.compras_detalle AS
SELECT po.order_number AS numero, s.name AS proveedor, b.name AS sede, po.status AS estado, po.created_at AS creada_en,
  (po.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia,
  pr.name AS producto, pr.unit AS unidad, l.quantity AS cantidad, l.received_quantity AS recibida,
  round(l.unit_cost_cents / 100.0, 2) AS precio, round(l.quantity * l.unit_cost_cents / 100.0, 2) AS total
FROM public.purchase_order_line l
JOIN public.purchase_order po ON po.organization_id = l.organization_id AND po.id = l.order_id
JOIN public.product pr ON pr.organization_id = l.organization_id AND pr.id = l.product_id
JOIN public.supplier s ON s.organization_id = po.organization_id AND s.id = po.supplier_id
JOIN public.warehouse w ON w.organization_id = po.organization_id AND w.id = po.warehouse_id
JOIN public.branch b ON b.organization_id = w.organization_id AND b.id = w.branch_id
LEFT JOIN public.org_profile op ON op.organization_id = po.organization_id;--> statement-breakpoint
CREATE OR REPLACE VIEW argos.conversaciones AS
SELECT c.created_at AS inicio, (c.created_at AT TIME ZONE coalesce(op.timezone, 'UTC'))::date AS dia, cc.channel AS canal, c.status AS estado,
  c.close_reason AS motivo_cierre, c.closed_at AS cerrada_en, c.last_message_at AS ultimo_mensaje_en, pp.display_name AS persona, c.contact_id AS persona_id,
  (SELECT p.id FROM public.patient p WHERE p.organization_id = c.organization_id AND p.person_id = c.contact_id LIMIT 1) AS paciente_id,
  EXISTS (SELECT 1 FROM public.patient p WHERE p.organization_id = c.organization_id AND p.person_id = c.contact_id) AS es_paciente,
  c.agent_status AS agente, u.name AS asignada_a,
  coalesce((SELECT m.direction = 'in' FROM public.message m WHERE m.organization_id = c.organization_id AND m.conversation_id = c.id
    ORDER BY m.created_at DESC LIMIT 1), false) AS espera_respuesta
FROM public.conversation c
JOIN public.contact pp ON pp.organization_id = c.organization_id AND pp.id = c.contact_id
LEFT JOIN public.channel_connection cc ON cc.organization_id = c.organization_id AND cc.id = c.channel_connection_id
LEFT JOIN public.org_profile op ON op.organization_id = c.organization_id
LEFT JOIN auth."user" u ON u.id = c.assigned_user_id
WHERE pp.screen IS NULL;--> statement-breakpoint
ALTER VIEW argos.compras_detalle OWNER TO argos_dueno;--> statement-breakpoint
GRANT SELECT ON argos.compras_detalle TO argos_gestion;
