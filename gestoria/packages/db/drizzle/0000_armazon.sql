CREATE TABLE "account_copy" (
	"user_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"image" text,
	"state" text DEFAULT 'activa' NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_copy_state_check" CHECK (state IN ('activa','bloqueada','cerrada'))
);
--> statement-breakpoint
CREATE TABLE "account_event_receipt" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_name_check" CHECK (char_length(btrim("store"."name")) between 1 and 80),
	CONSTRAINT "store_currency_check" CHECK ("store"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "store_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"subject" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_event_action_check" CHECK (action IN ('tienda.creada','invitacion.creada','invitacion.anulada','invitacion.aceptada','equipo.rol','equipo.quitado','cuenta.cerrada'))
);
--> statement-breakpoint
CREATE TABLE "store_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "store_invitation_role_check" CHECK (role IN ('owner','admin','sales')),
	CONSTRAINT "store_invitation_email_check" CHECK ("store_invitation"."email" = lower("store_invitation"."email") and position('@' in "store_invitation"."email") > 1),
	CONSTRAINT "store_invitation_closed_check" CHECK (("store_invitation"."accepted_at" is null or "store_invitation"."accepted_by" is not null) and ("store_invitation"."revoked_at" is null or "store_invitation"."revoked_by" is not null) and ("store_invitation"."accepted_at" is null or "store_invitation"."revoked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "store_member" (
	"store_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_member_pkey" PRIMARY KEY("store_id","user_id"),
	CONSTRAINT "store_member_role_check" CHECK (role IN ('owner','admin','sales'))
);
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."account_copy"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_event" ADD CONSTRAINT "store_event_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD CONSTRAINT "store_invitation_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_invitation" ADD CONSTRAINT "store_invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."account_copy"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_member" ADD CONSTRAINT "store_member_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_member" ADD CONSTRAINT "store_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."account_copy"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_member" ADD CONSTRAINT "store_member_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."account_copy"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_copy_email_idx" ON "account_copy" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "account_copy_reviewed_idx" ON "account_copy" USING btree ("reviewed_at");--> statement-breakpoint
CREATE INDEX "store_event_store_idx" ON "store_event" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_invitation_pending_idx" ON "store_invitation" USING btree ("store_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "store_invitation_email_idx" ON "store_invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "store_member_user_idx" ON "store_member" USING btree ("user_id");