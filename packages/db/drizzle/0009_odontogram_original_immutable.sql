-- El rol de aplicación conserva el hallazgo original; solo puede registrar su corrección.
REVOKE UPDATE, DELETE ON "odontogram_entry" FROM "dentalagent_app";
--> statement-breakpoint
GRANT UPDATE ("status", "voided_at", "voided_by", "void_reason", "updated_at") ON "odontogram_entry" TO "dentalagent_app";
