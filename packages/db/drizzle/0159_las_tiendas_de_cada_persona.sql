CREATE TABLE "auth"."app_place" (
	"app" text NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_place_pkey" PRIMARY KEY("app","ref"),
	CONSTRAINT "app_place_app_check" CHECK (app IN ('gestoria'))
);
--> statement-breakpoint
CREATE TABLE "auth"."app_place_member" (
	"app" text NOT NULL,
	"ref" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "app_place_member_pkey" PRIMARY KEY("app","ref","user_id"),
	CONSTRAINT "app_place_member_role_check" CHECK (role IN ('owner','admin','sales'))
);
--> statement-breakpoint
ALTER TABLE "auth"."app_place_member" ADD CONSTRAINT "app_place_member_place_fk" FOREIGN KEY ("app","ref") REFERENCES "auth"."app_place"("app","ref") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_place_member_user_idx" ON "auth"."app_place_member" USING btree ("user_id");--> statement-breakpoint
-- Reglas (ADR 0063 y 0217): las dos tablas no reciben nada del rol de la aplicación. La copia de
-- los lugares de otra app la escribe y la lee la conexión propietaria (el acuerdo, la cuenta).
REVOKE ALL ON TABLE auth.app_place, auth.app_place_member FROM dentalagent_app;