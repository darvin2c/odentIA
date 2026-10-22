-- Reglas del esquema dental (0078, ADR 0079). Las tablas movidas conservan su
-- RLS y sus permisos; las nuevas nacen cerradas (ADR 0063) y reciben solo lo
-- que la aplicación usa.
GRANT USAGE ON SCHEMA dental TO dentalagent_app;--> statement-breakpoint

-- El hallazgo que motivó un tratamiento se anota al crearlo y no se cambia.
ALTER TABLE dental.plan_item_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.plan_item_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.plan_item_finding USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE dental.plan_item_finding TO dentalagent_app;--> statement-breakpoint

-- Lo que deja un servicio se elige al crearlo o editarlo, y se puede quitar.
ALTER TABLE dental.service_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.service_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.service_finding USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE dental.service_finding TO dentalagent_app;--> statement-breakpoint
ALTER TABLE dental.service_finding ADD CONSTRAINT service_finding_condition_check CHECK (char_length(condition) BETWEEN 1 AND 60 AND (variant IS NULL OR char_length(variant) BETWEEN 1 AND 60));--> statement-breakpoint

-- La biblioteca es de solo lectura para la aplicación, también su parte dental.
GRANT SELECT ON TABLE catalog.dental_template_rule TO dentalagent_app;
