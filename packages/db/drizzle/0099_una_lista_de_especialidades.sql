-- Un solo catálogo de especialidades (fase 4, decisiones 1 y 3; ADR 0039).
-- La lista es la de cada clínica (`org_specialty`), que nace con las 14 de la
-- biblioteca con la misma clave. El servicio apunta a UNA de ellas por id; se
-- quitan el texto fijo `service_catalog.specialty` y el vínculo
-- `service_specialty`, que nadie más que su pantalla leía. No hay datos
-- reales: lo que no casa por clave queda sin especialidad.
CREATE UNIQUE INDEX IF NOT EXISTS "org_specialty_org_id_uidx" ON "org_specialty" USING btree ("organization_id","id");--> statement-breakpoint
INSERT INTO "org_specialty" ("organization_id", "key", "name")
SELECT o."id", v."key", v."name"
FROM "organization" o
CROSS JOIN (VALUES
  ('diagnostico', 'Diagnóstico'),
  ('prevencion', 'Prevención'),
  ('restauradora', 'Restauradora'),
  ('endodoncia', 'Endodoncia'),
  ('periodoncia', 'Periodoncia'),
  ('cirugia', 'Cirugía'),
  ('protesis', 'Prótesis'),
  ('implantologia', 'Implantología'),
  ('ortodoncia', 'Ortodoncia'),
  ('odontopediatria', 'Odontopediatría'),
  ('estetica', 'Estética'),
  ('disfuncion', 'Disfunción'),
  ('anestesia', 'Anestesia y sedación'),
  ('general', 'Servicios odontológicos generales')
) AS v("key", "name")
ON CONFLICT ("organization_id", "key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "specialty_id" uuid;--> statement-breakpoint
UPDATE "service_catalog" s SET "specialty_id" = os."id"
FROM "org_specialty" os
WHERE os."organization_id" = s."organization_id" AND os."key" = s."specialty";--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_specialty_fk" FOREIGN KEY ("organization_id","specialty_id") REFERENCES "public"."org_specialty"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "service_catalog_org_specialty_idx";--> statement-breakpoint
ALTER TABLE "service_catalog" DROP COLUMN "specialty";--> statement-breakpoint
CREATE INDEX "service_catalog_org_specialty_idx" ON "service_catalog" USING btree ("organization_id","specialty_id");--> statement-breakpoint
DROP TABLE "service_specialty";
