CREATE TABLE "admin"."platform_backup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"step" text,
	"object" text,
	"size_bytes" bigint,
	"migrations" integer,
	"organizations" integer,
	"patients" integer,
	"detail" text,
	CONSTRAINT "platform_backup_status_check" CHECK ("admin"."platform_backup"."status" in ('verificado', 'fallido')),
	CONSTRAINT "platform_backup_step_check" CHECK ("admin"."platform_backup"."step" is null or "admin"."platform_backup"."step" in ('volcado', 'restauracion', 'comprobacion', 'subida')),
	CONSTRAINT "platform_backup_result_check" CHECK (("admin"."platform_backup"."status" = 'verificado' and "admin"."platform_backup"."object" is not null and "admin"."platform_backup"."migrations" is not null and "admin"."platform_backup"."step" is null) or ("admin"."platform_backup"."status" = 'fallido' and "admin"."platform_backup"."step" is not null))
);
--> statement-breakpoint
CREATE INDEX "platform_backup_finished_idx" ON "admin"."platform_backup" USING btree ("finished_at" DESC NULLS LAST);