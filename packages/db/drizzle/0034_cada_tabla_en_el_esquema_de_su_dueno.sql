-- Cada tabla en el esquema de su dueño (ADR 0064). En public queda lo que
-- pertenece a una clínica. Mover una tabla conserva sus filas, índices, llaves,
-- disparadores, RLS y permisos; las llaves entre esquemas siguen valiendo.
CREATE SCHEMA admin;--> statement-breakpoint
CREATE SCHEMA catalog;--> statement-breakpoint
CREATE SCHEMA auth;--> statement-breakpoint

-- admin: el negocio de odentIA.
ALTER TABLE public.admin_staff SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.admin_audit SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.admin_invitation SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.admin_session_verification SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.user_global_block SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.account_recovery_case SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.account_lifecycle_notice SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.consumer_complaint SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.consumer_complaint_counter SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.legal_notice SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_plan SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_whatsapp_rate SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_payment_method SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_negotiation SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_seller SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_seller_commission SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_commission_adjustment SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_commission_settlement SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_commission_settlement_line SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_signup_policy SET SCHEMA admin;--> statement-breakpoint
ALTER TABLE public.saas_waitlist_request SET SCHEMA admin;--> statement-breakpoint

-- catalog: listas oficiales y biblioteca global.
ALTER TABLE public.diagnosis_code_system SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.diagnosis_code_release SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.diagnosis_code SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.procedure_code_system SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.procedure_code SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.procedure_catalog_release SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.treatment_template SET SCHEMA catalog;--> statement-breakpoint
ALTER TABLE public.treatment_template_code SET SCHEMA catalog;--> statement-breakpoint

-- auth: usuarios y acceso.
ALTER TABLE public."user" SET SCHEMA auth;--> statement-breakpoint
ALTER TABLE public.session SET SCHEMA auth;--> statement-breakpoint
ALTER TABLE public.account SET SCHEMA auth;--> statement-breakpoint
ALTER TABLE public.verification SET SCHEMA auth;--> statement-breakpoint
ALTER TABLE public.two_factor SET SCHEMA auth;--> statement-breakpoint

-- Los nombres no se repiten entre esquemas: el SQL a mano los sigue nombrando
-- sin esquema. Vale para cada conexión nueva; set_config cubre esta misma.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, catalog, auth, admin', current_database());
END
$$;--> statement-breakpoint
SELECT set_config('search_path', 'public, catalog, auth, admin', false);--> statement-breakpoint

-- Las funciones que fijaban search_path=public (topes del plan, prueba al crear
-- la clínica) leen saas_plan y user, que ya no están ahí.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND 'search_path=public' = ANY (p.proconfig)
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, catalog, auth, admin', f);
  END LOOP;
END
$$;--> statement-breakpoint

-- Permisos (ADR 0063: nada nace abierto). El rol app entra a los tres esquemas,
-- pero en admin solo lee la lista de precios que la clínica ve al elegir plan y
-- pagar; el resto de admin sigue sin permiso alguno. Catalog es solo lectura.
GRANT USAGE ON SCHEMA admin, catalog, auth TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE admin.saas_seller_commission FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE admin.saas_commission_adjustment FROM dentalagent_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA catalog FROM dentalagent_app;
