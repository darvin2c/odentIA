CREATE TABLE "home_visit" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"greeted_on" date
);
--> statement-breakpoint
ALTER TABLE "home_visit" ADD CONSTRAINT "home_visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visit" ADD CONSTRAINT "home_visit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "home_visit_user_uidx" ON "home_visit" USING btree ("organization_id","user_id");