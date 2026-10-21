CREATE TABLE "address_lookup_day" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"purpose" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "address_lookup_day_organization_id_day_purpose_pk" PRIMARY KEY("organization_id","day","purpose"),
	CONSTRAINT "address_lookup_day_purpose_check" CHECK ("address_lookup_day"."purpose" in ('sede', 'paciente')),
	CONSTRAINT "address_lookup_day_searches_check" CHECK ("address_lookup_day"."searches" >= 0)
);
--> statement-breakpoint
ALTER TABLE "address_lookup_day" ADD CONSTRAINT "address_lookup_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;