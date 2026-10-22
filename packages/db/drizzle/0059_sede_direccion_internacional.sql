ALTER TABLE "branch" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "country" char(2);--> statement-breakpoint
-- La sede pasa a la forma de la dirección del paciente sin perder nada
-- (issue 36): lo que se guardaba como distrito es la ciudad o localidad, la
-- provincia es el nivel FHIR district, el departamento es la región y la
-- segunda línea se une a la primera. El país es el de la clínica. La 0060
-- retira las columnas viejas.
UPDATE "branch" SET
  "city" = "district",
  "district" = "province",
  "region" = "department",
  "address_line1" = CASE
    WHEN nullif(trim("address_line2"), '') IS NULL THEN "address_line1"
    ELSE concat_ws(', ', nullif(trim("address_line1"), ''), trim("address_line2"))
  END;--> statement-breakpoint
UPDATE "branch" AS b SET "country" = p."country_code"
  FROM "org_profile" AS p
  WHERE p."organization_id" = b."organization_id" AND b."country" IS NULL;
