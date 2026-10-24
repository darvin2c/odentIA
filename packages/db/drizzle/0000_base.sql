-- Base del 2026-10-24, primera parte: las tablas, generadas por drizzle-kit
-- desde packages/db/src/schema/*.ts (con los índices antes que las claves
-- foráneas, porque varias apuntan a índices únicos). Reemplaza las 106
-- migraciones 0000 a 0105, que siguen en git (ADR 0088). La seguridad y las
-- reglas que el esquema TS no declara están en 0001_base_reglas.sql.
--
-- Extensiones: vector (búsqueda por significado, ADR 0021), btree_gist (las
-- citas no se pisan: EXCLUDE de la agenda), pg_trgm y unaccent (buscar sin
-- tildes, ADR 0066). pgmq y pg_cron vienen en la imagen y las crea su init; se
-- repiten con IF NOT EXISTS para que la base no dependa de ese orden.
CREATE EXTENSION IF NOT EXISTS pgmq;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_cron;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE SCHEMA "admin";--> statement-breakpoint
CREATE SCHEMA "auth";--> statement-breakpoint
CREATE SCHEMA "catalog";--> statement-breakpoint
CREATE SCHEMA "dental";--> statement-breakpoint
CREATE TABLE "admin"."admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_role" text,
	"action" text NOT NULL,
	"organization_id" text,
	"entity_id" text,
	"metadata" jsonb
);--> statement-breakpoint
CREATE TABLE "admin"."admin_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invitation_token_hash_key" UNIQUE("token_hash")
);--> statement-breakpoint
CREATE TABLE "admin"."admin_session_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"factor_id" text NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "admin"."admin_staff" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "auth"."two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "admin"."account_lifecycle_notice" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'recordatorio_3d' NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "admin"."account_recovery_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" text,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "admin"."user_global_block" (
	"user_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"blocked_by" text,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"unblocked_by" text,
	"unblocked_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "support_access_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid,
	"case_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"staff_user_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_audit_action_check" CHECK ("support_access_audit"."action" in ('vista_diagnostica','denegado_sin_permiso','revocado'))
);--> statement-breakpoint
CREATE TABLE "support_access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"scope" text DEFAULT 'diagnostico' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_grant_scope_check" CHECK ("support_access_grant"."scope" = 'diagnostico'),
	CONSTRAINT "support_access_grant_expiry_check" CHECK ("support_access_grant"."expires_at" > "support_access_grant"."created_at"),
	CONSTRAINT "support_access_grant_duration_check" CHECK ("support_access_grant"."expires_at" <= "support_access_grant"."created_at" + interval '1 hour')
);--> statement-breakpoint
CREATE TABLE "support_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" uuid,
	"organization_id" text,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachment_object_key_unique" UNIQUE("object_key")
);--> statement-breakpoint
CREATE TABLE "support_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"kind" text DEFAULT 'pregunta' NOT NULL,
	"question" text NOT NULL,
	"detail" text,
	"screen" text DEFAULT '/' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"app_version" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'abierto' NOT NULL,
	"assignee_staff_id" text,
	"opened_by" text,
	"resolved_at" timestamp with time zone,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"last_public_message_at" timestamp with time zone,
	"client_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_kind_check" CHECK ("support_case"."kind" in ('pregunta','problema','acceso','cobro')),
	CONSTRAINT "support_case_opener_check" CHECK ("support_case"."opened_by" is not null or "support_case"."organization_id" is null),
	CONSTRAINT "support_case_status_check" CHECK ("support_case"."status" in ('abierto','en_atencion','esperando_clinica','resuelto'))
);--> statement-breakpoint
CREATE TABLE "support_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text,
	"author_kind" text DEFAULT 'cliente' NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_message_author_check" CHECK ("support_message"."author_kind" in ('cliente','staff','sistema'))
);--> statement-breakpoint
CREATE TABLE "support_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"organization_id" text,
	"kind" text NOT NULL,
	"recipient_user_id" text,
	"dedupe_key" text NOT NULL,
	"email_state" text DEFAULT 'pendiente' NOT NULL,
	"emailed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_notice_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "support_notice_kind_check" CHECK ("support_notice"."kind" in ('caso_nuevo','clinica_respondio','respuesta','necesita_algo')),
	CONSTRAINT "support_notice_state_check" CHECK ("support_notice"."email_state" in ('pendiente','reclamado','enviado','incierto','omitido')),
	CONSTRAINT "support_notice_recipient_check" CHECK (("support_notice"."kind" in ('caso_nuevo','clinica_respondio')) = ("support_notice"."recipient_user_id" is null))
);--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"professional_user_id" text NOT NULL,
	"room_id" uuid NOT NULL,
	"service_id" uuid,
	"service_name" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"status" text DEFAULT 'programada' NOT NULL,
	"reason" text,
	"source" text DEFAULT 'recepcion' NOT NULL,
	"conversation_id" uuid,
	"arrived_at" timestamp with time zone,
	"arrived_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_status_check" CHECK ("appointment"."status" in ('programada','confirmada','atendida','no_asistio','cancelada')),
	CONSTRAINT "appointment_arrival_check" CHECK ("appointment"."arrived_at" IS NULL OR "appointment"."status" IN ('confirmada','atendida')),
	CONSTRAINT "appointment_arrival_pair_check" CHECK (("appointment"."arrived_at" IS NULL) = ("appointment"."arrived_by" IS NULL)),
	CONSTRAINT "appointment_range_check" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_duration_check" CHECK ("appointment"."duration_min" > 0)
);--> statement-breakpoint
CREATE TABLE "appointment_booking_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid NOT NULL,
	"patient_id" uuid,
	"service_id" uuid,
	"branch_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"appointment_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"booking" boolean DEFAULT true NOT NULL,
	"data_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "calendar_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"known_clients" text[] DEFAULT '{}'::text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_status_check" CHECK ("calendar_feed"."status" IN ('activo','revocado')),
	CONSTRAINT "calendar_feed_revoked_check" CHECK (("calendar_feed"."status" <> 'revocado') = ("calendar_feed"."revoked_at" IS NULL)),
	CONSTRAINT "calendar_feed_reason_check" CHECK ("calendar_feed"."revoke_reason" IS NULL OR "calendar_feed"."revoke_reason" IN ('cambiado','apagado','administracion','sin_acceso'))
);--> statement-breakpoint
CREATE TABLE "calendar_feed_use" (
	"organization_id" text NOT NULL,
	"feed_id" uuid NOT NULL,
	"day" date NOT NULL,
	"client" text NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_use_pkey" PRIMARY KEY("organization_id","feed_id","day","client")
);--> statement-breakpoint
CREATE TABLE "schedule_room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "agent_answer_trace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"proposal_id" uuid,
	"message_id" uuid,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"outcome" text NOT NULL,
	"reply_text" text NOT NULL,
	"basis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_answer_trace_outcome_check" CHECK ("agent_answer_trace"."outcome" in ('enviada','pendiente','bloqueada','fallida'))
);--> statement-breakpoint
CREATE TABLE "agent_case_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lookups" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "agent_decision_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"trigger_message_id" uuid,
	"point" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"state_hash" text NOT NULL,
	"state_chars" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"outcome" jsonb,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_decision_log_mode_check" CHECK ("agent_decision_log"."mode" in ('shadow','retrieval','route'))
);--> statement-breakpoint
CREATE TABLE "agent_handoff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"priority" text DEFAULT 'media' NOT NULL,
	"asks" text,
	"pending" text,
	"notice" text,
	"assignee_user_id" text,
	"task_id" uuid,
	"created_by" text DEFAULT 'agent' NOT NULL,
	"source_message_id" uuid,
	"asked_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asked_again_at" timestamp with time zone,
	"kind" text DEFAULT 'otro' NOT NULL,
	"urgent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_handoff_priority_check" CHECK ("agent_handoff"."priority" in ('alta','media','baja')),
	CONSTRAINT "agent_handoff_kind_check" CHECK ("agent_handoff"."kind" in ('cita','precio','clinico','pago','otro'))
);--> statement-breakpoint
CREATE TABLE "agent_knowledge_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"branch_id" uuid,
	"status" text DEFAULT 'borrador' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"ask_forms" text[] DEFAULT '{}' NOT NULL,
	"basic_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_entry_validity_check" CHECK ("agent_knowledge_entry"."valid_from" is null or "agent_knowledge_entry"."valid_until" is null or "agent_knowledge_entry"."valid_until" >= "agent_knowledge_entry"."valid_from"),
	CONSTRAINT "agent_knowledge_entry_kind_check" CHECK ("agent_knowledge_entry"."kind" in ('faq','info_sede','politica')),
	CONSTRAINT "agent_knowledge_entry_status_check" CHECK ("agent_knowledge_entry"."status" in ('borrador','publicada')),
	CONSTRAINT "agent_knowledge_entry_version_check" CHECK ("agent_knowledge_entry"."version" >= 1)
);--> statement-breakpoint
CREATE TABLE "agent_knowledge_gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"question" text NOT NULL,
	"query" text NOT NULL,
	"status" text DEFAULT 'abierta' NOT NULL,
	"resolved_entry_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_gap_status_check" CHECK ("agent_knowledge_gap"."status" in ('abierta','resuelta','descartada'))
);--> statement-breakpoint
CREATE TABLE "agent_knowledge_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "agent_lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'recepcion' NOT NULL,
	"title" text NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"failure" text,
	"original_reply" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'propuesta' NOT NULL,
	"review_item_id" uuid,
	"conversation_id" uuid,
	"knowledge_entry_id" uuid,
	"previous_body" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"source" text DEFAULT 'aprendida' NOT NULL,
	"proposed_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"withdrawn_by" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_lesson_kind_check" CHECK ("agent_lesson"."kind" in ('respuesta_oficial','regla','ejemplo')),
	CONSTRAINT "agent_lesson_status_check" CHECK ("agent_lesson"."status" in ('propuesta','activa','retirada','descartada')),
	CONSTRAINT "agent_lesson_source_check" CHECK ("agent_lesson"."source" in ('aprendida','escrita')),
	CONSTRAINT "agent_lesson_written_rule_check" CHECK ("agent_lesson"."source" = 'aprendida' or "agent_lesson"."kind" = 'regla'),
	CONSTRAINT "agent_lesson_failure_check" CHECK ("agent_lesson"."failure" is null or "agent_lesson"."failure" in ('dato_equivocado','falto_dato','tono','no_debio_responder','otra_cosa'))
);--> statement-breakpoint
CREATE TABLE "agent_person_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"conversation_id" uuid,
	"channel" text,
	"created_by" text,
	"status" text DEFAULT 'activo' NOT NULL,
	"replaced_by_id" uuid,
	"removed_by" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_person_fact_source_check" CHECK ("agent_person_fact"."source" in ('agente','equipo')),
	CONSTRAINT "agent_person_fact_status_check" CHECK ("agent_person_fact"."status" in ('activo','reemplazado','quitado'))
);--> statement-breakpoint
CREATE TABLE "agent_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid,
	"patient_id" uuid,
	"action" text NOT NULL,
	"status" text DEFAULT 'propuesta' NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text,
	"before_summary" text,
	"after_summary" text,
	"expected_state" jsonb,
	"idempotency_key" text NOT NULL,
	"result" jsonb,
	"error" text,
	"proposed_by" text DEFAULT 'agent' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposal_action_check" CHECK ("agent_proposal"."action" in ('reservar_cita','reprogramar_cita','cancelar_cita','enviar_mensaje','mover_oportunidad','crear_oportunidad','actualizar_seguimiento','cerrar_oportunidad','decidir_presupuesto')),
	CONSTRAINT "agent_proposal_status_check" CHECK ("agent_proposal"."status" in ('propuesta','aprobada','ejecutada','fallida','expirada'))
);--> statement-breakpoint
CREATE TABLE "agent_review_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"reply" text NOT NULL,
	"team_reply" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_item_reason_check" CHECK ("agent_review_item"."reason" in ('equipo_tomo','repitio_pregunta','muestra','marcada')),
	CONSTRAINT "agent_review_item_status_check" CHECK ("agent_review_item"."status" in ('pendiente','bien','corregida'))
);--> statement-breakpoint
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
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"llm_calls" integer,
	"cost_micros" integer,
	"tools_used" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	CONSTRAINT "agent_run_ledger_status_check" CHECK ("agent_run_ledger"."status" in ('ok','handoff','error','omitida','sin_respuesta'))
);--> statement-breakpoint
CREATE TABLE "agent_search_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"text" text NOT NULL,
	"model" text,
	"embedding" vector,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_search_item_kind_check" CHECK ("agent_search_item"."kind" in ('servicio','promocion','profesional','respuesta'))
);--> statement-breakpoint
CREATE TABLE "agent_test_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent" text DEFAULT 'recepcion' NOT NULL,
	"question" text NOT NULL,
	"expected" text NOT NULL,
	"lesson_id" uuid,
	"status" text DEFAULT 'activo' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_test_case_status_check" CHECK ("agent_test_case"."status" in ('activo','retirado'))
);--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"origin" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"audio_seconds" integer,
	"cost_micros" bigint,
	"conversation_id" uuid,
	"encounter_id" uuid,
	"report_question_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_origin_check" CHECK ("ai_usage"."origin" in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion','comprobacion','reportes')),
	CONSTRAINT "ai_usage_calls_check" CHECK ("ai_usage"."calls" >= 1),
	CONSTRAINT "ai_usage_cost_check" CHECK ("ai_usage"."cost_micros" is null or "ai_usage"."cost_micros" >= 0)
);--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"image" text,
	"terms_version" text,
	"terms_accepted_at" timestamp,
	"processing_agreement_version" text,
	"processing_agreement_accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "automation_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'granted' NOT NULL,
	"source" text DEFAULT 'presencial' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
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
	"task_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"cause" text,
	"via" text,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE TABLE "automation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"agent_part" boolean DEFAULT true NOT NULL,
	"team_part" boolean DEFAULT true NOT NULL,
	"no_recommend" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "professional_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"professional_user_id" text NOT NULL,
	"weekday" smallint NOT NULL,
	"start_min" smallint NOT NULL,
	"end_min" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_until" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_schedule_weekday_check" CHECK ("professional_schedule"."weekday" between 0 and 6),
	CONSTRAINT "professional_schedule_range_check" CHECK ("professional_schedule"."start_min" >= 0 and "professional_schedule"."end_min" <= 1440 and "professional_schedule"."end_min" > "professional_schedule"."start_min")
);--> statement-breakpoint
CREATE TABLE "schedule_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"professional_user_id" text,
	"room_id" uuid,
	"kind" text DEFAULT 'bloqueo' NOT NULL,
	"reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_block_range_check" CHECK ("schedule_block"."ends_at" > "schedule_block"."starts_at"),
	CONSTRAINT "schedule_block_kind_check" CHECK ("schedule_block"."kind" in ('bloqueo','ausencia'))
);--> statement-breakpoint
CREATE TABLE "clinical_form_addendum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"response_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
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
	"template_title" text,
	"source" text DEFAULT 'staff' NOT NULL,
	"respondent_contact_id" uuid,
	"submitted_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"discarded_by" text,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_form_response_status_check" CHECK ("clinical_form_response"."status" in ('borrador','finalizado','descartado')),
	CONSTRAINT "clinical_form_response_source_check" CHECK ("clinical_form_response"."source" in ('staff','portal'))
);--> statement-breakpoint
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
	"respondent" text DEFAULT 'staff' NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_form_template_status_check" CHECK ("clinical_form_template"."status" in ('borrador','publicado','archivado')),
	CONSTRAINT "clinical_form_template_version_check" CHECK ("clinical_form_template"."version" >= 1),
	CONSTRAINT "clinical_form_template_respondent_check" CHECK ("clinical_form_template"."respondent" in ('staff','portal'))
);--> statement-breakpoint
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
	"diagnosis_system" text,
	"diagnosis_code" text,
	"result_document_id" uuid,
	"recipient_user_id" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_order_diagnosis_pair_check" CHECK (("clinical_order"."diagnosis_system" IS NULL) = ("clinical_order"."diagnosis_code" IS NULL)),
	CONSTRAINT "clinical_order_kind_check" CHECK ("clinical_order"."kind" in ('imagen','laboratorio','interconsulta')),
	CONSTRAINT "clinical_order_status_check" CHECK ("clinical_order"."status" in ('solicitado','en_proceso','completado','cancelado')),
	CONSTRAINT "clinical_order_cancel_check" CHECK (("clinical_order"."cancelled_at" IS NULL) = ("clinical_order"."cancel_reason" IS NULL) AND ("clinical_order"."cancelled_at" IS NULL OR "clinical_order"."status" = 'cancelado') AND ("clinical_order"."cancel_reason" IS NULL OR char_length("clinical_order"."cancel_reason") BETWEEN 1 AND 2000))
);--> statement-breakpoint
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
	"signer_contact_id" uuid,
	"signature_data" jsonb,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"author_user_id" text,
	"signed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"sections_snapshot" jsonb,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"informed_at" timestamp with time zone,
	"informed_by" text,
	"informer_name" text,
	"informer_title" text,
	"informer_registration" text,
	"professional_signature" jsonb,
	"comprehension_confirmed" boolean DEFAULT false NOT NULL,
	"witness_name" text,
	"witness_doc" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"revoker_name" text,
	"revoker_contact_id" uuid,
	"revoke_signature" jsonb,
	"pdf_document_id" uuid,
	"pdf_sha256" text,
	"revoke_pdf_document_id" uuid,
	"revoke_pdf_sha256" text,
	"declaration_snapshot" text,
	"signature_method" text,
	"signature_level" text,
	"paper_document_id" uuid,
	"link_sent_at" timestamp with time zone,
	"person_signed_at" timestamp with time zone,
	"person_signed_ip" text,
	"person_signed_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_document_diagnosis_pair_check" CHECK (("consent_document"."diagnosis_system" IS NULL) = ("consent_document"."diagnosis_code" IS NULL)),
	CONSTRAINT "consent_document_status_check" CHECK ("consent_document"."status" in ('pendiente','firmado','revocado','anulado')),
	CONSTRAINT "consent_document_signer_check" CHECK ("consent_document"."signer_kind" in ('paciente','representante')),
	CONSTRAINT "consent_document_signature_method_check" CHECK ("consent_document"."signature_method" IS NULL OR "consent_document"."signature_method" IN ('clinica','papel','enlace')),
	CONSTRAINT "consent_document_signature_level_check" CHECK ("consent_document"."signature_level" IS NULL OR "consent_document"."signature_level" IN ('simple')),
	CONSTRAINT "consent_document_paper_check" CHECK (CASE WHEN "consent_document"."signature_method" = 'papel' THEN "consent_document"."paper_document_id" IS NOT NULL ELSE "consent_document"."paper_document_id" IS NULL END)
);--> statement-breakpoint
CREATE TABLE "consent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "consent_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sections" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_template_status_check" CHECK ("consent_template"."status" in ('borrador','publicado','archivado')),
	CONSTRAINT "consent_template_version_check" CHECK ("consent_template"."version" >= 1)
);--> statement-breakpoint
CREATE TABLE "consent_template_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_key" text NOT NULL,
	"service_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_template_service_key_check" CHECK (char_length("consent_template_service"."template_key") BETWEEN 2 AND 40)
);--> statement-breakpoint
CREATE TABLE "medical_leave" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"leave_number" integer NOT NULL,
	"status" text DEFAULT 'emitido' NOT NULL,
	"starts_on" date NOT NULL,
	"days" integer NOT NULL,
	"ends_on" date NOT NULL,
	"show_diagnosis" boolean DEFAULT false NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"notes" text,
	"signer_name" text,
	"signer_title" text,
	"signer_registration" text,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medical_leave_diagnosis_pair_check" CHECK (("medical_leave"."diagnosis_system" IS NULL) = ("medical_leave"."diagnosis_code" IS NULL)),
	CONSTRAINT "medical_leave_status_check" CHECK ("medical_leave"."status" in ('emitido','anulado')),
	CONSTRAINT "medical_leave_days_check" CHECK ("medical_leave"."days" BETWEEN 1 AND 365),
	CONSTRAINT "medical_leave_dates_check" CHECK ("medical_leave"."ends_on" >= "medical_leave"."starts_on"),
	CONSTRAINT "medical_leave_diagnosis_check" CHECK ("medical_leave"."diagnosis_code" IS NULL OR "medical_leave"."show_diagnosis"),
	CONSTRAINT "medical_leave_cancel_check" CHECK (("medical_leave"."cancelled_at" IS NULL) = ("medical_leave"."cancel_reason" IS NULL) AND ("medical_leave"."cancelled_at" IS NULL) = ("medical_leave"."status" = 'emitido') AND ("medical_leave"."cancel_reason" IS NULL OR char_length("medical_leave"."cancel_reason") BETWEEN 1 AND 2000))
);--> statement-breakpoint
CREATE TABLE "org_specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "professional_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"signature_name" text,
	"professional_title" text NOT NULL,
	"registration_body" text NOT NULL,
	"registration_number" text,
	"specialty_registration" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_profile_lengths_check" CHECK (length("professional_profile"."professional_title") between 1 and 120 and length("professional_profile"."registration_body") between 1 and 40 and ("professional_profile"."registration_number" is null or length("professional_profile"."registration_number") between 1 and 20) and ("professional_profile"."signature_name" is null or length("professional_profile"."signature_name") between 1 and 200) and ("professional_profile"."specialty_registration" is null or length("professional_profile"."specialty_registration") between 1 and 40))
);--> statement-breakpoint
CREATE TABLE "professional_specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"specialty_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "appointment_plan_item" (
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_plan_item_appointment_id_plan_item_id_pk" PRIMARY KEY("appointment_id","plan_item_id")
);--> statement-breakpoint
CREATE TABLE "clinical_access_log" (
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"resource" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "clinical_access_log_pkey" PRIMARY KEY("organization_id","patient_id","bucket","user_id","resource")
);--> statement-breakpoint
CREATE TABLE "clinical_follow_up" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"encounter_procedure_id" uuid,
	"origin_encounter_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"appointment_id" uuid,
	"legacy_scheduled_at" timestamp with time zone,
	"completed_encounter_id" uuid,
	"outcome" text,
	"cancelled_reason" text,
	"repeat_every_months" smallint,
	"repeats_from_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "clinical_follow_up_repeat_check" CHECK ("clinical_follow_up"."repeat_every_months" IS NULL OR "clinical_follow_up"."repeat_every_months" IN (1, 3, 6, 12)),
	CONSTRAINT "clinical_follow_up_reservation_check" CHECK ("clinical_follow_up"."status" <> 'programado' OR "clinical_follow_up"."appointment_id" IS NOT NULL),
	CONSTRAINT "clinical_follow_up_kind_check" CHECK ("clinical_follow_up"."kind" IN ('tratamiento','mantenimiento')),
	CONSTRAINT "clinical_follow_up_status_check" CHECK ("clinical_follow_up"."status" IN ('pendiente','programado','realizado','cancelado')),
	CONSTRAINT "clinical_follow_up_treatment_check" CHECK ("clinical_follow_up"."kind" <> 'tratamiento' OR "clinical_follow_up"."plan_item_id" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "clinical_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"note" text NOT NULL,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"encounter_id" uuid,
	"kind" text DEFAULT 'evolucion' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_note_kind_check" CHECK ("clinical_note"."kind" IN ('evolucion','adenda'))
);--> statement-breakpoint
CREATE TABLE "catalog"."diagnosis_code" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"edition" text NOT NULL,
	"title" text NOT NULL,
	"uri" text,
	"is_category" boolean DEFAULT false NOT NULL,
	"search_text" text NOT NULL,
	CONSTRAINT "diagnosis_code_system_key_code_pk" PRIMARY KEY("system_key","code")
);--> statement-breakpoint
CREATE TABLE "catalog"."diagnosis_code_release" (
	"system_key" text NOT NULL,
	"edition" text NOT NULL,
	"official" boolean NOT NULL,
	"license" text NOT NULL,
	"source_url" text,
	"source_sha256" text,
	"code_count" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_code_release_system_key_edition_pk" PRIMARY KEY("system_key","edition"),
	CONSTRAINT "diagnosis_code_release_sha_check" CHECK ("catalog"."diagnosis_code_release"."source_sha256" IS NULL OR "catalog"."diagnosis_code_release"."source_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "catalog"."diagnosis_code_system" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"country" char(2),
	"uri" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"branch_id" uuid,
	"professional_user_id" text NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"appointment_id" uuid,
	"reason" text,
	"present_illness" text,
	"illness_duration" text,
	"vitals" jsonb,
	"evolution" text,
	"indications" text,
	"prognosis" text,
	"examination" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	"signer_name" text,
	"signer_title" text,
	"signer_registration" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"consent_skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_status_check" CHECK ("encounter"."status" IN ('borrador','finalizada','anulada')),
	CONSTRAINT "encounter_void_check" CHECK (("encounter"."status" = 'anulada') = ("encounter"."voided_at" IS NOT NULL) AND ("encounter"."voided_at" IS NULL) = ("encounter"."void_reason" IS NULL)),
	CONSTRAINT "encounter_end_check" CHECK ("encounter"."ended_at" IS NULL OR "encounter"."ended_at" >= "encounter"."started_at"),
	CONSTRAINT "encounter_consent_skip_reason_check" CHECK ("encounter"."consent_skip_reason" IS NULL OR char_length("encounter"."consent_skip_reason") BETWEEN 1 AND 2000)
);--> statement-breakpoint
CREATE TABLE "encounter_diagnosis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"diagnosis_system" text NOT NULL,
	"diagnosis_code" text NOT NULL,
	"diagnosis_type" text,
	"previously_diagnosed" boolean DEFAULT false NOT NULL,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"status" text DEFAULT 'activo' NOT NULL,
	"resolved_at" timestamp with time zone,
	"legacy_note_id" uuid,
	"created_by" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_diagnosis_type_check" CHECK (("encounter_diagnosis"."diagnosis_type" IS NULL AND "encounter_diagnosis"."legacy_note_id" IS NOT NULL) OR "encounter_diagnosis"."diagnosis_type" IN ('provisional','confirmed')),
	CONSTRAINT "encounter_diagnosis_diagnosis_pair_check" CHECK (("encounter_diagnosis"."diagnosis_system" IS NULL) = ("encounter_diagnosis"."diagnosis_code" IS NULL)),
	CONSTRAINT "encounter_diagnosis_status_check" CHECK ("encounter_diagnosis"."status" IN ('activo','resuelto')),
	CONSTRAINT "encounter_diagnosis_void_check" CHECK (("encounter_diagnosis"."voided_at" IS NULL) = ("encounter_diagnosis"."void_reason" IS NULL)),
	CONSTRAINT "encounter_diagnosis_origin_check" CHECK ("encounter_diagnosis"."encounter_id" IS NOT NULL OR "encounter_diagnosis"."legacy_note_id" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "encounter_dictation_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"professional_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'lista' NOT NULL,
	"note" text,
	"entity_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_dictation_suggestion_kind_check" CHECK ("encounter_dictation_suggestion"."kind" IN ('nota','diagnostico','plan','control','odontograma','receta','signos','examen','descanso')),
	CONSTRAINT "encounter_dictation_suggestion_status_check" CHECK ("encounter_dictation_suggestion"."status" IN ('lista','por_revisar','confirmada','descartada'))
);--> statement-breakpoint
CREATE TABLE "encounter_plan_item" (
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_plan_item_encounter_id_plan_item_id_pk" PRIMARY KEY("encounter_id","plan_item_id")
);--> statement-breakpoint
CREATE TABLE "encounter_procedure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"service_id" uuid,
	"scope" text,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"description" text NOT NULL,
	"quantity" smallint DEFAULT 1 NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"plan_item_id" uuid,
	"price_cents" integer,
	"currency" char(3),
	"codings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "encounter_procedure_diagnosis_pair_check" CHECK (("encounter_procedure"."diagnosis_system" IS NULL) = ("encounter_procedure"."diagnosis_code" IS NULL)),
	CONSTRAINT "encounter_procedure_quantity_check" CHECK ("encounter_procedure"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "encounter_procedure_void_check" CHECK (("encounter_procedure"."voided_at" IS NULL) = ("encounter_procedure"."void_reason" IS NULL)),
	CONSTRAINT "encounter_procedure_price_check" CHECK ("encounter_procedure"."price_cents" IS NULL OR "encounter_procedure"."price_cents" >= 0),
	CONSTRAINT "encounter_procedure_price_currency_check" CHECK (("encounter_procedure"."price_cents" IS NULL) = ("encounter_procedure"."currency" IS NULL))
);--> statement-breakpoint
CREATE TABLE "encounter_site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"site_system" text NOT NULL,
	"site_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "imaging_measurement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"view" text NOT NULL,
	"points" jsonb NOT NULL,
	"value" real NOT NULL,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	CONSTRAINT "imaging_measurement_kind_check" CHECK ("imaging_measurement"."kind" IN ('distancia','angulo')),
	CONSTRAINT "imaging_measurement_view_check" CHECK ("imaging_measurement"."view" IN ('panoramica','transversal','axial','coronal','sagital')),
	CONSTRAINT "imaging_measurement_value_check" CHECK ("imaging_measurement"."value" >= 0 AND ("imaging_measurement"."kind" <> 'angulo' OR "imaging_measurement"."value" <= 180)),
	CONSTRAINT "imaging_measurement_retired_check" CHECK (("imaging_measurement"."retired_at" IS NULL) = ("imaging_measurement"."retired_by" IS NULL))
);--> statement-breakpoint
CREATE TABLE "imaging_study" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"study_instance_uid" text NOT NULL,
	"dicom_patient_name" text,
	"modality" text,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"slice_count" integer NOT NULL,
	"voxel_mm" real,
	"thumbnail_key" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_study_file_count_check" CHECK ("imaging_study"."file_count" BETWEEN 1 AND 5000),
	CONSTRAINT "imaging_study_total_bytes_check" CHECK ("imaging_study"."total_bytes" BETWEEN 1 AND 1073741824),
	CONSTRAINT "imaging_study_slice_count_check" CHECK ("imaging_study"."slice_count" BETWEEN 1 AND 20000),
	CONSTRAINT "imaging_study_uid_check" CHECK (char_length("imaging_study"."study_instance_uid") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE TABLE "imaging_study_file" (
	"organization_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"file_index" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sop_instance_uid" text NOT NULL,
	"series_instance_uid" text NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "imaging_study_file_document_id_file_index_pk" PRIMARY KEY("document_id","file_index"),
	CONSTRAINT "imaging_study_file_size_check" CHECK ("imaging_study_file"."size_bytes" BETWEEN 1 AND 1073741824)
);--> statement-breakpoint
CREATE TABLE "org_counter" (
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "org_counter_organization_id_key_pk" PRIMARY KEY("organization_id","key")
);--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"person_id" uuid NOT NULL,
	"blood_group" text,
	"patient_number" integer NOT NULL,
	"nationality" char(2),
	"avatar_storage_key" text,
	"birth_country" char(2),
	"birth_place" text,
	"address_reference" text,
	"insurer_name" text,
	"affiliation_number" text,
	"asa_class" text,
	"marital_status" text,
	"education_level" text,
	"occupation" text,
	"address" text,
	"address_city" text,
	"address_district" text,
	"address_region" text,
	"address_postal_code" text,
	"address_country" char(2),
	"origin" text,
	"insurance_type" text,
	"insurance_scheme" text,
	"referral_kind" text,
	"referral_source" text,
	"registered_branch_id" uuid,
	"health_revision" integer DEFAULT 0 NOT NULL,
	"health_review_status" jsonb DEFAULT '{"allergies":"unknown","conditions":"unknown","medications":"unknown"}'::jsonb NOT NULL,
	"health_reviewed_at" timestamp with time zone,
	"health_reviewed_by" text,
	"allergies_reviewed_at" timestamp with time zone,
	"allergies_reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_blood_group_check" CHECK ("patient"."blood_group" IS NULL OR "patient"."blood_group" IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
	CONSTRAINT "patient_insurance_type_check" CHECK ("patient"."insurance_type" IS NULL OR "patient"."insurance_type" IN ('PUBLICO','PRIVADO','PARTICULAR','OTRO')),
	CONSTRAINT "patient_insurance_scheme_check" CHECK ("patient"."insurance_scheme" IS NULL OR ("patient"."insurance_type" IS NOT NULL AND char_length("patient"."insurance_scheme") BETWEEN 1 AND 20)),
	CONSTRAINT "patient_address_lengths_check" CHECK (("patient"."address_city" IS NULL OR char_length("patient"."address_city") BETWEEN 1 AND 100) AND ("patient"."address_district" IS NULL OR char_length("patient"."address_district") BETWEEN 1 AND 100) AND ("patient"."address_region" IS NULL OR char_length("patient"."address_region") BETWEEN 1 AND 100) AND ("patient"."address_postal_code" IS NULL OR char_length("patient"."address_postal_code") BETWEEN 1 AND 20) AND ("patient"."birth_place" IS NULL OR char_length("patient"."birth_place") BETWEEN 1 AND 200)),
	CONSTRAINT "patient_marital_status_check" CHECK ("patient"."marital_status" IS NULL OR "patient"."marital_status" IN ('S','M','T','L','D','W') OR "patient"."marital_status" ~ '^[A-Z]{2}:[a-z_]{1,40}$'),
	CONSTRAINT "patient_education_level_check" CHECK ("patient"."education_level" IS NULL OR "patient"."education_level" IN ('0','1','2','3','4','5','6','7','8')),
	CONSTRAINT "patient_referral_kind_check" CHECK ("patient"."referral_kind" IS NULL OR "patient"."referral_kind" IN ('recomendacion','redes_sociales','google_mapas','paso_por_aqui','convenio','otro')),
	CONSTRAINT "patient_referral_source_check" CHECK ("patient"."referral_source" IS NULL OR "patient"."referral_kind" = 'otro'),
	CONSTRAINT "patient_asa_class_check" CHECK ("patient"."asa_class" IS NULL OR "patient"."asa_class" IN ('I','II','III','IV','V','VI'))
);--> statement-breakpoint
CREATE TABLE "patient_allergy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"substance" text NOT NULL,
	"substance_system" text,
	"substance_code" text,
	"category" text,
	"reaction" text,
	"severity" text NOT NULL,
	"kind" text DEFAULT 'alergia' NOT NULL,
	"criticality" text,
	"verification" text DEFAULT 'no_confirmada' NOT NULL,
	"source" text DEFAULT 'equipo' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"removed_reason" text,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_allergy_substance_system_check" CHECK ("patient_allergy"."substance_system" IS NULL OR "patient_allergy"."substance_system" IN ('atc','odentia')),
	CONSTRAINT "patient_allergy_substance_code_check" CHECK (("patient_allergy"."substance_system" IS NULL) = ("patient_allergy"."substance_code" IS NULL)),
	CONSTRAINT "patient_allergy_source_check" CHECK ("patient_allergy"."source" IN ('equipo','paciente')),
	CONSTRAINT "patient_allergy_removed_reason_check" CHECK ("patient_allergy"."removed_reason" IS NULL OR "patient_allergy"."removed_reason" IN ('ya_no','otra_cosa','error')),
	CONSTRAINT "patient_allergy_removed_check" CHECK (NOT ("patient_allergy"."is_active" AND "patient_allergy"."removed_reason" IS NOT NULL)),
	CONSTRAINT "patient_allergy_severity_check" CHECK ("patient_allergy"."severity" IN ('leve','moderada','severa','desconocida')),
	CONSTRAINT "patient_allergy_kind_check" CHECK ("patient_allergy"."kind" IN ('alergia','intolerancia')),
	CONSTRAINT "patient_allergy_criticality_check" CHECK ("patient_allergy"."criticality" IS NULL OR "patient_allergy"."criticality" IN ('baja','alta','no_evaluable')),
	CONSTRAINT "patient_allergy_verification_check" CHECK ("patient_allergy"."verification" IN ('no_confirmada','confirmada','descartada')),
	CONSTRAINT "patient_allergy_category_check" CHECK ("patient_allergy"."category" IS NULL OR "patient_allergy"."category" IN ('medicamento','anestesico','material','alimento','ambiental','otro'))
);--> statement-breakpoint
CREATE TABLE "patient_anamnesis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "patient_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"budget_item_id" uuid,
	"encounter_procedure_id" uuid,
	"branch_id" uuid,
	"promotion_id" text,
	"promotion_name" text,
	"edit_reason" text,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"due_at" timestamp with time zone,
	"notes" text,
	"product_id" uuid,
	"product_quantity" integer,
	"request_key" text,
	"original_charge_id" uuid,
	"returned_cents" integer DEFAULT 0 NOT NULL,
	"tax_category" text,
	"tax_bps" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "patient_charge_returned_check" CHECK ("patient_charge"."returned_cents" >= 0),
	CONSTRAINT "patient_charge_amount_check" CHECK ("patient_charge"."amount_cents" > 0),
	CONSTRAINT "patient_charge_tax_check" CHECK (("patient_charge"."tax_category" IS NULL) = ("patient_charge"."tax_bps" IS NULL) AND ("patient_charge"."tax_category" IS NULL OR ("patient_charge"."tax_category" = 'S' AND "patient_charge"."tax_bps" BETWEEN 1 AND 5000) OR ("patient_charge"."tax_category" IN ('E','O','Z') AND "patient_charge"."tax_bps" = 0))),
	CONSTRAINT "patient_charge_product_check" CHECK (("patient_charge"."product_id" IS NULL) = ("patient_charge"."product_quantity" IS NULL) AND ("patient_charge"."product_quantity" IS NULL OR "patient_charge"."product_quantity" BETWEEN 1 AND 9999))
);--> statement-breakpoint
CREATE TABLE "patient_condition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"status" text DEFAULT 'activa' NOT NULL,
	"start_date" date,
	"end_date" date,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_condition_diagnosis_pair_check" CHECK (("patient_condition"."diagnosis_system" IS NULL) = ("patient_condition"."diagnosis_code" IS NULL)),
	CONSTRAINT "patient_condition_status_check" CHECK ("patient_condition"."status" IN ('activa','resuelta','inactiva'))
);--> statement-breakpoint
CREATE TABLE "patient_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"relationship_detail" text,
	"kinship" text,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contact_relationship_check" CHECK ("patient_contact"."relationship" IN ('self','guardian','family','other')),
	CONSTRAINT "patient_contact_detail_check" CHECK (length("patient_contact"."relationship_detail") <= 100),
	CONSTRAINT "patient_contact_emergency_check" CHECK (NOT ("patient_contact"."is_emergency" AND "patient_contact"."relationship" = 'self')),
	CONSTRAINT "patient_contact_kinship_check" CHECK ("patient_contact"."kinship" IS NULL OR "patient_contact"."kinship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB','FRND','NBOR'))
);--> statement-breakpoint
CREATE TABLE "patient_data_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"notice_version" integer NOT NULL,
	"notice_text" text NOT NULL,
	"purposes" text[] NOT NULL,
	"granted_by_contact_id" uuid,
	"granted_by_name" text NOT NULL,
	"channel" text NOT NULL,
	"recorded_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	CONSTRAINT "patient_data_consent_channel_check" CHECK ("patient_data_consent"."channel" IN ('presencial','formulario_publico','portal')),
	CONSTRAINT "patient_data_consent_revoke_check" CHECK (("patient_data_consent"."revoked_at" IS NULL) = ("patient_data_consent"."revoke_reason" IS NULL))
);--> statement-breakpoint
CREATE TABLE "patient_data_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requester_contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"requested_on" date NOT NULL,
	"due_on" date NOT NULL,
	"said" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"verified_how" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_data_request_kind_check" CHECK ("patient_data_request"."kind" IN ('copia','corregir','mensajes','borrar')),
	CONSTRAINT "patient_data_request_channel_check" CHECK ("patient_data_request"."channel" IN ('clinica','whatsapp','correo','portal')),
	CONSTRAINT "patient_data_request_status_check" CHECK ("patient_data_request"."status" IN ('pendiente','respondida','denegada')),
	CONSTRAINT "patient_data_request_verified_check" CHECK ("patient_data_request"."verified_how" IS NULL OR "patient_data_request"."verified_how" IN ('documento','portal','representante')),
	CONSTRAINT "patient_data_request_resolved_check" CHECK (("patient_data_request"."status" = 'pendiente') = ("patient_data_request"."resolved_at" IS NULL)),
	CONSTRAINT "patient_data_request_due_check" CHECK ("patient_data_request"."due_on" >= "patient_data_request"."requested_on")
);--> statement-breakpoint
CREATE TABLE "patient_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"image_type" text,
	"captured_at" timestamp with time zone,
	"source" text,
	"report_status" text,
	"thumbnail_key" text,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"retire_reason" text,
	CONSTRAINT "patient_document_image_type_check" CHECK ("patient_document"."image_type" IS NULL OR "patient_document"."category" IN ('radiografia','foto_clinica')),
	CONSTRAINT "patient_document_report_status_check" CHECK ("patient_document"."report_status" IS NULL OR "patient_document"."report_status" IN ('pendiente','informado','no_requiere')),
	CONSTRAINT "patient_document_source_check" CHECK ("patient_document"."source" IS NULL OR char_length("patient_document"."source") BETWEEN 1 AND 120),
	CONSTRAINT "patient_document_retired_check" CHECK (("patient_document"."retired_at" IS NULL) = ("patient_document"."retire_reason" IS NULL) AND ("patient_document"."retire_reason" IS NULL OR char_length("patient_document"."retire_reason") BETWEEN 1 AND 2000)),
	CONSTRAINT "patient_document_category_check" CHECK ("patient_document"."category" IN ('consentimiento','radiografia','foto_clinica','informe','otro'))
);--> statement-breakpoint
CREATE TABLE "patient_document_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"encounter_id" uuid,
	"plan_item_id" uuid,
	"budget_id" uuid,
	"encounter_procedure_id" uuid,
	"prescription_id" uuid,
	"follow_up_id" uuid,
	"payment_id" uuid,
	"site_system" text,
	"site_codes" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"author_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "patient_family_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"condition" text NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_family_history_relationship_check" CHECK ("patient_family_history"."relationship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB')),
	CONSTRAINT "patient_family_history_diagnosis_pair_check" CHECK (("patient_family_history"."diagnosis_system" IS NULL) = ("patient_family_history"."diagnosis_code" IS NULL))
);--> statement-breakpoint
CREATE TABLE "patient_medication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"atc_code" text,
	"dose" text,
	"dose_value" numeric(10, 3),
	"dose_unit" text,
	"frequency" text,
	"frequency_code" text,
	"start_date" date,
	"end_date" date,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_medication_dose_unit_check" CHECK ("patient_medication"."dose_unit" IS NULL OR "patient_medication"."dose_unit" IN ('mg','g','ug','mL','[iU]','{tbl}','{cap}','{drop}','{puff}')),
	CONSTRAINT "patient_medication_frequency_code_check" CHECK ("patient_medication"."frequency_code" IS NULL OR "patient_medication"."frequency_code" IN ('cada_8_h','cada_12_h','cada_24_h','segun_necesidad')),
	CONSTRAINT "patient_medication_dose_check" CHECK (("patient_medication"."dose_value" IS NULL) = ("patient_medication"."dose_unit" IS NULL) AND ("patient_medication"."dose_value" IS NULL OR "patient_medication"."dose_value" > 0))
);--> statement-breakpoint
CREATE TABLE "patient_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"ticket_id" uuid,
	"branch_id" uuid,
	"payment_method_id" uuid,
	"method_name" text NOT NULL,
	"method_type_code" text,
	"payer_contact_id" uuid,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "patient_payment_amount_check" CHECK ("patient_payment"."amount_cents" > 0),
	CONSTRAINT "patient_payment_tax_check" CHECK ("patient_payment"."tax_cents" BETWEEN 0 AND "patient_payment"."amount_cents"),
	CONSTRAINT "patient_payment_method_type_check" CHECK ("patient_payment"."method_type_code" IS NULL OR "patient_payment"."method_type_code" IN ('10','48','30','68','20','1'))
);--> statement-breakpoint
CREATE TABLE "patient_payment_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"ticket_id" uuid,
	"replaces_application_id" uuid,
	"return_id" uuid,
	"amount_cents" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "payment_application_amount_check" CHECK ("patient_payment_application"."amount_cents" > 0)
);--> statement-breakpoint
CREATE TABLE "patient_payment_refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"refunded_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"return_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_amount_check" CHECK ("patient_payment_refund"."amount_cents" > 0),
	CONSTRAINT "payment_refund_tax_check" CHECK ("patient_payment_refund"."tax_cents" BETWEEN 0 AND "patient_payment_refund"."amount_cents")
);--> statement-breakpoint
CREATE TABLE "patient_record_opening" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_record_opening_reason_check" CHECK ("patient_record_opening"."reason" IN ('autoridad','reclamo','otro')),
	CONSTRAINT "patient_record_opening_note_check" CHECK ("patient_record_opening"."reason" <> 'otro' OR "patient_record_opening"."note" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "patient_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"submission_id" uuid,
	"payload_hash" text,
	"entry_point" text NOT NULL,
	"respondent" text,
	"actor_user_id" text,
	"context_contact_id" uuid,
	"conversation_id" uuid,
	"link_id" uuid,
	"form_version" integer,
	"answers" jsonb NOT NULL,
	"privacy_notice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_registration_entry_check" CHECK ("patient_registration"."entry_point" IN ('platform','public_link','qr','conversation','legacy')),
	CONSTRAINT "patient_registration_respondent_check" CHECK ("patient_registration"."respondent" IS NULL OR "patient_registration"."respondent" IN ('patient','representative','staff'))
);--> statement-breakpoint
CREATE TABLE "patient_registration_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "patient_responsibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date,
	"evidence_document_id" uuid,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	CONSTRAINT "patient_responsibility_kind_check" CHECK ("patient_responsibility"."kind" IN ('representante_legal','autorizado_informacion','responsable_economico')),
	CONSTRAINT "patient_responsibility_dates_check" CHECK ("patient_responsibility"."ends_at" IS NULL OR "patient_responsibility"."ends_at" >= "patient_responsibility"."starts_at")
);--> statement-breakpoint
CREATE TABLE "payment_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"return_number" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" integer NOT NULL,
	"outcome" text NOT NULL,
	"payment_method_id" uuid,
	"method_name" text,
	"method_type_code" text,
	"reason" text NOT NULL,
	"request_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_return_total_check" CHECK ("payment_return"."total_cents" > 0),
	CONSTRAINT "payment_return_outcome_check" CHECK ("payment_return"."outcome" IN ('pagado','a_favor')),
	CONSTRAINT "payment_return_method_check" CHECK (("payment_return"."outcome" = 'pagado') = ("payment_return"."method_name" IS NOT NULL) AND ("payment_return"."method_type_code" IS NULL OR "payment_return"."method_type_code" IN ('10','48','30','68','20','1')))
);--> statement-breakpoint
CREATE TABLE "payment_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"ticket_number" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" integer NOT NULL,
	"credit_applied_cents" integer DEFAULT 0 NOT NULL,
	"cash_received_cents" integer,
	"change_cents" integer,
	"payer_contact_id" uuid,
	"request_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "payment_ticket_total_check" CHECK ("payment_ticket"."total_cents" >= 0)
);--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"plan_item_id" uuid,
	"prescription_number" integer NOT NULL,
	"status" text DEFAULT 'emitida' NOT NULL,
	"notes" text,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"valid_until" date,
	"allergy_override_reason" text,
	"patient_weight_kg" numeric(5, 1),
	"prescriber_name" text,
	"prescriber_title" text,
	"prescriber_registration" text,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_diagnosis_pair_check" CHECK (("prescription"."diagnosis_system" IS NULL) = ("prescription"."diagnosis_code" IS NULL)),
	CONSTRAINT "prescription_status_check" CHECK ("prescription"."status" IN ('emitida','anulada')),
	CONSTRAINT "prescription_patient_weight_check" CHECK ("prescription"."patient_weight_kg" IS NULL OR "prescription"."patient_weight_kg" BETWEEN 0.5 AND 400)
);--> statement-breakpoint
CREATE TABLE "prescription_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"medication_name" text NOT NULL,
	"generic_name" text,
	"brand_name" text,
	"strength" text,
	"dosage_form" text,
	"atc_code" text,
	"dose" text NOT NULL,
	"route" text NOT NULL,
	"frequency" text NOT NULL,
	"duration" text NOT NULL,
	"quantity" integer,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_item_quantity_check" CHECK ("prescription_item"."quantity" IS NULL OR "prescription_item"."quantity" > 0)
);--> statement-breakpoint
CREATE TABLE "catalog"."procedure_catalog_release" (
	"system_key" text NOT NULL,
	"version" text NOT NULL,
	"scope" text NOT NULL,
	"source_url" text NOT NULL,
	"source_sha256" text NOT NULL,
	"expected_count" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	CONSTRAINT "procedure_catalog_release_system_key_version_pk" PRIMARY KEY("system_key","version")
);--> statement-breakpoint
CREATE TABLE "catalog"."procedure_code" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"version" text NOT NULL,
	"display" text NOT NULL,
	"section" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"replaced_by" text,
	CONSTRAINT "procedure_code_system_key_code_version_pk" PRIMARY KEY("system_key","code","version")
);--> statement-breakpoint
CREATE TABLE "catalog"."procedure_code_product" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"product" text NOT NULL,
	CONSTRAINT "procedure_code_product_system_key_product_code_pk" PRIMARY KEY("system_key","product","code")
);--> statement-breakpoint
CREATE TABLE "catalog"."procedure_code_system" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"country" char(2),
	"license" text NOT NULL,
	"source_url" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "service_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" uuid,
	"source" text DEFAULT 'custom' NOT NULL,
	"code" text,
	"procedure_system" text,
	"procedure_code" text,
	"procedure_version" text,
	"name" text NOT NULL,
	"specialty_id" uuid,
	"scope" text,
	"price_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"duration_min" integer,
	"billing_mode" text DEFAULT 'treatment' NOT NULL,
	"price_disclosure" text DEFAULT 'evaluacion' NOT NULL,
	"evaluation_service_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_catalog_procedure_check" CHECK (("service_catalog"."procedure_system" IS NULL) = ("service_catalog"."procedure_code" IS NULL) AND ("service_catalog"."procedure_code" IS NULL) = ("service_catalog"."procedure_version" IS NULL) AND ("service_catalog"."procedure_code" IS NULL OR "service_catalog"."template_id" IS NULL)),
	CONSTRAINT "service_catalog_price_check" CHECK ("service_catalog"."price_cents" >= 0),
	CONSTRAINT "service_catalog_billing_mode_check" CHECK ("service_catalog"."billing_mode" IN ('treatment','session')),
	CONSTRAINT "service_catalog_price_disclosure_check" CHECK ("service_catalog"."price_disclosure" IN ('exacto','desde','evaluacion'))
);--> statement-breakpoint
CREATE TABLE "ticket_counter" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"next_return_number" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE "treatment_budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"budget_number" integer NOT NULL,
	"revision_number" integer DEFAULT 1 NOT NULL,
	"supersedes_budget_id" uuid,
	"presented_at" timestamp with time zone,
	"decision_contact_id" uuid,
	"title" text NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"notes" text,
	"accepted_by_name" text,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_budget_status_check" CHECK ("treatment_budget"."status" IN ('borrador','presentado','aceptado','parcial','rechazado','pospuesto','cancelado','sustituido')),
	CONSTRAINT "treatment_budget_revision_check" CHECK ("treatment_budget"."revision_number" > 0)
);--> statement-breakpoint
CREATE TABLE "treatment_budget_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"service_id" uuid,
	"title" text NOT NULL,
	"scope" text,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"codings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_cents" integer,
	"tariff_price_cents" integer,
	"price_reason" text,
	"promotion_id" uuid,
	"promotion_name" text,
	"promotion_mode" text,
	"billing_mode" text DEFAULT 'treatment' NOT NULL,
	"sessions_planned" smallint,
	"currency" char(3) NOT NULL,
	"decision" text DEFAULT 'pendiente' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_budget_item_billing_mode_check" CHECK ("treatment_budget_item"."billing_mode" IN ('treatment','session')),
	CONSTRAINT "treatment_budget_item_promotion_mode_check" CHECK ("treatment_budget_item"."promotion_mode" IS NULL OR "treatment_budget_item"."promotion_mode" IN ('fixed','from')),
	CONSTRAINT "treatment_budget_item_promotion_check" CHECK (("treatment_budget_item"."promotion_id" IS NULL) = ("treatment_budget_item"."promotion_name" IS NULL))
);--> statement-breakpoint
CREATE TABLE "treatment_budget_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"decision" text DEFAULT 'pendiente' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_budget_option_position_check" CHECK ("treatment_budget_option"."position" BETWEEN 1 AND 3),
	CONSTRAINT "treatment_budget_option_decision_check" CHECK ("treatment_budget_option"."decision" IN ('pendiente','elegida','no_elegida'))
);--> statement-breakpoint
CREATE TABLE "treatment_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin_encounter_id" uuid,
	"is_legacy" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "treatment_plan_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"service_id" uuid,
	"budget_id" uuid,
	"supersedes_item_id" uuid,
	"decision_status" text DEFAULT 'pendiente' NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"decided_by_contact_id" uuid,
	"decided_by_name" text,
	"status_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"scope" text,
	"site_system" text,
	"site_code" text,
	"site_qualifiers" text[] DEFAULT '{}' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"codings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_cents" integer,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"phase" text DEFAULT 'basica' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"planned_sessions" smallint DEFAULT 1 NOT NULL,
	"source_encounter_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_plan_item_diagnosis_pair_check" CHECK (("treatment_plan_item"."diagnosis_system" IS NULL) = ("treatment_plan_item"."diagnosis_code" IS NULL)),
	CONSTRAINT "treatment_plan_item_planned_sessions_check" CHECK ("treatment_plan_item"."planned_sessions" BETWEEN 1 AND 60),
	CONSTRAINT "treatment_plan_item_status_check" CHECK ("treatment_plan_item"."status" IN ('pendiente','programado','en_curso','suspendido','realizado','cancelado','reemplazado')),
	CONSTRAINT "treatment_plan_item_decision_status_check" CHECK ("treatment_plan_item"."decision_status" IN ('pendiente','aceptado','pospuesto','rechazado','reemplazado','no_elegida'))
);--> statement-breakpoint
CREATE TABLE "catalog"."treatment_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"specialty" text NOT NULL,
	"scope" text NOT NULL,
	"product" text DEFAULT 'dental' NOT NULL,
	"is_common" boolean DEFAULT false NOT NULL,
	"coded_only" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "treatment_template_product_check" CHECK ("catalog"."treatment_template"."product" IN ('dental','medical'))
);--> statement-breakpoint
CREATE TABLE "catalog"."treatment_template_code" (
	"template_id" uuid NOT NULL,
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "treatment_template_code_template_id_system_key_code_version_pk" PRIMARY KEY("template_id","system_key","code","version")
);--> statement-breakpoint
CREATE TABLE "admin"."consumer_complaint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'recibido' NOT NULL,
	"consumer_name" text NOT NULL,
	"consumer_address" text NOT NULL,
	"document_type" text NOT NULL,
	"document_number" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"is_minor" boolean DEFAULT false NOT NULL,
	"guardian_name" text,
	"item_type" text NOT NULL,
	"item_description" text NOT NULL,
	"amount_minor" bigint,
	"amount_currency" text,
	"detail" text NOT NULL,
	"request" text NOT NULL,
	"provider_response" text,
	"responded_at" timestamp with time zone,
	"responded_by_user_id" text,
	"response_email_sent" boolean DEFAULT false NOT NULL,
	"privacy_accepted_at" timestamp with time zone NOT NULL,
	"email_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_complaint_number_unique" UNIQUE("number"),
	CONSTRAINT "consumer_complaint_submission_unique" UNIQUE("submission_id")
);--> statement-breakpoint
CREATE TABLE "admin"."consumer_complaint_counter" (
	"year" integer PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE "crm_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"opportunity_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "agent_config" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"decision_provider" text DEFAULT 'jev' NOT NULL,
	"decision_routing_enabled" boolean DEFAULT true NOT NULL,
	"advisor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"writing_hours" jsonb DEFAULT '[[],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,840]]]'::jsonb NOT NULL,
	"clinical_assistant_enabled" boolean DEFAULT false NOT NULL,
	"handoff_keywords" text[] DEFAULT '{}' NOT NULL,
	"max_turns" integer DEFAULT 10 NOT NULL,
	"reply_check_enabled" boolean DEFAULT true NOT NULL,
	"persona_name" text,
	"treatment" text,
	"tone" text DEFAULT 'cercano' NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"emojis" text DEFAULT 'no' NOT NULL,
	"disabled_functions" text[] DEFAULT '{}' NOT NULL,
	"function_notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"close_after_hours" integer DEFAULT 22 NOT NULL,
	"sandbox_turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_config_close_after_hours_check" CHECK ("agent_config"."close_after_hours" between 6 and 23),
	CONSTRAINT "agent_config_writing_hours_check" CHECK (jsonb_typeof("agent_config"."writing_hours") = 'array' and jsonb_array_length("agent_config"."writing_hours") = 7),
	CONSTRAINT "agent_config_decision_provider_check" CHECK ("agent_config"."decision_provider" in ('none','baseline','jev')),
	CONSTRAINT "agent_config_treatment_check" CHECK ("agent_config"."treatment" is null or "agent_config"."treatment" in ('tu','usted')),
	CONSTRAINT "agent_config_tone_check" CHECK ("agent_config"."tone" in ('cercano','neutro','formal')),
	CONSTRAINT "agent_config_emojis_check" CHECK ("agent_config"."emojis" in ('no','pocos'))
);--> statement-breakpoint
CREATE TABLE "channel_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"config_encrypted" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"polling_offset" text,
	"webhook_verified_at" timestamp with time zone,
	"health" jsonb,
	"account_external_id" text,
	"signup" jsonb,
	"templates_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "channel_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text DEFAULT 'utility' NOT NULL,
	"status" text DEFAULT 'en_revision' NOT NULL,
	"reason" text,
	"status_since" timestamp with time zone,
	"body" text DEFAULT '' NOT NULL,
	"variables" integer DEFAULT 0 NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"message_key" text,
	"requested_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"unsupported" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "clinic_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text,
	"title" text,
	"button_title" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"pending_version" integer,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_message_kind_check" CHECK (("clinic_message"."key" is null) <> ("clinic_message"."title" is null)),
	CONSTRAINT "clinic_message_catalog_check" CHECK ("clinic_message"."key" is null or ("clinic_message"."button_title" is null and "clinic_message"."archived_at" is null)),
	CONSTRAINT "clinic_message_version_check" CHECK ("clinic_message"."current_version" >= 0 and ("clinic_message"."pending_version" is null or "clinic_message"."pending_version" >= 0))
);--> statement-breakpoint
CREATE TABLE "clinic_message_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"body" text NOT NULL,
	"template_name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_message_version_number_check" CHECK ("clinic_message_version"."number" >= 1)
);--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"given_names" text,
	"family_name" text,
	"identity_needs_review" boolean DEFAULT false NOT NULL,
	"doc_country" char(2),
	"phone" text,
	"email" text,
	"preferred_channel" text,
	"doc_type" text,
	"doc_number" text,
	"birth_date" date,
	"sex" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"screen" text,
	"screened_at" timestamp with time zone,
	"screened_by_user_id" text,
	"screen_reason" text,
	"screen_note" text,
	"not_spam_at" timestamp with time zone,
	"not_spam_by_user_id" text,
	"record_locked_at" timestamp with time zone,
	"record_locked_by" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_preferred_channel_check" CHECK ("contact"."preferred_channel" IS NULL OR "contact"."preferred_channel" IN ('email','whatsapp','telegram','messenger','instagram')),
	CONSTRAINT "contact_sex_check" CHECK ("contact"."sex" IS NULL OR "contact"."sex" IN ('M','F','I','D')),
	CONSTRAINT "contact_screen_check" CHECK (("contact"."screen" IS NULL AND "contact"."screened_at" IS NULL AND "contact"."screened_by_user_id" IS NULL
        AND "contact"."screen_reason" IS NULL AND "contact"."screen_note" IS NULL)
      OR ("contact"."screen" = 'spam' AND "contact"."screened_at" IS NOT NULL
        AND "contact"."screen_reason" IN ('repeticion','publicidad','estafa','cadena','respuesta_automatica','venta','equipo'))
      OR ("contact"."screen" = 'blocked' AND "contact"."screened_at" IS NOT NULL AND "contact"."screened_by_user_id" IS NOT NULL
        AND "contact"."screen_reason" IN ('acoso','amenazas','estafa','otro') AND length(trim("contact"."screen_note")) > 0)),
	CONSTRAINT "contact_not_spam_check" CHECK (("contact"."not_spam_at" IS NULL) = ("contact"."not_spam_by_user_id" IS NULL)),
	CONSTRAINT "contact_record_locked_check" CHECK ("contact"."record_locked_at" IS NULL OR (NOT "contact"."is_active" AND "contact"."record_locked_by" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE "contact_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"no_whatsapp_at" timestamp with time zone,
	"provider_blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"contact_identity_id" uuid,
	"channel_connection_id" uuid NOT NULL,
	"external_thread_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" text,
	"agent_status" text DEFAULT 'on' NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	"close_reason" text,
	"attention_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nudged_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_status_check" CHECK ("conversation"."status" in ('open','closed')),
	CONSTRAINT "conversation_close_reason_check" CHECK ("conversation"."close_reason" is null or "conversation"."close_reason" in ('resuelta','sin_respuesta','equipo','manual')),
	CONSTRAINT "conversation_closed_coherence_check" CHECK (("conversation"."status" = 'open' and "conversation"."closed_at" is null and "conversation"."close_reason" is null and "conversation"."closed_by_user_id" is null)
        or ("conversation"."status" = 'closed' and "conversation"."closed_at" is not null and "conversation"."close_reason" is not null))
);--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"opportunity_id" uuid,
	"patient_id" uuid,
	"assignee_user_id" text,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"area" text,
	"reason" text,
	"settled_reason" text,
	"idempotency_key" text,
	"kind" text,
	"relationship_detail" text,
	"kinship" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_relationship_detail_check" CHECK (length("task"."relationship_detail") <= 100),
	CONSTRAINT "task_kinship_check" CHECK ("task"."kinship" IS NULL OR "task"."kinship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB','FRND','NBOR')),
	CONSTRAINT "task_relationship_kind_check" CHECK (("task"."relationship_detail" IS NULL AND "task"."kinship" IS NULL) OR "task"."kind" = 'confirmar_representante')
);--> statement-breakpoint
CREATE TABLE "custom_field_def" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "inbound_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender_kind" text NOT NULL,
	"sender_user_id" text,
	"content_type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"template_name" text,
	"template_language" text,
	"template_params" jsonb,
	"template_link" text,
	"reply_buttons" jsonb,
	"list_unsubscribe" text,
	"reply_to_message_id" uuid,
	"held" boolean DEFAULT false NOT NULL,
	"forwarded" boolean DEFAULT false NOT NULL,
	"contact_reaction" text,
	"contact_reaction_at" timestamp with time zone,
	"location" jsonb,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "pipeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "pipeline_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"moment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stage_moment_check" CHECK ("pipeline_stage"."moment" IN ('interesado','evaluacion_agendada','presupuesto_enviado','decidio'))
);--> statement-breakpoint
CREATE TABLE "registration_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"match" text NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_hold_match_check" CHECK ("registration_hold"."match" IN ('documento', 'celular'))
);--> statement-breakpoint
CREATE TABLE "catalog"."dental_template_rule" (
	"template_id" uuid PRIMARY KEY NOT NULL,
	"surface_count_min" integer,
	"surface_count_max" integer,
	"leaves_condition" text,
	"leaves_variant" text,
	CONSTRAINT "dental_template_rule_leaves_check" CHECK ("catalog"."dental_template_rule"."leaves_variant" IS NULL OR "catalog"."dental_template_rule"."leaves_condition" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "dental"."odontogram_assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"specifications" text NOT NULL,
	"observations" text NOT NULL,
	"examiner_name" text NOT NULL,
	"examiner_title" text NOT NULL,
	"registration_number" text NOT NULL,
	"patient_name" text NOT NULL,
	"patient_number" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"standard" text NOT NULL,
	"encounter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "dental"."odontogram_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"surface" text,
	"condition" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"legacy_data" jsonb,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_by_plan_item_id" uuid,
	"left_by_plan_item_id" uuid,
	"created_by" text,
	"encounter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odontogram_entry_diagnosis_pair_check" CHECK (("dental"."odontogram_entry"."diagnosis_system" IS NULL) = ("dental"."odontogram_entry"."diagnosis_code" IS NULL))
);--> statement-breakpoint
CREATE TABLE "dental"."periodontal_chart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"expected_teeth" smallint[] NOT NULL,
	"implant_teeth" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"diagnosis" text,
	"stage" smallint,
	"grade" text,
	"extent" text,
	"bone_loss_percent" smallint,
	"teeth_lost_to_periodontitis" smallint,
	"cigarettes_per_day" smallint,
	"diabetes" boolean,
	"hba1c" numeric(3, 1),
	"periodontitis_status" text,
	"classified_by" text,
	"classified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodontal_chart_diagnosis_check" CHECK ("dental"."periodontal_chart"."diagnosis" IS NULL OR "dental"."periodontal_chart"."diagnosis" IN ('health','gingivitis','periodontitis')),
	CONSTRAINT "periodontal_chart_stage_check" CHECK (("dental"."periodontal_chart"."diagnosis" = 'periodontitis') = ("dental"."periodontal_chart"."stage" IS NOT NULL AND "dental"."periodontal_chart"."grade" IS NOT NULL) AND ("dental"."periodontal_chart"."stage" IS NULL OR "dental"."periodontal_chart"."stage" BETWEEN 1 AND 4) AND ("dental"."periodontal_chart"."grade" IS NULL OR "dental"."periodontal_chart"."grade" IN ('A','B','C'))),
	CONSTRAINT "periodontal_chart_extent_check" CHECK (("dental"."periodontal_chart"."diagnosis" IS NULL OR "dental"."periodontal_chart"."diagnosis" = 'health') = ("dental"."periodontal_chart"."extent" IS NULL) AND ("dental"."periodontal_chart"."extent" IS NULL OR "dental"."periodontal_chart"."extent" IN ('localized','generalized') OR ("dental"."periodontal_chart"."diagnosis" = 'periodontitis' AND "dental"."periodontal_chart"."extent" = 'molar_incisor'))),
	CONSTRAINT "periodontal_chart_status_check" CHECK ("dental"."periodontal_chart"."periodontitis_status" IS NULL OR ("dental"."periodontal_chart"."diagnosis" = 'periodontitis' AND "dental"."periodontal_chart"."periodontitis_status" IN ('stable','remission','unstable'))),
	CONSTRAINT "periodontal_chart_classified_check" CHECK (("dental"."periodontal_chart"."diagnosis" IS NULL) = ("dental"."periodontal_chart"."classified_at" IS NULL) AND ("dental"."periodontal_chart"."classified_at" IS NULL) = ("dental"."periodontal_chart"."classified_by" IS NULL)),
	CONSTRAINT "periodontal_chart_inputs_check" CHECK (("dental"."periodontal_chart"."bone_loss_percent" IS NULL OR "dental"."periodontal_chart"."bone_loss_percent" BETWEEN 0 AND 100) AND ("dental"."periodontal_chart"."teeth_lost_to_periodontitis" IS NULL OR "dental"."periodontal_chart"."teeth_lost_to_periodontitis" BETWEEN 0 AND 32) AND ("dental"."periodontal_chart"."cigarettes_per_day" IS NULL OR "dental"."periodontal_chart"."cigarettes_per_day" BETWEEN 0 AND 200) AND ("dental"."periodontal_chart"."hba1c" IS NULL OR ("dental"."periodontal_chart"."diabetes" AND "dental"."periodontal_chart"."hba1c" BETWEEN 3 AND 20)))
);--> statement-breakpoint
CREATE TABLE "dental"."periodontal_tooth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"chart_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"probing_depth" smallint[] NOT NULL,
	"recession" smallint[] NOT NULL,
	"bleeding" boolean[] NOT NULL,
	"suppuration" boolean[] NOT NULL,
	"mobility" smallint,
	"furcation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plaque" boolean[],
	"peri_implant" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodontal_tooth_fdi_check" CHECK ("dental"."periodontal_tooth"."tooth_number" IN (11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48)),
	CONSTRAINT "periodontal_tooth_sites_check" CHECK (cardinality("dental"."periodontal_tooth"."probing_depth") = 6 AND cardinality("dental"."periodontal_tooth"."recession") = 6 AND cardinality("dental"."periodontal_tooth"."bleeding") = 6 AND cardinality("dental"."periodontal_tooth"."suppuration") = 6),
	CONSTRAINT "periodontal_tooth_ranges_check" CHECK (0 <= ALL("dental"."periodontal_tooth"."probing_depth") AND 15 >= ALL("dental"."periodontal_tooth"."probing_depth") AND -10 <= ALL("dental"."periodontal_tooth"."recession") AND 15 >= ALL("dental"."periodontal_tooth"."recession")),
	CONSTRAINT "periodontal_tooth_mobility_check" CHECK ("dental"."periodontal_tooth"."mobility" IS NULL OR "dental"."periodontal_tooth"."mobility" BETWEEN 0 AND 3),
	CONSTRAINT "periodontal_tooth_furcation_check" CHECK (jsonb_typeof("dental"."periodontal_tooth"."furcation") = 'object'),
	CONSTRAINT "periodontal_tooth_plaque_check" CHECK ("dental"."periodontal_tooth"."plaque" IS NULL OR cardinality("dental"."periodontal_tooth"."plaque") = 4),
	CONSTRAINT "periodontal_tooth_peri_implant_check" CHECK ("dental"."periodontal_tooth"."peri_implant" IS NULL OR "dental"."periodontal_tooth"."peri_implant" IN ('health','mucositis','peri_implantitis'))
);--> statement-breakpoint
CREATE TABLE "dental"."plan_item_finding" (
	"plan_item_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"odontogram_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "dental"."service_finding" (
	"service_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"condition" text NOT NULL,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "cash_closure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"shift_id" uuid NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"opening_retained_cents" integer DEFAULT 0 NOT NULL,
	"cash_collected_cents" integer DEFAULT 0 NOT NULL,
	"cash_added_cents" integer DEFAULT 0 NOT NULL,
	"expense_cash_cents" integer DEFAULT 0 NOT NULL,
	"cash_withdrawn_cents" integer DEFAULT 0 NOT NULL,
	"cash_refunded_cents" integer DEFAULT 0 NOT NULL,
	"expected_cents" integer NOT NULL,
	"counted_cents" integer NOT NULL,
	"difference_cents" integer NOT NULL,
	"retained_cents" integer NOT NULL,
	"delivered_cents" integer NOT NULL,
	"totals_by_method" jsonb NOT NULL,
	"notes" text,
	"closed_by" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_closure_split_check" CHECK ("cash_closure"."retained_cents" + "cash_closure"."delivered_cents" = "cash_closure"."counted_cents")
);--> statement-breakpoint
CREATE TABLE "cash_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"method" text,
	"method_type_code" text,
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
	CONSTRAINT "cash_movement_kind_check" CHECK ("cash_movement"."kind" IN ('apertura','cobro','gasto','aporte','retiro','devolucion'))
);--> statement-breakpoint
CREATE TABLE "cash_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"opening_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'abierta' NOT NULL,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"expected_cents" integer,
	"electronic_cents" integer,
	"counted_cents" integer,
	"difference_cents" integer,
	"retained_cents" integer,
	"delivered_cents" integer,
	"close_notes" text,
	CONSTRAINT "cash_shift_opening_check" CHECK ("cash_shift"."opening_cents" >= 0),
	CONSTRAINT "cash_shift_status_check" CHECK ("cash_shift"."status" IN ('abierta','cerrada'))
);--> statement-breakpoint
CREATE TABLE "commission_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"professional_user_id" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rule_rate_check" CHECK ("commission_rule"."rate_bps" BETWEEN 0 AND 10000)
);--> statement-breakpoint
CREATE TABLE "commission_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"professional_user_id" text NOT NULL,
	"period_year" integer,
	"period_month" integer,
	"base" text DEFAULT 'cobrado' NOT NULL,
	"currency" char(3) NOT NULL,
	"rate_bps" integer,
	"base_cents" integer DEFAULT 0 NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"expense_id" uuid,
	"status" text DEFAULT 'liquidada' NOT NULL,
	"notes" text,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "commission_settlement_base_check" CHECK ("commission_settlement"."base" IN ('cobrado','produccion')),
	CONSTRAINT "commission_settlement_status_check" CHECK ("commission_settlement"."status" IN ('liquidada','anulada')),
	CONSTRAINT "commission_settlement_month_check" CHECK ("commission_settlement"."period_month" IS NULL OR ("commission_settlement"."period_month" BETWEEN 1 AND 12)),
	CONSTRAINT "commission_settlement_rate_check" CHECK ("commission_settlement"."rate_bps" IS NULL OR ("commission_settlement"."rate_bps" BETWEEN 0 AND 10000))
);--> statement-breakpoint
CREATE TABLE "commission_settlement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"settlement_id" uuid NOT NULL,
	"kind" text DEFAULT 'cobro' NOT NULL,
	"source_key" text NOT NULL,
	"application_id" uuid,
	"charge_id" uuid,
	"payment_id" uuid,
	"patient_id" uuid,
	"description" text NOT NULL,
	"base_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"rate_bps" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "commission_line_base_check" CHECK ("commission_settlement_line"."base_cents" >= 0),
	CONSTRAINT "commission_line_amount_check" CHECK ("commission_settlement_line"."commission_cents" >= 0),
	CONSTRAINT "commission_line_kind_check" CHECK ("commission_settlement_line"."kind" IN ('cobro','ajuste'))
);--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"shift_id" uuid,
	"concept" text NOT NULL,
	"category" text DEFAULT 'Otros' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_kind" text DEFAULT 'ninguno' NOT NULL,
	"receipt_number" text,
	"notes" text,
	"purchase_order_id" uuid,
	"sales_tax" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "expense_amount_check" CHECK ("expense"."amount_cents" > 0),
	CONSTRAINT "expense_purchase_category_check" CHECK ("expense"."purchase_order_id" IS NULL OR "expense"."category" = 'Materiales'),
	CONSTRAINT "expense_sales_tax_check" CHECK (NOT "expense"."sales_tax" OR "expense"."category" = 'Impuestos')
);--> statement-breakpoint
CREATE TABLE "expense_gap_dismissal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"category" text NOT NULL,
	"month" text NOT NULL,
	"branch_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_gap_dismissal_month_check" CHECK ("expense_gap_dismissal"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);--> statement-breakpoint
CREATE TABLE "address_lookup_day" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"purpose" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "address_lookup_day_organization_id_day_purpose_pk" PRIMARY KEY("organization_id","day","purpose"),
	CONSTRAINT "address_lookup_day_purpose_check" CHECK ("address_lookup_day"."purpose" in ('sede', 'paciente')),
	CONSTRAINT "address_lookup_day_searches_check" CHECK ("address_lookup_day"."searches" >= 0)
);--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address_line1" text,
	"city" text,
	"district" text,
	"region" text,
	"postal_code" text,
	"country" char(2),
	"google_place_id" text,
	"phone" text,
	"email" text,
	"timezone" text,
	"appointment_default_minutes" integer DEFAULT 60 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "org_profile" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text DEFAULT '' NOT NULL,
	"fiscal_doc_type" text,
	"fiscal_doc_number" text,
	"fiscal_address" text,
	"country_code" char(2) NOT NULL,
	"currency" char(3) NOT NULL,
	"timezone" text NOT NULL,
	"locale" text NOT NULL,
	"diagnosis_system" text,
	"product" text DEFAULT 'dental' NOT NULL,
	"receipt_width" text DEFAULT '80' NOT NULL,
	"sheet_size" text DEFAULT 'A4' NOT NULL,
	"ticket_footer" text DEFAULT 'Recibo interno. No es un documento fiscal.' NOT NULL,
	"emergency_phone" text,
	"tax_legal_form" text,
	"services_tax_category" text,
	"services_tax_bps" integer,
	"products_tax_category" text,
	"products_tax_bps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_profile_services_tax_check" CHECK (("org_profile"."services_tax_category" IS NULL) = ("org_profile"."services_tax_bps" IS NULL) AND ("org_profile"."services_tax_category" IS NULL OR ("org_profile"."services_tax_category" = 'S' AND "org_profile"."services_tax_bps" BETWEEN 1 AND 5000) OR ("org_profile"."services_tax_category" IN ('E','O','Z') AND "org_profile"."services_tax_bps" = 0))),
	CONSTRAINT "org_profile_products_tax_check" CHECK (("org_profile"."products_tax_category" IS NULL) = ("org_profile"."products_tax_bps" IS NULL) AND ("org_profile"."products_tax_category" IS NULL OR ("org_profile"."products_tax_category" = 'S' AND "org_profile"."products_tax_bps" BETWEEN 1 AND 5000) OR ("org_profile"."products_tax_category" IN ('E','O','Z') AND "org_profile"."products_tax_bps" = 0))),
	CONSTRAINT "org_profile_receipt_width_check" CHECK ("org_profile"."receipt_width" IN ('58','80')),
	CONSTRAINT "org_profile_product_check" CHECK ("org_profile"."product" IN ('dental','medical')),
	CONSTRAINT "org_profile_sheet_size_check" CHECK ("org_profile"."sheet_size" IN ('A4','Letter')),
	CONSTRAINT "org_profile_diagnosis_system_check" CHECK ("org_profile"."diagnosis_system" IS NULL OR "org_profile"."diagnosis_system" IN ('ICD-10','ICD-11')),
	CONSTRAINT "org_profile_ticket_footer_check" CHECK (length(trim("org_profile"."ticket_footer")) BETWEEN 1 AND 280)
);--> statement-breakpoint
CREATE TABLE "patient_registration_config" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"fields" jsonb NOT NULL,
	"privacy_notice" text DEFAULT '' NOT NULL,
	"ask_reminders" boolean DEFAULT true NOT NULL,
	"ask_messages" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "help_ask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"screen" text NOT NULL,
	"topic_id" text,
	"helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "home_visit" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"greeted_on" date
);--> statement-breakpoint
CREATE TABLE "admin"."legal_notice" (
	"user_id" text NOT NULL,
	"version" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "processing_agreement_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"version" text NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "workspace_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"permission" text NOT NULL,
	"subject" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"used_in_care" boolean DEFAULT true NOT NULL,
	"for_sale" boolean DEFAULT false NOT NULL,
	"unit" text DEFAULT 'unidad' NOT NULL,
	"unit_code" text,
	"purchase_unit" text,
	"purchase_unit_code" text,
	"purchase_factor" integer DEFAULT 1 NOT NULL,
	"unit_review" boolean DEFAULT false NOT NULL,
	"sale_price_cents" integer,
	"sale_currency" char(3),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_use_check" CHECK ("product"."used_in_care" OR "product"."for_sale"),
	CONSTRAINT "product_purchase_factor_check" CHECK ("product"."purchase_factor" BETWEEN 1 AND 100000),
	CONSTRAINT "product_sale_price_check" CHECK (("product"."sale_price_cents" IS NULL) = ("product"."sale_currency" IS NULL) AND ("product"."sale_price_cents" IS NULL OR "product"."sale_price_cents" >= 0)),
	CONSTRAINT "product_sale_currency_check" CHECK ("product"."sale_currency" IS NULL OR "product"."sale_currency" ~ '^[A-Z]{3}$')
);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE TABLE "product_minimum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_minimum_quantity_check" CHECK ("product_minimum"."min_quantity" BETWEEN 0 AND 1000000000)
);--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"order_number" integer,
	"status" text DEFAULT 'borrador' NOT NULL,
	"currency" text NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_status_check" CHECK ("purchase_order"."status" IN ('borrador','confirmada','parcialmente_recibida','recibida','cerrada','cancelada')),
	CONSTRAINT "purchase_order_currency_check" CHECK ("purchase_order"."currency" ~ '^[A-Z]{3}$')
);--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"ordered_unit_cost_cents" integer,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"purchase_unit" text,
	"unit_factor" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_line_quantity_check" CHECK ("purchase_order_line"."quantity" > 0),
	CONSTRAINT "purchase_order_line_cost_check" CHECK ("purchase_order_line"."unit_cost_cents" >= 0),
	CONSTRAINT "purchase_order_line_ordered_cost_check" CHECK ("purchase_order_line"."ordered_unit_cost_cents" IS NULL OR "purchase_order_line"."ordered_unit_cost_cents" >= 0),
	CONSTRAINT "purchase_order_line_received_check" CHECK ("purchase_order_line"."received_quantity" >= 0),
	CONSTRAINT "purchase_order_line_factor_check" CHECK ("purchase_order_line"."unit_factor" BETWEEN 1 AND 100000)
);--> statement-breakpoint
CREATE TABLE "service_material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_material_quantity_check" CHECK ("service_material"."quantity" BETWEEN 1 AND 9999)
);--> statement-breakpoint
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
	"encounter_id" uuid,
	"charge_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_kind_check" CHECK ("stock_movement"."kind" IN ('ingreso','consumo','ajuste','traslado','venta','cobertura','devolucion')),
	CONSTRAINT "stock_movement_delta_check" CHECK ("stock_movement"."quantity_delta" <> 0),
	CONSTRAINT "stock_movement_encounter_patient_check" CHECK ("stock_movement"."encounter_id" IS NULL OR "stock_movement"."patient_id" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "stock_shortage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_shortage_quantity_check" CHECK ("stock_shortage"."quantity" >= 0)
);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE TABLE "supplier_credit_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "supplier_credit_use_amount_check" CHECK ("supplier_credit_use"."amount_cents" > 0),
	CONSTRAINT "supplier_credit_use_currency_check" CHECK ("supplier_credit_use"."currency" ~ '^[A-Z]{3}$')
);--> statement-breakpoint
CREATE TABLE "warehouse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
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
	"currency" char(3) NOT NULL,
	"assigned_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"close_note" text,
	"conversation_id" uuid,
	"budget_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_close_reason_check" CHECK ("opportunity"."close_reason" IS NULL OR "opportunity"."close_reason" IN ('precio','otra_clinica','no_responde','no_lo_necesita','otro','rechazo_presupuesto','acepto','acepto_presupuesto'))
);--> statement-breakpoint
CREATE TABLE "opportunity_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"actor_user_id" text,
	"origin" text DEFAULT 'persona' NOT NULL,
	"cause" text,
	"cause_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_event_origin_check" CHECK ("opportunity_event"."origin" IN ('persona','agente','automatico'))
);--> statement-breakpoint
CREATE TABLE "portal_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "portal_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"pin_hash" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
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
);--> statement-breakpoint
CREATE TABLE "portal_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"link_id" uuid,
	"grant_id" uuid,
	"auth_method" text DEFAULT 'enlace_pin' NOT NULL,
	"passkey_id" uuid,
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
);--> statement-breakpoint
CREATE TABLE "portal_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"grant_id" uuid,
	"session_id" uuid,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_challenge_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "portal_challenge_type_check" CHECK ("portal_challenge"."type" IN ('registro','autenticacion'))
);--> statement-breakpoint
CREATE TABLE "portal_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'activo' NOT NULL,
	"verified_method" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_grant_status_check" CHECK ("portal_grant"."status" IN ('activo','revocado')),
	CONSTRAINT "portal_grant_verified_method_check" CHECK ("portal_grant"."verified_method" IN ('presencial_documento','representacion_verificada')),
	CONSTRAINT "portal_grant_revoked_check" CHECK (("portal_grant"."status" <> 'revocado') = ("portal_grant"."revoked_at" IS NULL))
);--> statement-breakpoint
CREATE TABLE "portal_passkey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "portal_passkey_credential_id_unique" UNIQUE("credential_id")
);--> statement-breakpoint
CREATE TABLE "portal_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"portal_enabled" boolean DEFAULT false NOT NULL,
	"allowed_scope" jsonb DEFAULT '{"appointments":true,"budgets":true,"account":true,"documents":true}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "portal_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"grant_id" uuid,
	"method" text NOT NULL,
	"verified_by" text,
	"evidence_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_verification_method_check" CHECK ("portal_verification"."method" IN ('presencial_documento','representacion_verificada'))
);--> statement-breakpoint
CREATE TABLE "mailbox_oauth_state" (
	"nonce" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "webchat_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);--> statement-breakpoint
CREATE TABLE "webchat_site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webchat_site_status_check" CHECK ("webchat_site"."status" in ('permitido','pendiente','bloqueado'))
);--> statement-breakpoint
CREATE TABLE "organization_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type_code" text DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_payment_method_type_check" CHECK ("organization_payment_method"."type_code" IN ('10','48','30','68','20','1')),
	CONSTRAINT "organization_payment_method_sort_check" CHECK ("organization_payment_method"."sort_order" >= 0),
	CONSTRAINT "organization_payment_method_name_check" CHECK (length(trim("organization_payment_method"."name")) BETWEEN 1 AND 120)
);--> statement-breakpoint
CREATE TABLE "promotion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"conditions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_dates_check" CHECK ("promotion"."ends_at" IS NULL OR "promotion"."ends_at" >= "promotion"."starts_at")
);--> statement-breakpoint
CREATE TABLE "promotion_service_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"promotion_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"mode" text DEFAULT 'fixed' NOT NULL,
	"price_disclosure" text DEFAULT 'exacto' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_service_price_mode_check" CHECK ("promotion_service_price"."mode" IN ('fixed','from')),
	CONSTRAINT "promotion_service_price_amount_check" CHECK ("promotion_service_price"."price_cents" >= 0),
	CONSTRAINT "promotion_service_price_disclosure_check" CHECK ("promotion_service_price"."price_disclosure" IN ('exacto','desde','evaluacion'))
);--> statement-breakpoint
CREATE TABLE "saas_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text,
	"units" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"encounter_id" uuid,
	"appointment_id" uuid,
	"channel" text,
	"window_start" timestamp with time zone,
	"detail" text NOT NULL,
	"currency" char(3),
	"base_price_micros" bigint,
	"price_micros" bigint,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"tier_changed_at" timestamp with time zone,
	"previous_price_micros" bigint,
	"dedupe_key" text NOT NULL,
	"charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_action_kind_check" CHECK ("saas_action"."kind" IN ('conversacion','consulta','cita','preguntas','almacenamiento')),
	CONSTRAINT "saas_action_tier_check" CHECK (coalesce(CASE "saas_action"."kind" WHEN 'conversacion' THEN "saas_action"."tier" IN ('informa','gestiona','agenda') WHEN 'consulta' THEN "saas_action"."tier" IN ('simple','estandar','completa') ELSE "saas_action"."tier" IS NULL END, false) AND ("saas_action"."units" IS NULL OR "saas_action"."units" > 0)),
	CONSTRAINT "saas_action_price_check" CHECK (("saas_action"."base_price_micros" IS NULL) = ("saas_action"."price_micros" IS NULL) AND coalesce("saas_action"."price_micros", 0) >= 0 AND "saas_action"."discount_bps" BETWEEN 0 AND 9000)
);--> statement-breakpoint
CREATE TABLE "saas_action_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"requested_by_user_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_until" timestamp with time zone,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_staff_id" text,
	"answer" text,
	"support_case_id" uuid,
	"credit_charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_action_review_reason_check" CHECK ("saas_action_review"."reason" IN ('spam','agente','doble','otro')),
	CONSTRAINT "saas_action_review_note_check" CHECK ("saas_action_review"."note" IS NULL OR length("saas_action_review"."note") <= 1000),
	CONSTRAINT "saas_action_review_decision_check" CHECK (("saas_action_review"."status" = 'pendiente' AND "saas_action_review"."decided_at" IS NULL AND "saas_action_review"."decided_by_staff_id" IS NULL AND "saas_action_review"."answer" IS NULL AND NOT "saas_action_review"."automatic")
        OR ("saas_action_review"."status" = 'devuelta' AND "saas_action_review"."automatic" AND "saas_action_review"."decided_at" IS NOT NULL AND "saas_action_review"."decided_by_staff_id" IS NULL)
        OR ("saas_action_review"."status" IN ('devuelta','mantenida') AND NOT "saas_action_review"."automatic" AND "saas_action_review"."decided_at" IS NOT NULL
          AND "saas_action_review"."decided_by_staff_id" IS NOT NULL AND length(trim("saas_action_review"."answer")) > 0)),
	CONSTRAINT "saas_action_review_credit_check" CHECK ("saas_action_review"."credit_charge_id" IS NULL OR "saas_action_review"."status" = 'devuelta')
);--> statement-breakpoint
CREATE TABLE "saas_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" uuid,
	"plan_code" text NOT NULL,
	"plan_name" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"subtotal_cents" integer,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"tax_label" text,
	"credit_cents" integer,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"due_at" timestamp with time zone,
	"created_by" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "saas_charge_org_id_uidx" UNIQUE("organization_id","id"),
	CONSTRAINT "saas_charge_amount_check" CHECK ("saas_charge"."amount_cents" >= 0),
	CONSTRAINT "saas_charge_paid_check" CHECK ("saas_charge"."paid_cents" >= 0),
	CONSTRAINT "saas_charge_credit_check" CHECK ("saas_charge"."credit_cents" IS NULL OR "saas_charge"."credit_cents" >= 0),
	CONSTRAINT "saas_charge_status_check" CHECK ("saas_charge"."status" IN ('pendiente','parcial','pagada','reversada','anulada'))
);--> statement-breakpoint
CREATE TABLE "saas_charge_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"charge_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_base_micros" bigint,
	"unit_price_micros" bigint,
	"amount_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_charge_line_kind_check" CHECK ("saas_charge_line"."kind" IN ('cuota','conversacion','consulta','cita','preguntas','almacenamiento','devolucion','revision','credito','impuesto')),
	CONSTRAINT "saas_charge_line_amount_check" CHECK ("saas_charge_line"."quantity" >= 0 AND CASE WHEN "saas_charge_line"."kind" IN ('devolucion','revision') THEN "saas_charge_line"."amount_cents" <= 0 ELSE "saas_charge_line"."amount_cents" >= 0 END)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_commercial_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"conversation_window_hours" integer NOT NULL,
	"recovery_window_days" integer NOT NULL,
	"review_auto_percent" integer NOT NULL,
	"review_answer_days" integer NOT NULL,
	"review_read_days" integer NOT NULL,
	"payment_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"proof_extension_days" integer NOT NULL,
	"proof_extension_max" integer NOT NULL,
	"half_cycle_days" integer NOT NULL,
	"trial_days" integer NOT NULL,
	"warn_percent" integer NOT NULL,
	"alarm_percent" integer NOT NULL,
	"waitlist_answer_days" integer NOT NULL,
	"commission_months" integer NOT NULL,
	"discount_notice_days" integer NOT NULL,
	"guarantee_notice_days" integer NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_commercial_terms_effective_uidx" UNIQUE("effective_from"),
	CONSTRAINT "saas_commercial_terms_limits_check" CHECK ("admin"."saas_commercial_terms"."conversation_window_hours" BETWEEN 1 AND 72
        AND "admin"."saas_commercial_terms"."recovery_window_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."review_auto_percent" BETWEEN 0 AND 30
        AND "admin"."saas_commercial_terms"."review_answer_days" BETWEEN 1 AND 10
        AND "admin"."saas_commercial_terms"."review_read_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."payment_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."grace_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."proof_extension_days" BETWEEN 0 AND 10
        AND "admin"."saas_commercial_terms"."proof_extension_max" BETWEEN 0 AND 3
        AND "admin"."saas_commercial_terms"."half_cycle_days" BETWEEN 7 AND 21
        AND "admin"."saas_commercial_terms"."trial_days" BETWEEN 7 AND 90
        AND "admin"."saas_commercial_terms"."warn_percent" BETWEEN 50 AND 99
        AND "admin"."saas_commercial_terms"."alarm_percent" BETWEEN 50 AND 99
        AND "admin"."saas_commercial_terms"."warn_percent" < "admin"."saas_commercial_terms"."alarm_percent"
        AND "admin"."saas_commercial_terms"."waitlist_answer_days" BETWEEN 1 AND 10
        AND "admin"."saas_commercial_terms"."commission_months" BETWEEN 1 AND 36
        AND "admin"."saas_commercial_terms"."discount_notice_days" BETWEEN 1 AND 30
        AND "admin"."saas_commercial_terms"."guarantee_notice_days" BETWEEN 1 AND 60),
	CONSTRAINT "saas_commercial_terms_reason_check" CHECK ("admin"."saas_commercial_terms"."reason" IS NULL OR length("admin"."saas_commercial_terms"."reason") BETWEEN 1 AND 500)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_commission_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"commission_id" uuid NOT NULL,
	"payment_id" uuid,
	"seller_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_commission_adjustment_amount_check" CHECK ("admin"."saas_commission_adjustment"."amount_cents" > 0)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_commission_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"adjustment_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'liquidada' NOT NULL,
	"notes" text,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "saas_settlement_month_check" CHECK ("admin"."saas_commission_settlement"."period_month" BETWEEN 1 AND 12),
	CONSTRAINT "saas_settlement_status_check" CHECK ("admin"."saas_commission_settlement"."status" IN ('liquidada','anulada'))
);--> statement-breakpoint
CREATE TABLE "admin"."saas_commission_settlement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"kind" text DEFAULT 'cobro' NOT NULL,
	"source_key" text NOT NULL,
	"commission_id" uuid,
	"adjustment_id" uuid,
	"organization_id" text,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "saas_settlement_line_kind_check" CHECK ("admin"."saas_commission_settlement_line"."kind" IN ('cobro','ajuste'))
);--> statement-breakpoint
CREATE TABLE "admin"."saas_negotiation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"discount_bps" integer,
	"discount_ends_at" timestamp with time zone,
	"trial_credit_cents" integer,
	"trial_days" integer,
	"note" text,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_negotiation_kind_check" CHECK ("admin"."saas_negotiation"."kind" IN ('descuento','prueba')),
	CONSTRAINT "saas_negotiation_status_check" CHECK ("admin"."saas_negotiation"."status" IN ('pendiente','aprobada','rechazada'))
);--> statement-breakpoint
CREATE TABLE "saas_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"email_to" text,
	"emailed_at" timestamp with time zone,
	"email_state" text DEFAULT 'pendiente' NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_notice_dedupe_uidx" UNIQUE("organization_id","dedupe_key")
);--> statement-breakpoint
CREATE TABLE "saas_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"charge_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"method_code" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"receipt_object_key" text,
	"receipt_filename" text,
	"receipt_mime" text,
	"receipt_size" integer,
	"idempotency_key" text NOT NULL,
	"notes" text,
	"created_by" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reverse_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_payment_org_id_uidx" UNIQUE("organization_id","id"),
	CONSTRAINT "saas_payment_org_key_uidx" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "saas_payment_amount_check" CHECK ("saas_payment"."amount_cents" > 0),
	CONSTRAINT "saas_payment_status_check" CHECK ("saas_payment"."status" IN ('pendiente','confirmado','reversado','devuelto'))
);--> statement-breakpoint
CREATE TABLE "admin"."saas_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_payment_method_code_uidx" UNIQUE("code"),
	CONSTRAINT "saas_payment_method_code_check" CHECK (length(trim("admin"."saas_payment_method"."code")) BETWEEN 1 AND 80),
	CONSTRAINT "saas_payment_method_name_check" CHECK (length(trim("admin"."saas_payment_method"."name")) BETWEEN 1 AND 120)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" char(3) NOT NULL,
	"price_cents" integer NOT NULL,
	"billing_period" text DEFAULT 'mensual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"conversation_micros" bigint,
	"conversation_inform_micros" bigint,
	"conversation_agenda_micros" bigint,
	"consultation_micros" bigint,
	"consultation_simple_micros" bigint,
	"consultation_standard_micros" bigint,
	"recovery_micros" bigint,
	"argos_included_questions" integer DEFAULT 0 NOT NULL,
	"argos_pack_questions" integer DEFAULT 100 NOT NULL,
	"argos_pack_micros" bigint,
	"storage_included_gb" integer DEFAULT 0 NOT NULL,
	"storage_gb_micros" bigint,
	"fixed_price_tiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_discount_bps" integer DEFAULT 6000 NOT NULL,
	"seller_discount_bps" integer DEFAULT 1000 NOT NULL,
	"trial_credit_cents" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 30 NOT NULL,
	"trial_max_credit_cents" integer DEFAULT 0 NOT NULL,
	"trial_max_days" integer DEFAULT 60 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"show_on_web" boolean DEFAULT false NOT NULL,
	"seat_limit" integer,
	"guarantee_months" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_plan_code_uidx" UNIQUE("code"),
	CONSTRAINT "saas_plan_founders_check" CHECK (("admin"."saas_plan"."seat_limit" IS NULL OR "admin"."saas_plan"."seat_limit" > 0) AND ("admin"."saas_plan"."guarantee_months" IS NULL OR "admin"."saas_plan"."guarantee_months" BETWEEN 1 AND 120)),
	CONSTRAINT "saas_plan_action_check" CHECK ("admin"."saas_plan"."credit_cents" >= 0 AND coalesce("admin"."saas_plan"."conversation_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."consultation_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."recovery_micros", 0) >= 0),
	CONSTRAINT "saas_plan_tier_check" CHECK (coalesce("admin"."saas_plan"."conversation_inform_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."conversation_agenda_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."consultation_simple_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."consultation_standard_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."argos_pack_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."storage_gb_micros", 0) >= 0 AND "admin"."saas_plan"."argos_included_questions" >= 0 AND "admin"."saas_plan"."argos_pack_questions" BETWEEN 1 AND 10000 AND "admin"."saas_plan"."storage_included_gb" >= 0),
	CONSTRAINT "saas_plan_fixed_tiers_check" CHECK ("admin"."saas_plan"."fixed_price_tiers" <@ ARRAY['informa','gestiona','agenda','simple','estandar','completa','cita','preguntas','almacenamiento']::text[]),
	CONSTRAINT "saas_plan_discount_check" CHECK ("admin"."saas_plan"."max_discount_bps" BETWEEN 0 AND 9000 AND "admin"."saas_plan"."seller_discount_bps" BETWEEN 0 AND "admin"."saas_plan"."max_discount_bps"),
	CONSTRAINT "saas_plan_trial_check" CHECK ("admin"."saas_plan"."trial_credit_cents" >= 0 AND "admin"."saas_plan"."trial_days" BETWEEN 1 AND 365 AND "admin"."saas_plan"."trial_max_credit_cents" >= "admin"."saas_plan"."trial_credit_cents" AND "admin"."saas_plan"."trial_max_days" >= "admin"."saas_plan"."trial_days"),
	CONSTRAINT "saas_plan_price_check" CHECK ("admin"."saas_plan"."price_cents" >= 0),
	CONSTRAINT "saas_plan_currency_check" CHECK ("admin"."saas_plan"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "saas_plan_code_check" CHECK (length(trim("admin"."saas_plan"."code")) BETWEEN 1 AND 80)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_seller" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"display_name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"window_days" integer DEFAULT 90 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_seller_user_uidx" UNIQUE("user_id"),
	CONSTRAINT "saas_seller_rate_check" CHECK ("admin"."saas_seller"."rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "saas_seller_window_check" CHECK ("admin"."saas_seller"."window_days" BETWEEN 0 AND 730)
);--> statement-breakpoint
CREATE TABLE "admin"."saas_seller_commission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"payment_id" uuid,
	"seller_id" uuid NOT NULL,
	"rate_bps" integer NOT NULL,
	"window_days" integer NOT NULL,
	"base_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"adjustable_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_seller_commission_payment_uidx" UNIQUE("payment_id"),
	CONSTRAINT "saas_seller_commission_amount_check" CHECK ("admin"."saas_seller_commission"."commission_cents" >= 0),
	CONSTRAINT "saas_seller_commission_status_check" CHECK ("admin"."saas_seller_commission"."status" IN ('pendiente','liquidada','ajustada'))
);--> statement-breakpoint
CREATE TABLE "admin"."saas_signup_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'invitacion' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_signup_policy_singleton_check" CHECK ("admin"."saas_signup_policy"."id" = 1),
	CONSTRAINT "saas_signup_policy_mode_check" CHECK ("admin"."saas_signup_policy"."mode" IN ('invitacion','abierta'))
);--> statement-breakpoint
CREATE TABLE "saas_subscription" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"plan_id" uuid,
	"status" text DEFAULT 'prueba' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"trial_started_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"restrict_reason" text,
	"pause_reason" text,
	"proof_extension_until" timestamp with time zone,
	"proof_extension_count" integer DEFAULT 0 NOT NULL,
	"seller_id" uuid,
	"seller_rate_bps" integer,
	"seller_window_days" integer,
	"seller_started_at" timestamp with time zone,
	"seller_ended_at" timestamp with time zone,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"discount_ends_at" timestamp with time zone,
	"guaranteed_until" timestamp with time zone,
	"trial_credit_cents" integer,
	"trial_days" integer,
	"spend_cap_cents" integer,
	"billing_cycle" text DEFAULT 'mensual' NOT NULL,
	"argos_auto_pack" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_subscription_discount_check" CHECK ("saas_subscription"."discount_bps" BETWEEN 0 AND 9000),
	CONSTRAINT "saas_subscription_terms_check" CHECK (("saas_subscription"."trial_credit_cents" IS NULL OR "saas_subscription"."trial_credit_cents" >= 0) AND ("saas_subscription"."trial_days" IS NULL OR "saas_subscription"."trial_days" BETWEEN 1 AND 365) AND ("saas_subscription"."spend_cap_cents" IS NULL OR "saas_subscription"."spend_cap_cents" >= 0) AND "saas_subscription"."billing_cycle" IN ('mensual','quincenal')),
	CONSTRAINT "saas_subscription_status_check" CHECK ("saas_subscription"."status" IN ('prueba','activa','gracia','restringida','pausada','cancelada'))
);--> statement-breakpoint
CREATE TABLE "admin"."saas_waitlist_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"clinic_name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"city" text NOT NULL,
	"professionals" text NOT NULL,
	"current_tool" text NOT NULL,
	"product" text DEFAULT 'dental' NOT NULL,
	"status" text DEFAULT 'por_revisar' NOT NULL,
	"note" text,
	"discard_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"plan_id" uuid,
	"token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"organization_id" text,
	"entered_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"invitation_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_waitlist_request_status_check" CHECK ("admin"."saas_waitlist_request"."status" IN ('por_revisar','invitada','entro','descartada')),
	CONSTRAINT "saas_waitlist_request_professionals_check" CHECK ("admin"."saas_waitlist_request"."professionals" IN ('1','2-3','4-9','10+')),
	CONSTRAINT "saas_waitlist_request_tool_check" CHECK ("admin"."saas_waitlist_request"."current_tool" IN ('nada','cuaderno_excel','otro_software')),
	CONSTRAINT "saas_waitlist_request_country_check" CHECK ("admin"."saas_waitlist_request"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "saas_waitlist_request_product_check" CHECK ("admin"."saas_waitlist_request"."product" IN ('dental','medical')),
	CONSTRAINT "saas_waitlist_request_text_check" CHECK (length(trim("admin"."saas_waitlist_request"."first_name")) BETWEEN 1 AND 80 AND length(trim("admin"."saas_waitlist_request"."last_name")) BETWEEN 1 AND 80
        AND length(trim("admin"."saas_waitlist_request"."clinic_name")) BETWEEN 1 AND 120 AND length(trim("admin"."saas_waitlist_request"."city")) BETWEEN 1 AND 80
        AND length("admin"."saas_waitlist_request"."email") BETWEEN 3 AND 254 AND length("admin"."saas_waitlist_request"."phone") BETWEEN 6 AND 20
        AND ("admin"."saas_waitlist_request"."note" IS NULL OR length("admin"."saas_waitlist_request"."note") <= 2000)),
	CONSTRAINT "saas_waitlist_request_invite_check" CHECK (("admin"."saas_waitlist_request"."status" = 'por_revisar' AND "admin"."saas_waitlist_request"."token_hash" IS NULL AND "admin"."saas_waitlist_request"."organization_id" IS NULL)
        OR ("admin"."saas_waitlist_request"."status" = 'invitada' AND "admin"."saas_waitlist_request"."token_hash" IS NOT NULL AND "admin"."saas_waitlist_request"."plan_id" IS NOT NULL AND "admin"."saas_waitlist_request"."invite_expires_at" IS NOT NULL AND "admin"."saas_waitlist_request"."organization_id" IS NULL)
        OR ("admin"."saas_waitlist_request"."status" = 'entro' AND "admin"."saas_waitlist_request"."plan_id" IS NOT NULL AND "admin"."saas_waitlist_request"."entered_at" IS NOT NULL)
        OR ("admin"."saas_waitlist_request"."status" = 'descartada' AND "admin"."saas_waitlist_request"."organization_id" IS NULL AND length(trim(coalesce("admin"."saas_waitlist_request"."discard_reason", ''))) > 0))
);--> statement-breakpoint
CREATE TABLE "storage_usage_day" (
	"organization_id" text NOT NULL,
	"day" text NOT NULL,
	"bytes" bigint NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_day_check" CHECK ("storage_usage_day"."bytes" >= 0 AND "storage_usage_day"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);--> statement-breakpoint
CREATE TABLE "report_digest" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "report_digest_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"week" date NOT NULL,
	"state" text DEFAULT 'reclamado' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "report_digest_send_state_check" CHECK ("report_digest_send"."state" in ('reclamado','enviado','incierto','omitido'))
);--> statement-breakpoint
CREATE TABLE "report_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"metric" text NOT NULL,
	"from_month" date NOT NULL,
	"amount" bigint,
	"currency" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_goal_metric_check" CHECK ("report_goal"."metric" in ('cobrado','pacientes_nuevos')),
	CONSTRAINT "report_goal_amount_check" CHECK ("report_goal"."amount" is null or "report_goal"."amount" > 0),
	CONSTRAINT "report_goal_currency_check" CHECK ("report_goal"."metric" <> 'cobrado' or "report_goal"."amount" is null or "report_goal"."currency" is not null),
	CONSTRAINT "report_goal_month_check" CHECK (extract(day from "report_goal"."from_month") = 1)
);--> statement-breakpoint
CREATE TABLE "report_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"figure" text,
	"group_by" text DEFAULT 'total' NOT NULL,
	"focus" text DEFAULT '' NOT NULL,
	"argos" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_pin_kind_check" CHECK (("report_pin"."figure" IS NULL) <> ("report_pin"."argos" IS NULL))
);--> statement-breakpoint
CREATE TABLE "report_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"figure" text,
	"group_by" text,
	"query" text,
	"plan" jsonb,
	"used_model" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_question_outcome_check" CHECK ("report_question"."outcome" in ('respondida','parcial','pregunta','no_sabe','clinico','accion','ayuda','otro','no_pudo'))
);--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin"."admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_idx" ON "admin"."admin_audit" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "admin_invitation_email_idx" ON "admin"."admin_invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "admin_session_verification_session_idx" ON "admin"."admin_session_verification" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "admin_session_verification_user_idx" ON "admin"."admin_session_verification" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "auth"."two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_recovery_case_email_idx" ON "admin"."account_recovery_case" USING btree ("email");--> statement-breakpoint
CREATE INDEX "account_recovery_case_status_idx" ON "admin"."account_recovery_case" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_access_audit_grant_idx" ON "support_access_audit" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "support_access_audit_case_idx" ON "support_access_audit" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_access_grant_case_idx" ON "support_access_grant" USING btree ("case_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_access_grant_org_idx" ON "support_access_grant" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_grant_id_case_org_uidx" ON "support_access_grant" USING btree ("id","case_id","organization_id");--> statement-breakpoint
CREATE INDEX "support_attachment_case_idx" ON "support_attachment" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_case_org_status_idx" ON "support_case" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "support_case_staff_idx" ON "support_case" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "support_case_assignee_idx" ON "support_case" USING btree ("assignee_staff_id","status");--> statement-breakpoint
CREATE INDEX "support_case_dedupe_idx" ON "support_case" USING btree ("dedupe_key","status");--> statement-breakpoint
CREATE INDEX "support_case_opener_idx" ON "support_case" USING btree ("opened_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_case_id_org_uidx" ON "support_case" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "support_message_case_idx" ON "support_message" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_message_id_case_uidx" ON "support_message" USING btree ("id","case_id");--> statement-breakpoint
CREATE INDEX "support_notice_case_idx" ON "support_notice" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_notice_state_idx" ON "support_notice" USING btree ("email_state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_org_id_uidx" ON "appointment" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_org_patient_id_uidx" ON "appointment" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE INDEX "appointment_org_branch_range_idx" ON "appointment" USING btree ("organization_id","branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_org_professional_range_idx" ON "appointment" USING btree ("organization_id","professional_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_org_patient_idx" ON "appointment" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_booking_link_token_uidx" ON "appointment_booking_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "appointment_booking_link_conversation_idx" ON "appointment_booking_link" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "appointment_booking_link_contact_idx" ON "appointment_booking_link" USING btree ("organization_id","contact_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_org_id_uidx" ON "calendar_feed" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_token_uidx" ON "calendar_feed" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_org_user_active_uidx" ON "calendar_feed" USING btree ("organization_id","user_id") WHERE "status" = 'activo';--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_room_org_id_uidx" ON "schedule_room" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_room_org_branch_idx" ON "schedule_room" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE INDEX "agent_answer_trace_conversation_idx" ON "agent_answer_trace" USING btree ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_answer_trace_message_idx" ON "agent_answer_trace" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX "agent_answer_trace_proposal_idx" ON "agent_answer_trace" USING btree ("organization_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_case_memory_org_conversation_uidx" ON "agent_case_memory" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "agent_decision_log_org_idx" ON "agent_decision_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_decision_log_conversation_idx" ON "agent_decision_log" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_handoff_org_idx" ON "agent_handoff" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_handoff_conversation_idx" ON "agent_handoff" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_entry_org_idx" ON "agent_knowledge_entry" USING btree ("organization_id","status","kind");--> statement-breakpoint
CREATE INDEX "agent_knowledge_gap_org_idx" ON "agent_knowledge_gap" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_knowledge_gap_conversation_idx" ON "agent_knowledge_gap" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_revision_entry_idx" ON "agent_knowledge_revision" USING btree ("entry_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_revision_entry_version_uidx" ON "agent_knowledge_revision" USING btree ("entry_id","version");--> statement-breakpoint
CREATE INDEX "agent_lesson_org_idx" ON "agent_lesson" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_person_fact_contact_idx" ON "agent_person_fact" USING btree ("organization_id","contact_id","status");--> statement-breakpoint
CREATE INDEX "agent_proposal_org_idx" ON "agent_proposal" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposal_conversation_idx" ON "agent_proposal" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_proposal_org_patient_idx" ON "agent_proposal" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposal_org_key_uidx" ON "agent_proposal" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_review_item_trace_uidx" ON "agent_review_item" USING btree ("organization_id","trace_id");--> statement-breakpoint
CREATE INDEX "agent_review_item_org_idx" ON "agent_review_item" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_ledger_org_idx" ON "agent_run_ledger" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_run_ledger_conversation_idx" ON "agent_run_ledger" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_search_item_ref_uidx" ON "agent_search_item" USING btree ("organization_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "agent_search_item_pending_idx" ON "agent_search_item" USING btree ("organization_id") WHERE "agent_search_item"."embedding" is null;--> statement-breakpoint
CREATE INDEX "agent_test_case_org_idx" ON "agent_test_case" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_org_idx" ON "ai_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_consent_org_contact_purpose_uidx" ON "automation_consent" USING btree ("organization_id","contact_id","purpose");--> statement-breakpoint
CREATE INDEX "automation_consent_org_contact_idx" ON "automation_consent" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_job_org_dedupe_uidx" ON "automation_job" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_job_org_status_scheduled_idx" ON "automation_job" USING btree ("organization_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "automation_job_org_appointment_idx" ON "automation_job" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "automation_job_org_contact_idx" ON "automation_job" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "automation_job_org_opportunity_idx" ON "automation_job" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "automation_job_org_message_idx" ON "automation_job" USING btree ("organization_id","sent_message_id");--> statement-breakpoint
CREATE INDEX "automation_link_token_org_expires_idx" ON "automation_link_token" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_org_id_uidx" ON "automation_rule" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_org_kind_uidx" ON "automation_rule" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_schedule_org_id_uidx" ON "professional_schedule" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "professional_schedule_org_branch_professional_idx" ON "professional_schedule" USING btree ("organization_id","branch_id","professional_user_id");--> statement-breakpoint
CREATE INDEX "professional_schedule_org_valid_idx" ON "professional_schedule" USING btree ("organization_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_block_org_id_uidx" ON "schedule_block" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_block_org_branch_range_idx" ON "schedule_block" USING btree ("organization_id","branch_id","starts_at");--> statement-breakpoint
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
CREATE UNIQUE INDEX "consent_template_service_uidx" ON "consent_template_service" USING btree ("organization_id","template_key","service_id");--> statement-breakpoint
CREATE INDEX "consent_template_service_service_idx" ON "consent_template_service" USING btree ("organization_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "medical_leave_org_number_uidx" ON "medical_leave" USING btree ("organization_id","leave_number");--> statement-breakpoint
CREATE INDEX "medical_leave_org_patient_idx" ON "medical_leave" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "medical_leave_encounter_idx" ON "medical_leave" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_specialty_org_key_uidx" ON "org_specialty" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "org_specialty_org_id_uidx" ON "org_specialty" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "org_specialty_org_active_idx" ON "org_specialty" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_profile_org_user_uidx" ON "professional_profile" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_specialty_uidx" ON "professional_specialty" USING btree ("organization_id","specialty_id","user_id");--> statement-breakpoint
CREATE INDEX "professional_specialty_org_user_idx" ON "professional_specialty" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "appointment_plan_item_plan_item_idx" ON "appointment_plan_item" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_follow_up_repeats_from_idx" ON "clinical_follow_up" USING btree ("repeats_from_id") WHERE "clinical_follow_up"."repeats_from_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "clinical_follow_up_appointment_idx" ON "clinical_follow_up" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "clinical_follow_up_org_patient_idx" ON "clinical_follow_up" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "clinical_follow_up_item_idx" ON "clinical_follow_up" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "clinical_follow_up_due_idx" ON "clinical_follow_up" USING btree ("organization_id","due_at");--> statement-breakpoint
CREATE INDEX "clinical_note_org_patient_created_idx" ON "clinical_note" USING btree ("organization_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "encounter_org_patient_idx" ON "encounter" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_org_patient_id_uidx" ON "encounter" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_patient_open_uidx" ON "encounter" USING btree ("patient_id") WHERE status = 'borrador';--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_appointment_active_uidx" ON "encounter" USING btree ("organization_id","appointment_id") WHERE appointment_id IS NOT NULL AND status <> 'anulada';--> statement-breakpoint
CREATE INDEX "encounter_diagnosis_org_patient_idx" ON "encounter_diagnosis" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "encounter_diagnosis_encounter_idx" ON "encounter_diagnosis" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_diagnosis_legacy_note_uidx" ON "encounter_diagnosis" USING btree ("legacy_note_id") WHERE legacy_note_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "encounter_diagnosis_org_code_idx" ON "encounter_diagnosis" USING btree ("organization_id","diagnosis_system","diagnosis_code");--> statement-breakpoint
CREATE INDEX "encounter_dictation_suggestion_idx" ON "encounter_dictation_suggestion" USING btree ("organization_id","encounter_id","status");--> statement-breakpoint
CREATE INDEX "encounter_plan_item_plan_item_idx" ON "encounter_plan_item" USING btree ("plan_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_site_encounter_site_uidx" ON "encounter_site" USING btree ("encounter_id","site_system","site_code");--> statement-breakpoint
CREATE INDEX "imaging_measurement_org_document_idx" ON "imaging_measurement" USING btree ("organization_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_study_org_document_uidx" ON "imaging_study" USING btree ("organization_id","document_id");--> statement-breakpoint
CREATE INDEX "imaging_study_org_patient_study_idx" ON "imaging_study" USING btree ("organization_id","patient_id","study_instance_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_study_file_sop_uidx" ON "imaging_study_file" USING btree ("document_id","sop_instance_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_id_uidx" ON "patient" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_person_uidx" ON "patient" USING btree ("organization_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_org_number_uidx" ON "patient" USING btree ("organization_id","patient_number");--> statement-breakpoint
CREATE INDEX "patient_allergy_org_patient_idx" ON "patient_allergy" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_anamnesis_patient_version_uidx" ON "patient_anamnesis" USING btree ("patient_id","version");--> statement-breakpoint
CREATE INDEX "patient_anamnesis_org_patient_idx" ON "patient_anamnesis" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_charge_org_id_uidx" ON "patient_charge" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "patient_charge_original_idx" ON "patient_charge" USING btree ("organization_id","original_charge_id") WHERE "original_charge_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_charge_org_request_key_uidx" ON "patient_charge" USING btree ("organization_id","request_key") WHERE "request_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "patient_charge_org_patient_idx" ON "patient_charge" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_charge_item_idx" ON "patient_charge" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "patient_charge_budget_item_idx" ON "patient_charge" USING btree ("organization_id","budget_item_id");--> statement-breakpoint
CREATE INDEX "patient_condition_org_patient_idx" ON "patient_condition" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_org_patient_contact_uidx" ON "patient_contact" USING btree ("organization_id","patient_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_self_patient_uidx" ON "patient_contact" USING btree ("organization_id","patient_id") WHERE "patient_contact"."relationship" = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_self_contact_uidx" ON "patient_contact" USING btree ("organization_id","contact_id") WHERE "patient_contact"."relationship" = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contact_preferred_uidx" ON "patient_contact" USING btree ("organization_id","patient_id") WHERE "patient_contact"."is_preferred";--> statement-breakpoint
CREATE INDEX "patient_data_consent_org_patient_idx" ON "patient_data_consent" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_data_request_org_patient_idx" ON "patient_data_request" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_data_request_org_pending_idx" ON "patient_data_request" USING btree ("organization_id","due_on") WHERE "patient_data_request"."status" = 'pendiente';--> statement-breakpoint
CREATE INDEX "patient_document_org_patient_idx" ON "patient_document" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_document_org_id_uidx" ON "patient_document" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_document_context_document_version_uidx" ON "patient_document_context" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "patient_document_context_org_patient_idx" ON "patient_document_context" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_document_context_document_idx" ON "patient_document_context" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "patient_family_history_org_patient_idx" ON "patient_family_history" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_medication_org_patient_idx" ON "patient_medication" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_payment_org_patient_idx" ON "patient_payment" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_org_id_uidx" ON "patient_payment_application" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "payment_application_org_patient_idx" ON "patient_payment_application" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_application_payment_idx" ON "patient_payment_application" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_application_charge_idx" ON "patient_payment_application" USING btree ("organization_id","charge_id");--> statement-breakpoint
CREATE INDEX "payment_refund_org_patient_idx" ON "patient_payment_refund" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_refund_payment_idx" ON "patient_payment_refund" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "patient_record_opening_org_patient_idx" ON "patient_record_opening" USING btree ("organization_id","patient_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_org_patient_uidx" ON "patient_registration" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_submission_uidx" ON "patient_registration" USING btree ("organization_id","submission_id") WHERE "patient_registration"."submission_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_link_org_id_uidx" ON "patient_registration_link" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_registration_link_token_uidx" ON "patient_registration_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "patient_responsibility_org_patient_idx" ON "patient_responsibility" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_responsibility_active_uidx" ON "patient_responsibility" USING btree ("organization_id","patient_id","contact_id","kind") WHERE "patient_responsibility"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_id_uidx" ON "payment_return" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_number_uidx" ON "payment_return" USING btree ("organization_id","return_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_request_uidx" ON "payment_return" USING btree ("organization_id","request_id");--> statement-breakpoint
CREATE INDEX "payment_return_org_ticket_idx" ON "payment_return" USING btree ("organization_id","ticket_id");--> statement-breakpoint
CREATE INDEX "payment_return_org_patient_idx" ON "payment_return" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_ticket_org_patient_idx" ON "payment_ticket" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_ticket_org_branch_idx" ON "payment_ticket" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ticket_org_number_uidx" ON "payment_ticket" USING btree ("organization_id","ticket_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ticket_org_request_uidx" ON "payment_ticket" USING btree ("organization_id","request_id") WHERE "payment_ticket"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_org_number_uidx" ON "prescription" USING btree ("organization_id","prescription_number");--> statement-breakpoint
CREATE INDEX "prescription_org_patient_idx" ON "prescription" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "prescription_encounter_idx" ON "prescription" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE INDEX "prescription_item_idx" ON "prescription" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "prescription_item_org_patient_idx" ON "prescription_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "prescription_item_prescription_idx" ON "prescription_item" USING btree ("prescription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_catalog_release_current_uidx" ON "catalog"."procedure_catalog_release" USING btree ("system_key") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "procedure_code_system_code_idx" ON "catalog"."procedure_code" USING btree ("system_key","code");--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_org_code_uidx" ON "service_catalog" USING btree ("organization_id","code") WHERE "code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_org_id_finance_uidx" ON "service_catalog" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "service_catalog_org_active_idx" ON "service_catalog" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "service_catalog_org_specialty_idx" ON "service_catalog" USING btree ("organization_id","specialty_id");--> statement-breakpoint
CREATE INDEX "service_catalog_template_idx" ON "service_catalog" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_org_number_uidx" ON "treatment_budget" USING btree ("organization_id","budget_number","revision_number");--> statement-breakpoint
CREATE INDEX "treatment_budget_org_patient_idx" ON "treatment_budget" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_org_plan_idx" ON "treatment_budget" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_org_id_uidx" ON "treatment_budget" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_org_patient_id_uidx" ON "treatment_budget" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_one_draft_uidx" ON "treatment_budget" USING btree ("organization_id","patient_id") WHERE status = 'borrador' AND supersedes_budget_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_item_option_plan_uidx" ON "treatment_budget_item" USING btree ("option_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_patient_idx" ON "treatment_budget_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_budget_idx" ON "treatment_budget_item" USING btree ("organization_id","budget_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_plan_idx" ON "treatment_budget_item" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_promotion_idx" ON "treatment_budget_item" USING btree ("organization_id","promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_org_budget_id_uidx" ON "treatment_budget_option" USING btree ("organization_id","budget_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_position_uidx" ON "treatment_budget_option" USING btree ("budget_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_recommended_uidx" ON "treatment_budget_option" USING btree ("budget_id") WHERE is_recommended;--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_budget_option_chosen_uidx" ON "treatment_budget_option" USING btree ("budget_id") WHERE decision = 'elegida';--> statement-breakpoint
CREATE INDEX "treatment_budget_option_org_patient_idx" ON "treatment_budget_option" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_org_patient_idx" ON "treatment_plan" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_patient_idx" ON "treatment_plan_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_service_idx" ON "treatment_plan_item" USING btree ("organization_id","service_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_budget_idx" ON "treatment_plan_item" USING btree ("organization_id","budget_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_item_org_plan_idx" ON "treatment_plan_item" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_plan_item_org_patient_id_uidx" ON "treatment_plan_item" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_key_uidx" ON "catalog"."treatment_template" USING btree ("key");--> statement-breakpoint
CREATE INDEX "treatment_template_code_reverse_idx" ON "catalog"."treatment_template_code" USING btree ("system_key","code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_template_code_list_uidx" ON "catalog"."treatment_template_code" USING btree ("template_id","system_key","version");--> statement-breakpoint
CREATE INDEX "consumer_complaint_status_idx" ON "admin"."consumer_complaint" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_note_org_id_uidx" ON "crm_note" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "crm_note_org_contact_created_idx" ON "crm_note" USING btree ("organization_id","contact_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crm_note_org_conversation_idx" ON "crm_note" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "crm_note_org_opportunity_idx" ON "crm_note" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connection_provider_external_uidx" ON "channel_connection" USING btree ("provider","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE INDEX "channel_connection_account_idx" ON "channel_connection" USING btree ("provider","account_external_id") WHERE "account_external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_template_connection_name_language_uidx" ON "channel_template" USING btree ("connection_id","name","language");--> statement-breakpoint
CREATE INDEX "channel_template_org_message_idx" ON "channel_template" USING btree ("organization_id","message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_org_id_uidx" ON "clinic_message" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_org_key_uidx" ON "clinic_message" USING btree ("organization_id","key") WHERE "key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_version_message_number_uidx" ON "clinic_message_version" USING btree ("message_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_message_version_org_template_uidx" ON "clinic_message_version" USING btree ("organization_id","template_name");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_org_id_uidx" ON "contact" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_org_doc_uidx" ON "contact" USING btree ("organization_id","doc_country","doc_type","doc_number") WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_org_screen_idx" ON "contact" USING btree ("organization_id","screen") WHERE "screen" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_org_locked_idx" ON "contact" USING btree ("organization_id") WHERE "record_locked_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identity_org_id_uidx" ON "contact_identity" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identity_org_channel_user_uidx" ON "contact_identity" USING btree ("organization_id","channel","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_org_id_uidx" ON "conversation" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_connection_thread_uidx" ON "conversation" USING btree ("channel_connection_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "conversation_org_last_message_idx" ON "conversation" USING btree ("organization_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_org_contact_idx" ON "conversation" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_id_uidx" ON "task" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_opp_open_uidx" ON "task" USING btree ("organization_id","opportunity_id") WHERE "opportunity_id" IS NOT NULL AND "status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "task_org_idempotency_uidx" ON "task" USING btree ("organization_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_org_contact_idx" ON "task" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "task_org_conversation_idx" ON "task" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "task_org_opportunity_idx" ON "task" USING btree ("organization_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "task_org_patient_idx" ON "task" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "task_org_status_due_idx" ON "task" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_def_org_key_uidx" ON "custom_field_def" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_event_provider_event_uidx" ON "inbound_event" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_id_uidx" ON "message" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_external_uidx" ON "message" USING btree ("conversation_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_org_created_idx" ON "message" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "message_held_idx" ON "message" USING btree ("organization_id","conversation_id") WHERE "status" = 'held';--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_org_default_uidx" ON "pipeline" USING btree ("organization_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_pipeline_position_uidx" ON "pipeline_stage" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_pipeline_moment_uidx" ON "pipeline_stage" USING btree ("pipeline_id","moment");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_hold_task_uidx" ON "registration_hold" USING btree ("organization_id","task_id");--> statement-breakpoint
CREATE INDEX "odontogram_assessment_org_patient_idx" ON "dental"."odontogram_assessment" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "odontogram_assessment_encounter_uidx" ON "dental"."odontogram_assessment" USING btree ("encounter_id") WHERE "encounter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "odontogram_entry_org_patient_tooth_idx" ON "dental"."odontogram_entry" USING btree ("organization_id","patient_id","tooth_number");--> statement-breakpoint
CREATE UNIQUE INDEX "odontogram_entry_org_patient_id_uidx" ON "dental"."odontogram_entry" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "periodontal_chart_encounter_uidx" ON "dental"."periodontal_chart" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periodontal_chart_org_id_uidx" ON "dental"."periodontal_chart" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "periodontal_chart_org_patient_idx" ON "dental"."periodontal_chart" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periodontal_tooth_chart_tooth_uidx" ON "dental"."periodontal_tooth" USING btree ("chart_id","tooth_number");--> statement-breakpoint
CREATE INDEX "plan_item_finding_entry_idx" ON "dental"."plan_item_finding" USING btree ("odontogram_entry_id");--> statement-breakpoint
CREATE INDEX "cash_closure_org_branch_idx" ON "cash_closure" USING btree ("organization_id","branch_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closure_shift_uidx" ON "cash_closure" USING btree ("organization_id","shift_id");--> statement-breakpoint
CREATE INDEX "cash_movement_org_shift_idx" ON "cash_movement" USING btree ("organization_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_payment_uidx" ON "cash_movement" USING btree ("organization_id","patient_payment_id") WHERE "cash_movement"."patient_payment_id" IS NOT NULL AND "cash_movement"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cash_shift_org_branch_idx" ON "cash_shift" USING btree ("organization_id","branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_shift_open_uidx" ON "cash_shift" USING btree ("organization_id","branch_id","currency") WHERE status = 'abierta';--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rule_org_prof_uidx" ON "commission_rule" USING btree ("organization_id","professional_user_id");--> statement-breakpoint
CREATE INDEX "commission_settlement_month_idx" ON "commission_settlement" USING btree ("organization_id","professional_user_id","period_year","period_month");--> statement-breakpoint
CREATE INDEX "commission_line_org_settlement_idx" ON "commission_settlement_line" USING btree ("organization_id","settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_line_source_uidx" ON "commission_settlement_line" USING btree ("organization_id","source_key") WHERE "commission_settlement_line"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expense_org_branch_spent_idx" ON "expense" USING btree ("organization_id","branch_id","spent_at");--> statement-breakpoint
CREATE INDEX "expense_org_purchase_idx" ON "expense" USING btree ("organization_id","purchase_order_id") WHERE "expense"."purchase_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_org_slug_uidx" ON "branch" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_org_id_finance_uidx" ON "branch" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "help_ask_user_date_idx" ON "help_ask" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "home_visit_user_uidx" ON "home_visit" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_notice_user_version_uidx" ON "admin"."legal_notice" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_agreement_acceptance_version_uidx" ON "processing_agreement_acceptance" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_notification_recipient_key_uidx" ON "workspace_notification" USING btree ("organization_id","user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "workspace_notification_recipient_date_idx" ON "workspace_notification" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_notification_subject_idx" ON "workspace_notification" USING btree ("organization_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "product_org_id_uidx" ON "product" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_org_sku_uidx" ON "product" USING btree ("organization_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lot_org_id_uidx" ON "product_lot" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lot_org_product_warehouse_code_uidx" ON "product_lot" USING btree ("organization_id","product_id","warehouse_id","code");--> statement-breakpoint
CREATE INDEX "product_lot_org_product_idx" ON "product_lot" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "product_lot_org_expires_idx" ON "product_lot" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_minimum_org_product_branch_uidx" ON "product_minimum" USING btree ("organization_id","product_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_org_id_uidx" ON "purchase_order" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_org_number_uidx" ON "purchase_order" USING btree ("organization_id","order_number");--> statement-breakpoint
CREATE INDEX "purchase_order_org_supplier_idx" ON "purchase_order" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_order_org_status_idx" ON "purchase_order" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_line_org_order_product_uidx" ON "purchase_order_line" USING btree ("organization_id","order_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_material_org_service_product_uidx" ON "service_material" USING btree ("organization_id","service_id","product_id");--> statement-breakpoint
CREATE INDEX "service_material_org_product_idx" ON "service_material" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_org_id_uidx" ON "stock_movement" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_org_idempotency_uidx" ON "stock_movement" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_movement_org_product_idx" ON "stock_movement" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movement_org_warehouse_idx" ON "stock_movement" USING btree ("organization_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movement_org_patient_idx" ON "stock_movement" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "stock_movement_org_encounter_idx" ON "stock_movement" USING btree ("organization_id","encounter_id") WHERE "stock_movement"."encounter_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movement_org_charge_idx" ON "stock_movement" USING btree ("organization_id","charge_id") WHERE "stock_movement"."charge_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movement_org_purchase_idx" ON "stock_movement" USING btree ("organization_id","purchase_order_id") WHERE "stock_movement"."purchase_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_shortage_org_product_warehouse_uidx" ON "stock_shortage" USING btree ("organization_id","product_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_id_uidx" ON "supplier" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_doc_uidx" ON "supplier" USING btree ("organization_id","doc_type","doc_number") WHERE "doc_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_credit_use_org_supplier_idx" ON "supplier_credit_use" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_use_org_order_idx" ON "supplier_credit_use" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_org_id_uidx" ON "warehouse" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "warehouse_org_branch_idx" ON "warehouse" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_branch_default_uidx" ON "warehouse" USING btree ("organization_id","branch_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_org_id_uidx" ON "opportunity" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "opportunity_org_contact_idx" ON "opportunity" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_patient_idx" ON "opportunity" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_stage_idx" ON "opportunity" USING btree ("organization_id","stage_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_status_idx" ON "opportunity" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "opportunity_org_assigned_idx" ON "opportunity" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "opportunity_org_conversation_idx" ON "opportunity" USING btree ("organization_id","conversation_id");--> statement-breakpoint
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
CREATE INDEX "portal_session_org_grant_idx" ON "portal_session" USING btree ("organization_id","grant_id");--> statement-breakpoint
CREATE INDEX "portal_session_org_expires_idx" ON "portal_session" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "portal_challenge_org_expires_idx" ON "portal_challenge" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_grant_org_id_uidx" ON "portal_grant" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_grant_org_pair_active_uidx" ON "portal_grant" USING btree ("organization_id","patient_id","contact_id") WHERE "status" = 'activo';--> statement-breakpoint
CREATE INDEX "portal_grant_org_patient_idx" ON "portal_grant" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "portal_grant_org_contact_idx" ON "portal_grant" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_passkey_org_id_uidx" ON "portal_passkey" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "portal_passkey_org_grant_idx" ON "portal_passkey" USING btree ("organization_id","grant_id");--> statement-breakpoint
CREATE INDEX "portal_verification_org_pair_idx" ON "portal_verification" USING btree ("organization_id","patient_id","contact_id");--> statement-breakpoint
CREATE INDEX "webchat_rate_limit_window_idx" ON "webchat_rate_limit" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "webchat_site_connection_origin_uidx" ON "webchat_site" USING btree ("connection_id","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_payment_method_org_id_uidx" ON "organization_payment_method" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "organization_payment_method_org_active_idx" ON "organization_payment_method" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "organization_payment_method_org_sort_idx" ON "organization_payment_method" USING btree ("organization_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "promotion_org_active_idx" ON "promotion" USING btree ("organization_id","is_active","starts_at");--> statement-breakpoint
CREATE INDEX "promotion_org_ends_idx" ON "promotion" USING btree ("organization_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_service_price_promo_service_uidx" ON "promotion_service_price" USING btree ("promotion_id","service_id");--> statement-breakpoint
CREATE INDEX "promotion_service_price_org_service_idx" ON "promotion_service_price" USING btree ("organization_id","service_id");--> statement-breakpoint
CREATE INDEX "promotion_service_price_org_promo_idx" ON "promotion_service_price" USING btree ("organization_id","promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_action_org_dedupe_uidx" ON "saas_action" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "saas_action_org_occurred_idx" ON "saas_action" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "saas_action_org_charge_idx" ON "saas_action" USING btree ("organization_id","charge_id");--> statement-breakpoint
CREATE INDEX "saas_action_org_contact_idx" ON "saas_action" USING btree ("organization_id","contact_id","kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_action_review_action_uidx" ON "saas_action_review" USING btree ("organization_id","action_id");--> statement-breakpoint
CREATE INDEX "saas_action_review_status_idx" ON "saas_action_review" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "saas_charge_org_period_idx" ON "saas_charge" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "saas_charge_org_status_idx" ON "saas_charge" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_charge_org_dedupe_uidx" ON "saas_charge" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "saas_charge_line_charge_idx" ON "saas_charge_line" USING btree ("organization_id","charge_id","sort_order");--> statement-breakpoint
CREATE INDEX "saas_settlement_seller_period_idx" ON "admin"."saas_commission_settlement" USING btree ("seller_id","period_year","period_month");--> statement-breakpoint
CREATE INDEX "saas_settlement_line_settlement_idx" ON "admin"."saas_commission_settlement_line" USING btree ("settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_settlement_line_source_uidx" ON "admin"."saas_commission_settlement_line" USING btree ("source_key") WHERE "admin"."saas_commission_settlement_line"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "saas_negotiation_org_status_idx" ON "admin"."saas_negotiation" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "saas_payment_org_charge_idx" ON "saas_payment" USING btree ("organization_id","charge_id");--> statement-breakpoint
CREATE INDEX "saas_payment_org_status_idx" ON "saas_payment" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_plan_default_uidx" ON "admin"."saas_plan" USING btree ("is_default") WHERE "admin"."saas_plan"."is_default";--> statement-breakpoint
CREATE INDEX "saas_plan_currency_active_idx" ON "admin"."saas_plan" USING btree ("currency","is_active");--> statement-breakpoint
CREATE INDEX "saas_seller_commission_seller_status_idx" ON "admin"."saas_seller_commission" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "saas_subscription_status_idx" ON "saas_subscription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "saas_subscription_period_end_idx" ON "saas_subscription" USING btree ("current_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_waitlist_request_token_uidx" ON "admin"."saas_waitlist_request" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_waitlist_request_org_uidx" ON "admin"."saas_waitlist_request" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "saas_waitlist_request_status_idx" ON "admin"."saas_waitlist_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "saas_waitlist_request_email_idx" ON "admin"."saas_waitlist_request" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_usage_day_org_day_uidx" ON "storage_usage_day" USING btree ("organization_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "report_digest_user_uidx" ON "report_digest" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_digest_send_week_uidx" ON "report_digest_send" USING btree ("organization_id","user_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "report_goal_month_uidx" ON "report_goal" USING btree ("organization_id","metric","from_month");--> statement-breakpoint
CREATE UNIQUE INDEX "report_pin_question_uidx" ON "report_pin" USING btree ("organization_id","figure","group_by","focus");--> statement-breakpoint
CREATE UNIQUE INDEX "report_pin_argos_uidx" ON "report_pin" USING btree ("organization_id",md5("argos" ->> 'sql')) WHERE "report_pin"."argos" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "report_question_org_date_idx" ON "report_question" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "admin"."admin_invitation" ADD CONSTRAINT "admin_invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_invitation" ADD CONSTRAINT "admin_invitation_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_session_verification" ADD CONSTRAINT "admin_session_verification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD CONSTRAINT "admin_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."account_lifecycle_notice" ADD CONSTRAINT "account_lifecycle_notice_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."account_recovery_case" ADD CONSTRAINT "account_recovery_case_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."account_recovery_case" ADD CONSTRAINT "account_recovery_case_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."account_recovery_case" ADD CONSTRAINT "account_recovery_case_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."user_global_block" ADD CONSTRAINT "user_global_block_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."user_global_block" ADD CONSTRAINT "user_global_block_blocked_by_fkey" FOREIGN KEY ("blocked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."user_global_block" ADD CONSTRAINT "user_global_block_unblocked_by_fkey" FOREIGN KEY ("unblocked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_grant_id_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_access_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_audit" ADD CONSTRAINT "support_access_audit_grant_case_org_fk" FOREIGN KEY ("grant_id","case_id","organization_id") REFERENCES "public"."support_access_grant"("id","case_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant" ADD CONSTRAINT "support_access_grant_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_message_case_fk" FOREIGN KEY ("message_id","case_id") REFERENCES "public"."support_message"("id","case_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_assignee_staff_id_user_id_fk" FOREIGN KEY ("assignee_staff_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_case_id_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notice" ADD CONSTRAINT "support_notice_case_org_fk" FOREIGN KEY ("case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_room_id_schedule_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."schedule_room"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_arrived_by_user_id_fk" FOREIGN KEY ("arrived_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_use" ADD CONSTRAINT "calendar_feed_use_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_use" ADD CONSTRAINT "calendar_feed_use_organization_id_feed_id_calendar_feed_organization_id_id_fk" FOREIGN KEY ("organization_id","feed_id") REFERENCES "public"."calendar_feed"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_room" ADD CONSTRAINT "schedule_room_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_room" ADD CONSTRAINT "schedule_room_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_answer_trace" ADD CONSTRAINT "agent_answer_trace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_answer_trace" ADD CONSTRAINT "agent_answer_trace_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_case_memory" ADD CONSTRAINT "agent_case_memory_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_case_memory" ADD CONSTRAINT "agent_case_memory_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decision_log" ADD CONSTRAINT "agent_decision_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoff" ADD CONSTRAINT "agent_handoff_conversation_id_source_message_id_message_conversation_id_id_fk" FOREIGN KEY ("conversation_id","source_message_id") REFERENCES "public"."message"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD CONSTRAINT "agent_knowledge_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_entry" ADD CONSTRAINT "agent_knowledge_entry_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_gap" ADD CONSTRAINT "agent_knowledge_gap_resolved_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("resolved_entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" ADD CONSTRAINT "agent_knowledge_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revision" ADD CONSTRAINT "agent_knowledge_revision_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_review_item_id_agent_review_item_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."agent_review_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson" ADD CONSTRAINT "agent_lesson_knowledge_entry_id_agent_knowledge_entry_id_fk" FOREIGN KEY ("knowledge_entry_id") REFERENCES "public"."agent_knowledge_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_person_fact" ADD CONSTRAINT "agent_person_fact_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_item" ADD CONSTRAINT "agent_review_item_trace_id_agent_answer_trace_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."agent_answer_trace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_ledger" ADD CONSTRAINT "agent_run_ledger_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_search_item" ADD CONSTRAINT "agent_search_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_lesson_id_agent_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."agent_lesson"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_consent" ADD CONSTRAINT "automation_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_job" ADD CONSTRAINT "automation_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_job" ADD CONSTRAINT "automation_job_rule_id_automation_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_link_token" ADD CONSTRAINT "automation_link_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_link_token" ADD CONSTRAINT "automation_link_token_job_id_automation_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."automation_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD CONSTRAINT "professional_schedule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_room_id_schedule_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."schedule_room"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_block" ADD CONSTRAINT "schedule_block_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_response_id_clinical_form_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."clinical_form_response"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_addendum" ADD CONSTRAINT "clinical_form_addendum_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_template_id_clinical_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."clinical_form_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_response" ADD CONSTRAINT "clinical_form_response_discarded_by_user_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_form_template" ADD CONSTRAINT "clinical_form_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_completed_by_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_template_id_consent_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."consent_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_informed_by_user_id_fk" FOREIGN KEY ("informed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document" ADD CONSTRAINT "consent_document_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_document_id_consent_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."consent_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template" ADD CONSTRAINT "consent_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template_service" ADD CONSTRAINT "consent_template_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_template_service" ADD CONSTRAINT "consent_template_service_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_specialty" ADD CONSTRAINT "org_specialty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_specialty_id_org_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."org_specialty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_specialty" ADD CONSTRAINT "professional_specialty_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_plan_item" ADD CONSTRAINT "appointment_plan_item_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_origin_encounter_id_encounter_id_fk" FOREIGN KEY ("origin_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_completed_encounter_id_encounter_id_fk" FOREIGN KEY ("completed_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_repeats_from_id_clinical_follow_up_id_fk" FOREIGN KEY ("repeats_from_id") REFERENCES "public"."clinical_follow_up"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."diagnosis_code" ADD CONSTRAINT "diagnosis_code_system_key_diagnosis_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."diagnosis_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."diagnosis_code" ADD CONSTRAINT "diagnosis_code_release_fk" FOREIGN KEY ("system_key","edition") REFERENCES "catalog"."diagnosis_code_release"("system_key","edition") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."diagnosis_code_release" ADD CONSTRAINT "diagnosis_code_release_system_key_diagnosis_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."diagnosis_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_finalized_by_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_fk" FOREIGN KEY ("organization_id","patient_id","appointment_id") REFERENCES "public"."appointment"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_legacy_note_id_clinical_note_id_fk" FOREIGN KEY ("legacy_note_id") REFERENCES "public"."clinical_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_diagnosis" ADD CONSTRAINT "encounter_diagnosis_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" ADD CONSTRAINT "encounter_dictation_suggestion_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_plan_item" ADD CONSTRAINT "encounter_plan_item_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_site" ADD CONSTRAINT "encounter_site_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_site" ADD CONSTRAINT "encounter_site_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_measurement" ADD CONSTRAINT "imaging_measurement_study_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."imaging_study"("organization_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study" ADD CONSTRAINT "imaging_study_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."patient_document"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study_file" ADD CONSTRAINT "imaging_study_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_study_file" ADD CONSTRAINT "imaging_study_file_study_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."imaging_study"("organization_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_counter" ADD CONSTRAINT "org_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_registered_branch_id_branch_id_fk" FOREIGN KEY ("registered_branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_health_reviewed_by_user_id_fk" FOREIGN KEY ("health_reviewed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_allergies_reviewed_by_user_id_fk" FOREIGN KEY ("allergies_reviewed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_person_fk" FOREIGN KEY ("organization_id","person_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_anamnesis" ADD CONSTRAINT "patient_anamnesis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_anamnesis" ADD CONSTRAINT "patient_anamnesis_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_anamnesis" ADD CONSTRAINT "patient_anamnesis_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_budget_item_id_treatment_budget_item_id_fk" FOREIGN KEY ("budget_item_id") REFERENCES "public"."treatment_budget_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_organization_id_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_granted_by_contact_id_contact_id_fk" FOREIGN KEY ("granted_by_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_consent" ADD CONSTRAINT "patient_data_consent_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_requester_fk" FOREIGN KEY ("organization_id","patient_id","requester_contact_id") REFERENCES "public"."patient_contact"("organization_id","patient_id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_document_id_patient_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."patient_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_follow_up_id_clinical_follow_up_id_fk" FOREIGN KEY ("follow_up_id") REFERENCES "public"."clinical_follow_up"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_ticket_id_payment_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."payment_ticket"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_payer_contact_id_contact_id_fk" FOREIGN KEY ("payer_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_ticket_id_payment_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."payment_ticket"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_context_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","context_contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_conversation_id_conversation_organization_id_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_organization_id_link_id_patient_registration_link_organization_id_id_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."patient_registration_link"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_contact_id_contact_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_link" ADD CONSTRAINT "patient_registration_link_organization_id_conversation_id_conversation_organization_id_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_evidence_document_id_patient_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."patient_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_contact_fk" FOREIGN KEY ("organization_id","patient_id","contact_id") REFERENCES "public"."patient_contact"("organization_id","patient_id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_payer_contact_id_contact_id_fk" FOREIGN KEY ("payer_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."procedure_catalog_release" ADD CONSTRAINT "procedure_catalog_release_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."procedure_code" ADD CONSTRAINT "procedure_code_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."procedure_code_product" ADD CONSTRAINT "procedure_code_product_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "catalog"."treatment_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_evaluation_service_id_service_catalog_id_fk" FOREIGN KEY ("evaluation_service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_specialty_fk" FOREIGN KEY ("organization_id","specialty_id") REFERENCES "public"."org_specialty"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_procedure_fk" FOREIGN KEY ("procedure_system","procedure_code","procedure_version") REFERENCES "catalog"."procedure_code"("system_key","code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_counter" ADD CONSTRAINT "ticket_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_supersedes_budget_id_treatment_budget_id_fk" FOREIGN KEY ("supersedes_budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decision_contact_id_contact_id_fk" FOREIGN KEY ("decision_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget" ADD CONSTRAINT "treatment_budget_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_option_fk" FOREIGN KEY ("organization_id","budget_id","option_id") REFERENCES "public"."treatment_budget_option"("organization_id","budget_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_budget_option" ADD CONSTRAINT "treatment_budget_option_budget_fk" FOREIGN KEY ("organization_id","patient_id","budget_id") REFERENCES "public"."treatment_budget"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_origin_encounter_id_encounter_id_fk" FOREIGN KEY ("origin_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD CONSTRAINT "treatment_plan_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_plan_id_treatment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_supersedes_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("supersedes_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_decided_by_contact_id_contact_id_fk" FOREIGN KEY ("decided_by_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_source_encounter_id_encounter_id_fk" FOREIGN KEY ("source_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ADD CONSTRAINT "treatment_plan_item_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template_code" ADD CONSTRAINT "treatment_template_code_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "catalog"."treatment_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."treatment_template_code" ADD CONSTRAINT "treatment_template_code_system_key_code_version_procedure_code_system_key_code_version_fk" FOREIGN KEY ("system_key","code","version") REFERENCES "catalog"."procedure_code"("system_key","code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."consumer_complaint" ADD CONSTRAINT "consumer_complaint_responded_by_user_id_user_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_note" ADD CONSTRAINT "crm_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_template" ADD CONSTRAINT "channel_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_template" ADD CONSTRAINT "channel_template_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message" ADD CONSTRAINT "clinic_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message" ADD CONSTRAINT "clinic_message_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_message_version" ADD CONSTRAINT "clinic_message_version_organization_id_message_id_clinic_message_organization_id_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."clinic_message"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_screened_by_user_id_user_id_fk" FOREIGN KEY ("screened_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_not_spam_by_user_id_user_id_fk" FOREIGN KEY ("not_spam_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_record_locked_by_user_id_fk" FOREIGN KEY ("record_locked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_channel_connection_id_channel_connection_id_fk" FOREIGN KEY ("channel_connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organization_id_contact_identity_id_contact_identity_organization_id_id_fk" FOREIGN KEY ("organization_id","contact_identity_id") REFERENCES "public"."contact_identity"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_def" ADD CONSTRAINT "custom_field_def_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_reply_to_message_id_message_conversation_id_id_fk" FOREIGN KEY ("conversation_id","reply_to_message_id") REFERENCES "public"."message"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_pipeline_id_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipeline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_hold" ADD CONSTRAINT "registration_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_hold" ADD CONSTRAINT "registration_hold_organization_id_task_id_task_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."dental_template_rule" ADD CONSTRAINT "dental_template_rule_template_id_treatment_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "catalog"."treatment_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_assessment" ADD CONSTRAINT "odontogram_assessment_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_resolved_by_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("resolved_by_plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_entry" ADD CONSTRAINT "odontogram_entry_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_chart" ADD CONSTRAINT "periodontal_chart_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_chart" ADD CONSTRAINT "periodontal_chart_classified_by_user_id_fk" FOREIGN KEY ("classified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_chart" ADD CONSTRAINT "periodontal_chart_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_chart" ADD CONSTRAINT "periodontal_chart_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."periodontal_tooth" ADD CONSTRAINT "periodontal_tooth_chart_fk" FOREIGN KEY ("organization_id","chart_id") REFERENCES "dental"."periodontal_chart"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_plan_item_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."plan_item_finding" ADD CONSTRAINT "plan_item_finding_entry_fk" FOREIGN KEY ("organization_id","patient_id","odontogram_entry_id") REFERENCES "dental"."odontogram_entry"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."service_finding" ADD CONSTRAINT "service_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."service_finding" ADD CONSTRAINT "service_finding_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."service_catalog"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_patient_payment_id_patient_payment_id_fk" FOREIGN KEY ("patient_payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_professional_user_id_user_id_fk" FOREIGN KEY ("professional_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_settled_by_user_id_fk" FOREIGN KEY ("settled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_settlement_id_commission_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."commission_settlement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_application_id_patient_payment_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."patient_payment_application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_purchase_order_id_purchase_order_organization_id_id_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_lookup_day" ADD CONSTRAINT "address_lookup_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_registration_config" ADD CONSTRAINT "patient_registration_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visit" ADD CONSTRAINT "home_visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visit" ADD CONSTRAINT "home_visit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."legal_notice" ADD CONSTRAINT "legal_notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_agreement_acceptance" ADD CONSTRAINT "processing_agreement_acceptance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_agreement_acceptance" ADD CONSTRAINT "processing_agreement_acceptance_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot" ADD CONSTRAINT "product_lot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "public"."branch"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."service_catalog"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_lot_id_product_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_dest_warehouse_id_warehouse_id_fk" FOREIGN KEY ("dest_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organization_id_patient_id_patient_organization_id_id_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_charge_fk" FOREIGN KEY ("organization_id","charge_id") REFERENCES "public"."patient_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_warehouse_fk" FOREIGN KEY ("organization_id","warehouse_id") REFERENCES "public"."warehouse"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_supplier_id_supplier_organization_id_id_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."supplier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_order_id_purchase_order_organization_id_id_fk" FOREIGN KEY ("organization_id","order_id") REFERENCES "public"."purchase_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_pipeline_id_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipeline"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_from_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_to_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_event" ADD CONSTRAINT "opportunity_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_session_id_portal_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."portal_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_delivery_conversation_id_conversation_id_fk" FOREIGN KEY ("delivery_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_delivery_message_id_message_id_fk" FOREIGN KEY ("delivery_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link" ADD CONSTRAINT "portal_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_link_id_portal_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."portal_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_passkey_id_portal_passkey_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."portal_passkey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_challenge" ADD CONSTRAINT "portal_challenge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_challenge" ADD CONSTRAINT "portal_challenge_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_passkey" ADD CONSTRAINT "portal_passkey_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_verification" ADD CONSTRAINT "portal_verification_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_oauth_state" ADD CONSTRAINT "mailbox_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_site" ADD CONSTRAINT "webchat_site_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_payment_method" ADD CONSTRAINT "organization_payment_method_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_promotion_id_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action" ADD CONSTRAINT "saas_action_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_action_id_saas_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."saas_action"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_decided_by_staff_id_user_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_case_fk" FOREIGN KEY ("support_case_id","organization_id") REFERENCES "public"."support_case"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_action_review" ADD CONSTRAINT "saas_action_review_credit_charge_fk" FOREIGN KEY ("organization_id","credit_charge_id") REFERENCES "public"."saas_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "admin"."saas_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_charge_fk" FOREIGN KEY ("organization_id","charge_id") REFERENCES "public"."saas_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commercial_terms" ADD CONSTRAINT "saas_commercial_terms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_commission_id_fkey" FOREIGN KEY ("commission_id") REFERENCES "admin"."saas_seller_commission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin"."saas_seller"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_adjustment" ADD CONSTRAINT "saas_commission_adjustment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement" ADD CONSTRAINT "saas_commission_settlement_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin"."saas_seller"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement" ADD CONSTRAINT "saas_commission_settlement_settled_by_fkey" FOREIGN KEY ("settled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement" ADD CONSTRAINT "saas_commission_settlement_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" ADD CONSTRAINT "saas_commission_settlement_line_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "admin"."saas_commission_settlement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" ADD CONSTRAINT "saas_commission_settlement_line_commission_id_fkey" FOREIGN KEY ("commission_id") REFERENCES "admin"."saas_seller_commission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" ADD CONSTRAINT "saas_commission_settlement_line_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "admin"."saas_commission_adjustment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_commission_settlement_line" ADD CONSTRAINT "saas_settlement_line_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_negotiation" ADD CONSTRAINT "saas_negotiation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_negotiation" ADD CONSTRAINT "saas_negotiation_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_negotiation" ADD CONSTRAINT "saas_negotiation_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_notice" ADD CONSTRAINT "saas_notice_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_reversed_by_fkey" FOREIGN KEY ("reversed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_payment" ADD CONSTRAINT "saas_payment_organization_id_charge_id_fkey" FOREIGN KEY ("organization_id","charge_id") REFERENCES "public"."saas_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_seller" ADD CONSTRAINT "saas_seller_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_seller_commission" ADD CONSTRAINT "saas_seller_commission_org_cascade_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_seller_commission" ADD CONSTRAINT "saas_seller_commission_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin"."saas_seller"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_seller_commission" ADD CONSTRAINT "saas_seller_commission_organization_id_payment_id_fkey" FOREIGN KEY ("organization_id","payment_id") REFERENCES "public"."saas_payment"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_signup_policy" ADD CONSTRAINT "saas_signup_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "admin"."saas_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD CONSTRAINT "saas_subscription_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin"."saas_seller"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_plan_id_saas_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "admin"."saas_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_usage_day" ADD CONSTRAINT "storage_usage_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest" ADD CONSTRAINT "report_digest_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest" ADD CONSTRAINT "report_digest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest_send" ADD CONSTRAINT "report_digest_send_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest_send" ADD CONSTRAINT "report_digest_send_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_goal" ADD CONSTRAINT "report_goal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_goal" ADD CONSTRAINT "report_goal_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pin" ADD CONSTRAINT "report_pin_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pin" ADD CONSTRAINT "report_pin_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_question" ADD CONSTRAINT "report_question_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_question" ADD CONSTRAINT "report_question_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
