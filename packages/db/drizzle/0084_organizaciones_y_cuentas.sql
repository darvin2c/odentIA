-- Administración de organizaciones y cuentas.
-- Tablas globales internas: solo el rol owner las toca. La app nunca las lee
-- ni escribe directo: los servicios de admin usan un tx owner tras el guard.
CREATE TABLE "user_global_block" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "reason" text NOT NULL CHECK (length(trim("reason")) BETWEEN 10 AND 500),
  "blocked_by" text REFERENCES "user"("id"),
  "blocked_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "active" boolean NOT NULL DEFAULT true,
  "unblocked_by" text REFERENCES "user"("id"),
  "unblocked_at" timestamptz
);--> statement-breakpoint
-- kind: 'acceso' (recuperar acceso) o 'propiedad' (disputa de propiedad).
-- status: 'pendiente' | 'aprobada' | 'rechazada' | 'ejecutada'.
-- approvals: [{ staffId, role, decision, note, at }]. Ejecutar exige doble
-- control: dos aprobaciones de staff distinto con al menos un admin.
CREATE TABLE "account_recovery_case" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "email" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('acceso', 'propiedad')),
  "status" text NOT NULL DEFAULT 'pendiente'
    CHECK ("status" IN ('pendiente', 'aprobada', 'rechazada', 'ejecutada')),
  "evidence" jsonb NOT NULL DEFAULT '{}',
  "requested_by" text REFERENCES "user"("id"),
  "approvals" jsonb NOT NULL DEFAULT '[]',
  "decided_by" text REFERENCES "user"("id"),
  "decided_at" timestamptz,
  "executed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "account_recovery_case_email_idx" ON "account_recovery_case" USING btree ("email");--> statement-breakpoint
CREATE INDEX "account_recovery_case_status_idx" ON "account_recovery_case" USING btree ("status");--> statement-breakpoint
-- Recordatorio de alta incompleta (3 días): claim durable ANTES del envío.
-- status: 'claimed' (reservado, aún sin enviar) | 'sent' | 'uncertain'
-- (el SMTP falló; sin reintento automático). El INSERT es la reserva
-- atómica: dos workers nunca envían dos veces.
CREATE TABLE "account_lifecycle_notice" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'recordatorio_3d',
  "status" text NOT NULL DEFAULT 'claimed'
    CHECK ("status" IN ('claimed', 'sent', 'uncertain')),
  "attempts" integer NOT NULL DEFAULT 0,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- Solo owner: la aplicación no toca estas tablas (ni siquiera lectura).
REVOKE ALL ON TABLE "user_global_block" FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE "account_recovery_case" FROM dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE "account_lifecycle_notice" FROM dentalagent_app;
--> statement-breakpoint
-- La app admin vive en esos subdominios: si un tenant los usa, la migración
-- se detiene con instrucción explícita en vez de desplegar encima o
-- renombrar la clínica en silencio.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "organization" WHERE "slug" IN ('admin', 'storage')) THEN
    RAISE EXCEPTION 'Slug reservado en uso: existe una organización con slug admin o storage. Reasigne su slug (p. ej. mi-clinica-admin) y repita la migración; no se renombró nada automáticamente.';
  END IF;
END $$;
--> statement-breakpoint
-- Sin backfill de suscripciones: las clínicas existentes quedan sin fila en
-- saas_subscription (legado exento, fail-open) hasta que un admin les asigne
-- plan explícitamente. No se aplica suspensión/cobros futuros ni marca demo.
-- Las nuevas la crean con el trigger `saas_trial_on_org_create` (prueba 14d).
