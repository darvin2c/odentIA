CREATE TABLE "admin"."app_contract_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"account_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"result_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_contract_request_app_check" CHECK ("admin"."app_contract_request"."app" IN ('gestoria')),
	CONSTRAINT "app_contract_request_type_check" CHECK ("admin"."app_contract_request"."type" IN ('cuenta.abrir','soporte.entrar','equipo.quitar')),
	CONSTRAINT "app_contract_request_status_check" CHECK ("admin"."app_contract_request"."status" IN ('pendiente','hecho','fallo') AND ("admin"."app_contract_request"."status" = 'pendiente') = ("admin"."app_contract_request"."done_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "admin"."app_contract_request" ADD CONSTRAINT "app_contract_request_account_id_saas_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."app_contract_request" ADD CONSTRAINT "app_contract_request_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_contract_request_pending_idx" ON "admin"."app_contract_request" USING btree ("app","next_attempt_at") WHERE status = 'pendiente';--> statement-breakpoint
CREATE INDEX "app_contract_request_account_idx" ON "admin"."app_contract_request" USING btree ("account_id","created_at");