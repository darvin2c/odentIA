CREATE TABLE "agent_handoff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"priority" text DEFAULT 'media' NOT NULL,
	"assignee_user_id" text,
	"task_id" uuid,
	"created_by" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_handoff_priority_check" CHECK ("agent_handoff"."priority" in ('alta','media','baja'))
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"branch_id" uuid,
	"status" text DEFAULT 'borrador' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_entry_kind_check" CHECK ("agent_knowledge_entry"."kind" in ('faq','info_sede','politica')),
	CONSTRAINT "agent_knowledge_entry_status_check" CHECK ("agent_knowledge_entry"."status" in ('borrador','publicada')),
	CONSTRAINT "agent_knowledge_entry_version_check" CHECK ("agent_knowledge_entry"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"modes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"action" text NOT NULL,
	"status" text DEFAULT 'propuesta' NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"result" jsonb,
	"error" text,
	"proposed_by" text DEFAULT 'agent' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposal_action_check" CHECK ("agent_proposal"."action" in ('reservar_cita','reprogramar_cita','cancelar_cita')),
	CONSTRAINT "agent_proposal_status_check" CHECK ("agent_proposal"."status" in ('propuesta','aprobada','rechazada','ejecutada','fallida','expirada'))
);
--> statement-breakpoint
CREATE TABLE "agent_run_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"trigger_message_id" uuid,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"tools_used" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	CONSTRAINT "agent_run_ledger_status_check" CHECK ("agent_run_ledger"."status" in ('ok','handoff','error','omitida'))
);
--> statement-breakpoint
CREATE TABLE "automation_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'granted' NOT NULL,
	"source" text DEFAULT 'recepcion' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"rule_id" uuid,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"dedupe_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"contact_id" uuid,
	"appointment_id" uuid,
	"patient_id" uuid,
	"budget_id" uuid,
	"opportunity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_link_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"purpose" text NOT NULL,
	"job_id" uuid,
	"appointment_id" uuid,
	"contact_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"template_name" text,
	"template_language" text DEFAULT 'es_PE' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professional_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"dentist_user_id" text NOT NULL,
	"weekday" smallint NOT NULL,
	"start_min" smallint NOT NULL,
	"end_min" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_schedule_weekday_check" CHECK ("professional_schedule"."weekday" between 0 and 6),
	CONSTRAINT "professional_schedule_range_check" CHECK ("professional_schedule"."start_min" >= 0 and "professional_schedule"."end_min" <= 1440 and "professional_schedule"."end_min" > "professional_schedule"."start_min")
);
--> statement-breakpoint
CREATE TABLE "schedule_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"dentist_user_id" text,
	"chair_id" uuid,
	"kind" text DEFAULT 'bloqueo' NOT NULL,
	"reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_block_range_check" CHECK ("schedule_block"."ends_at" > "schedule_block"."starts_at"),
	CONSTRAINT "schedule_block_kind_check" CHECK ("schedule_block"."kind" in ('bloqueo','ausencia'))
);
--> statement-breakpoint
CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid,
	"contact_id" uuid,
	"dentist_user_id" text,
	"service_id" uuid,
	"service_name" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'en_espera' NOT NULL,
	"notes" text,
	"offered_starts_at" timestamp with time zone,
	"offered_ends_at" timestamp with time zone,
	"offered_chair_id" uuid,
	"confirmed_appointment_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entry_priority_check" CHECK ("waitlist_entry"."priority" in ('alta','normal','baja')),
	CONSTRAINT "waitlist_entry_status_check" CHECK ("waitlist_entry"."status" in ('en_espera','ofrecida','confirmada','cancelada')),
	CONSTRAINT "waitlist_entry_subject_check" CHECK ("waitlist_entry"."patient_id" is not null or "waitlist_entry"."contact_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "clinical_form_addendum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"response_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_form_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"professional_user_id" text,
	"status" text DEFAULT 'borrador' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"author_user_id" text,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_form_response_status_check" CHECK ("clinical_form_response"."status" in ('borrador','finalizado'))
);
--> statement-breakpoint
CREATE TABLE "clinical_form_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"schema" jsonb NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_form_template_status_check" CHECK ("clinical_form_template"."status" in ('borrador','publicado','archivado')),
	CONSTRAINT "clinical_form_template_version_check" CHECK ("clinical_form_template"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "clinical_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"specialty_id" uuid,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"from_user_id" text,
	"recipient" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'solicitado' NOT NULL,
	"result_text" text,
	"result_at" timestamp with time zone,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_order_kind_check" CHECK ("clinical_order"."kind" in ('laboratorio','interconsulta')),
	CONSTRAINT "clinical_order_status_check" CHECK ("clinical_order"."status" in ('solicitado','en_proceso','completado','cancelado'))
);
--> statement-breakpoint
CREATE TABLE "consent_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"body_snapshot" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"plan_item_id" uuid,
	"procedure_ref" text,
	"signer_kind" text DEFAULT 'paciente' NOT NULL,
	"signer_name" text NOT NULL,
	"signer_doc" text,
	"representative_relation" text,
	"signature_data" jsonb,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"author_user_id" text,
	"signed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_document_status_check" CHECK ("consent_document"."status" in ('pendiente','firmado','revocado')),
	CONSTRAINT "consent_document_signer_check" CHECK ("consent_document"."signer_kind" in ('paciente','representante'))
);
--> statement-breakpoint
CREATE TABLE "consent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_template_status_check" CHECK ("consent_template"."status" in ('borrador','publicado','archivado')),
	CONSTRAINT "consent_template_version_check" CHECK ("consent_template"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "org_specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professional_specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"method" text,
	"concept" text NOT NULL,
	"patient_payment_id" uuid,
	"expense_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "cash_movement_amount_check" CHECK ("cash_movement"."amount_cents" > 0),
	CONSTRAINT "cash_movement_direction_check" CHECK ("cash_movement"."direction" IN ('ingreso','egreso')),
	CONSTRAINT "cash_movement_kind_check" CHECK ("cash_movement"."kind" IN ('apertura','cobro','gasto','aporte','retiro','devolucion','ajuste'))
);
--> statement-breakpoint
CREATE TABLE "cash_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"opening_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'abierta' NOT NULL,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_notes" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"expected_cents" integer,
	"electronic_cents" integer,
	"counted_cents" integer,
	"difference_cents" integer,
	"close_notes" text,
	CONSTRAINT "cash_shift_opening_check" CHECK ("cash_shift"."opening_cents" >= 0),
	CONSTRAINT "cash_shift_status_check" CHECK ("cash_shift"."status" IN ('abierta','cerrada'))
);
--> statement-breakpoint
CREATE TABLE "commission_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"professional_user_id" text NOT NULL,
	"base" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"service_id" uuid,
	"branch_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rule_rate_check" CHECK ("commission_rule"."rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "commission_rule_base_check" CHECK ("commission_rule"."base" IN ('cobrado','produccion'))
);
--> statement-breakpoint
CREATE TABLE "commission_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"professional_user_id" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"base" text NOT NULL,
	"currency" char(3) NOT NULL,
	"base_cents" integer DEFAULT 0 NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"notes" text,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "commission_settlement_base_check" CHECK ("commission_settlement"."base" IN ('cobrado','produccion')),
	CONSTRAINT "commission_settlement_status_check" CHECK ("commission_settlement"."status" IN ('borrador','liquidada','anulada')),
	CONSTRAINT "commission_settlement_period_check" CHECK ("commission_settlement"."period_to" >= "commission_settlement"."period_from")
);
--> statement-breakpoint
CREATE TABLE "commission_settlement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"settlement_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"charge_id" uuid,
	"payment_id" uuid,
	"patient_id" uuid,
	"description" text NOT NULL,
	"base_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "commission_line_base_check" CHECK ("commission_settlement_line"."base_cents" >= 0),
	CONSTRAINT "commission_line_amount_check" CHECK ("commission_settlement_line"."commission_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid,
	"shift_id" uuid,
	"concept" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_kind" text DEFAULT 'ninguno' NOT NULL,
	"receipt_number" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "expense_amount_check" CHECK ("expense"."amount_cents" > 0),
	CONSTRAINT "expense_receipt_check" CHECK ("expense"."receipt_kind" IN ('boleta','factura','recibo','nota','ninguno'))
);
--> statement-breakpoint
CREATE TABLE "installment_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" integer NOT NULL,
	"installments" integer NOT NULL,
	"status" text DEFAULT 'vigente' NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "installment_plan_total_check" CHECK ("installment_plan"."total_cents" > 0),
	CONSTRAINT "installment_plan_count_check" CHECK ("installment_plan"."installments" BETWEEN 1 AND 60),
	CONSTRAINT "installment_plan_status_check" CHECK ("installment_plan"."status" IN ('vigente','saldada','anulada'))
);
--> statement-breakpoint
CREATE TABLE "installment_quota" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"nro" integer NOT NULL,
	"due_at" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_quota_nro_check" CHECK ("installment_quota"."nro" > 0),
	CONSTRAINT "installment_quota_amount_check" CHECK ("installment_quota"."amount_cents" > 0),
	CONSTRAINT "installment_quota_paid_check" CHECK ("installment_quota"."paid_cents" >= 0),
	CONSTRAINT "installment_quota_status_check" CHECK ("installment_quota"."status" IN ('pendiente','parcial','pagada','vencida'))
);
--> statement-breakpoint
CREATE TABLE "workspace_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'insumo' NOT NULL,
	"unit" text DEFAULT 'unidad' NOT NULL,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_kind_check" CHECK ("product"."kind" IN ('insumo','producto')),
	CONSTRAINT "product_min_stock_check" CHECK ("product"."min_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier_id" uuid,
	"purchase_order_id" uuid,
	"code" text NOT NULL,
	"expires_at" date,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_lot_onhand_check" CHECK ("product_lot"."quantity_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"currency" text DEFAULT 'PEN' NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_status_check" CHECK ("purchase_order"."status" IN ('borrador','confirmada','parcialmente_recibida','recibida','cancelada')),
	CONSTRAINT "purchase_order_currency_check" CHECK ("purchase_order"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_line_quantity_check" CHECK ("purchase_order_line"."quantity" > 0),
	CONSTRAINT "purchase_order_line_cost_check" CHECK ("purchase_order_line"."unit_cost_cents" >= 0),
	CONSTRAINT "purchase_order_line_received_check" CHECK ("purchase_order_line"."received_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"dest_warehouse_id" uuid,
	"kind" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"purchase_order_id" uuid,
	"patient_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_kind_check" CHECK ("stock_movement"."kind" IN ('ingreso','consumo','ajuste','traslado')),
	CONSTRAINT "stock_movement_delta_check" CHECK ("stock_movement"."quantity_delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"doc_type" text,
	"doc_number" text,
	"email" text,
	"phone" text,
	"address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"patient_id" uuid,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"title" text NOT NULL,
	"service_id" uuid,
	"interest_text" text,
	"amount_cents" integer,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"assigned_user_id" text,
	"next_action_at" timestamp with time zone,
	"next_action_note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"budget_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"actor_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"idempotency_key" text,
	"delivery_conversation_id" uuid,
	"delivery_message_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "portal_link_status_check" CHECK ("portal_link"."status" IN ('pendiente','usado','revocado'))
);
--> statement-breakpoint
CREATE TABLE "portal_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"issued_by" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mailbox_oauth_state" (
	"nonce" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webchat_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment" DROP CONSTRAINT "appointment_status_check";--> statement-breakpoint
ALTER TABLE "contact" DROP CONSTRAINT "contact_stage_id_pipeline_stage_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD CONSTRAINT "agent_knowledge_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD CONSTRAINT "agent_knowledge_entry_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" ADD CONSTRAINT "agent_knowledge_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" ADD CONSTRAINT "agent_knowledge_revision_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policy" ADD CONSTRAINT "agent_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_consent" ADD CONSTRAINT "automation_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_job" ADD CONSTRAINT "automation_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_job" ADD CONSTRAINT "automation_job_rule_id_automation_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_link_token" ADD CONSTRAINT "automation_link_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_link_token" ADD CONSTRAINT "automation_link_token_job_id_automation_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."automation_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_chair_id_schedule_chair_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."schedule_chair"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_offered_chair_id_schedule_chair_id_fk" FOREIGN KEY ("offered_chair_id") REFERENCES "public"."schedule_chair"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_response_id_clinical_form_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."clinical_form_response"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_template_id_clinical_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."clinical_form_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_completed_by_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_template_id_consent_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."consent_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_document_id_consent_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."consent_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_specialty" ADD CONSTRAINT "org_specialty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_specialty" ADD CONSTRAINT "service_specialty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_specialty" ADD CONSTRAINT "service_specialty_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_specialty" ADD CONSTRAINT "service_specialty_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_patient_payment_id_patient_payment_id_fk" FOREIGN KEY ("patient_payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_settled_by_user_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_settlement_id_commission_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."commission_settlement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plan" ADD CONSTRAINT "installment_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plan" ADD CONSTRAINT "installment_plan_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plan" ADD CONSTRAINT "installment_plan_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plan" ADD CONSTRAINT "installment_plan_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plan" ADD CONSTRAINT "installment_plan_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_quota" ADD CONSTRAINT "installment_quota_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_quota" ADD CONSTRAINT "installment_quota_plan_id_installment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."installment_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_lot_id_product_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_dest_warehouse_id_warehouse_id_fk" FOREIGN KEY ("dest_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_pipeline_id_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipeline"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_from_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_to_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_session_id_portal_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."portal_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_delivery_conversation_id_conversation_id_fk" FOREIGN KEY ("delivery_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_delivery_message_id_message_id_fk" FOREIGN KEY ("delivery_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_link_id_portal_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."portal_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_handoff_org_idx" ON "agent_handoff" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_handoff_conversation_idx" ON "agent_handoff" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_entry_org_idx" ON "agent_knowledge_entry" USING btree ("organization_id","status","kind");--> statement-breakpoint
CREATE INDEX "agent_knowledge_revision_entry_idx" ON "agent_knowledge_revision" USING btree ("entry_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_revision_entry_version_uidx" ON "agent_knowledge_revision" USING btree ("entry_id","version");--> statement-breakpoint
CREATE INDEX "agent_proposal_org_idx" ON "agent_proposal" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposal_conversation_idx" ON "agent_proposal" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposal_org_key_uidx" ON "agent_proposal" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_run_ledger_org_idx" ON "agent_run_ledger" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_run_ledger_conversation_idx" ON "agent_run_ledger" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_consent_org_contact_purpose_channel_uidx" ON "automation_consent" USING btree ("organization_id","contact_id","purpose","channel");--> statement-breakpoint
CREATE INDEX "automation_consent_org_contact_idx" ON "automation_consent" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_job_org_dedupe_uidx" ON "automation_job" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_job_org_status_scheduled_idx" ON "automation_job" USING btree ("organization_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "automation_job_org_appointment_idx" ON "automation_job" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "automation_job_org_contact_idx" ON "automation_job" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "automation_job_org_opportunity_idx" ON "automation_job" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "automation_link_token_org_expires_idx" ON "automation_link_token" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_org_id_uidx" ON "automation_rule" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "automation_rule_org_kind_idx" ON "automation_rule" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_schedule_org_id_uidx" ON "professional_schedule" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "professional_schedule_org_branch_dentist_idx" ON "professional_schedule" USING btree ("organization_id","branch_id","dentist_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_block_org_id_uidx" ON "schedule_block" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_block_org_branch_range_idx" ON "schedule_block" USING btree ("organization_id","branch_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entry_org_id_uidx" ON "waitlist_entry" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "waitlist_entry_org_branch_status_idx" ON "waitlist_entry" USING btree ("organization_id","branch_id","status");--> statement-breakpoint
CREATE INDEX "clinical_form_addendum_response_idx" ON "clinical_form_addendum" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "clinical_form_response_org_patient_idx" ON "clinical_form_response" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "clinical_form_response_org_encounter_idx" ON "clinical_form_response" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE INDEX "clinical_form_response_org_template_idx" ON "clinical_form_response" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_form_template_org_key_version_uidx" ON "clinical_form_template" USING btree ("organization_id","key","version");--> statement-breakpoint
CREATE INDEX "clinical_form_template_org_specialty_idx" ON "clinical_form_template" USING btree ("organization_id","specialty_id");--> statement-breakpoint
CREATE INDEX "clinical_form_template_org_status_idx" ON "clinical_form_template" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "clinical_order_org_patient_idx" ON "clinical_order" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "clinical_order_org_status_idx" ON "clinical_order" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "clinical_order_org_specialty_idx" ON "clinical_order" USING btree ("organization_id","specialty_id");--> statement-breakpoint
CREATE INDEX "consent_document_org_patient_idx" ON "consent_document" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "consent_document_org_status_idx" ON "consent_document" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "consent_document_org_template_idx" ON "consent_document" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE INDEX "consent_event_document_idx" ON "consent_event" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_template_org_key_version_uidx" ON "consent_template" USING btree ("organization_id","key","version");--> statement-breakpoint
CREATE INDEX "consent_template_org_specialty_idx" ON "consent_template" USING btree ("organization_id","specialty_id");--> statement-breakpoint
CREATE INDEX "consent_template_org_status_idx" ON "consent_template" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_specialty_org_key_uidx" ON "org_specialty" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "org_specialty_org_active_idx" ON "org_specialty" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_specialty_uidx" ON "professional_specialty" USING btree ("organization_id","specialty_id","user_id");--> statement-breakpoint
CREATE INDEX "professional_specialty_org_user_idx" ON "professional_specialty" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_specialty_uidx" ON "service_specialty" USING btree ("organization_id","specialty_id","service_id");--> statement-breakpoint
CREATE INDEX "service_specialty_org_service_idx" ON "service_specialty" USING btree ("organization_id","service_id");--> statement-breakpoint
CREATE INDEX "cash_movement_org_shift_idx" ON "cash_movement" USING btree ("organization_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_payment_uidx" ON "cash_movement" USING btree ("organization_id","patient_payment_id") WHERE "cash_movement"."patient_payment_id" IS NOT NULL AND "cash_movement"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cash_shift_org_branch_idx" ON "cash_shift" USING btree ("organization_id","branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_shift_open_uidx" ON "cash_shift" USING btree ("organization_id","branch_id","currency") WHERE status = 'abierta';--> statement-breakpoint
CREATE INDEX "commission_rule_org_prof_idx" ON "commission_rule" USING btree ("organization_id","professional_user_id");--> statement-breakpoint
CREATE INDEX "commission_settlement_org_prof_idx" ON "commission_settlement" USING btree ("organization_id","professional_user_id","period_from");--> statement-breakpoint
CREATE INDEX "commission_line_org_settlement_idx" ON "commission_settlement_line" USING btree ("organization_id","settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_line_source_uidx" ON "commission_settlement_line" USING btree ("organization_id","source_key") WHERE "commission_settlement_line"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expense_org_branch_spent_idx" ON "expense" USING btree ("organization_id","branch_id","spent_at");--> statement-breakpoint
CREATE INDEX "expense_org_supplier_idx" ON "expense" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "installment_plan_org_patient_idx" ON "installment_plan" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_plan_charge_uidx" ON "installment_plan" USING btree ("organization_id","charge_id") WHERE "installment_plan"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "installment_quota_org_plan_idx" ON "installment_quota" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_quota_plan_nro_uidx" ON "installment_quota" USING btree ("plan_id","nro");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_notification_recipient_key_uidx" ON "workspace_notification" USING btree ("organization_id","user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "workspace_notification_recipient_date_idx" ON "workspace_notification" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_org_id_uidx" ON "product" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_org_sku_uidx" ON "product" USING btree ("organization_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lot_org_id_uidx" ON "product_lot" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lot_org_product_warehouse_code_uidx" ON "product_lot" USING btree ("organization_id","product_id","warehouse_id","code");--> statement-breakpoint
CREATE INDEX "product_lot_org_product_idx" ON "product_lot" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "product_lot_org_expires_idx" ON "product_lot" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_org_id_uidx" ON "purchase_order" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "purchase_order_org_supplier_idx" ON "purchase_order" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_order_org_status_idx" ON "purchase_order" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_line_org_order_product_uidx" ON "purchase_order_line" USING btree ("organization_id","order_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_org_id_uidx" ON "stock_movement" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_org_idempotency_uidx" ON "stock_movement" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_movement_org_product_idx" ON "stock_movement" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movement_org_warehouse_idx" ON "stock_movement" USING btree ("organization_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movement_org_patient_idx" ON "stock_movement" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_id_uidx" ON "supplier" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_doc_uidx" ON "supplier" USING btree ("organization_id","doc_type","doc_number") WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_org_id_uidx" ON "warehouse" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "warehouse_org_branch_idx" ON "warehouse" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_org_id_uidx" ON "opportunity" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "opportunity_org_contact_idx" ON "opportunity" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_patient_idx" ON "opportunity" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_stage_idx" ON "opportunity" USING btree ("organization_id","stage_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_status_idx" ON "opportunity" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "opportunity_org_assigned_idx" ON "opportunity" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_next_action_idx" ON "opportunity" USING btree ("organization_id","next_action_at");--> statement-breakpoint
CREATE INDEX "opportunity_event_org_opp_idx" ON "opportunity_event" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "portal_access_log_org_session_idx" ON "portal_access_log" USING btree ("organization_id","session_id");--> statement-breakpoint
CREATE INDEX "portal_access_log_org_created_idx" ON "portal_access_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_org_id_uidx" ON "portal_link" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_token_hash_uidx" ON "portal_link" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_org_idempotency_uidx" ON "portal_link" USING btree ("organization_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_link_org_patient_idx" ON "portal_link" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "portal_link_org_contact_idx" ON "portal_link" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "portal_link_org_expires_idx" ON "portal_link" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_session_org_id_uidx" ON "portal_session" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_session_token_hash_uidx" ON "portal_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_session_org_patient_idx" ON "portal_session" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "portal_session_org_link_idx" ON "portal_session" USING btree ("organization_id","link_id");--> statement-breakpoint
CREATE INDEX "portal_session_org_expires_idx" ON "portal_session" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "webchat_rate_limit_window_idx" ON "webchat_rate_limit" USING btree ("window_start");--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_status_check" CHECK ("appointment"."status" in ('programada','confirmada','atendida','no_asistio','cancelada'));