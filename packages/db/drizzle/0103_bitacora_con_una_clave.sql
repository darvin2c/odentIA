-- Bitácora de consultas a la historia con un solo índice (fase 4, tablero 7;
-- issue 84; decisión 12: por ahora sin plazo máximo y sin borrar nada).
-- No hay datos reales: se reestructura sin plan de conservación.
--
-- Antes había tres índices: la clave `id`, el único de la franja y uno con
-- `last_at`. Como `last_at` estaba indexada, contar «una vez más» nunca podía
-- ser una actualización HOT: cada recarga dejaba una copia muerta y una
-- entrada nueva en los tres índices. Ahora la clave primaria es la propia
-- franja, con `bucket` antes que `user_id` para que la misma clave sirva al
-- listado (`organization_id`, `patient_id`, `bucket desc`); `last_at` y `hits`
-- quedan fuera de todo índice y la actualización se hace en su sitio.

-- Quitar `id` retira también su clave primaria.
ALTER TABLE "clinical_access_log" DROP COLUMN "id";--> statement-breakpoint
DROP INDEX "clinical_access_log_bucket_uidx";--> statement-breakpoint
DROP INDEX "clinical_access_log_org_patient_idx";--> statement-breakpoint
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_pkey" PRIMARY KEY ("organization_id","patient_id","bucket","user_id","resource");--> statement-breakpoint
-- Hueco en cada página para que la reescritura de `last_at` y `hits` quepa en
-- la misma página, condición de la actualización HOT. Rige para las páginas
-- que se escriban desde ahora.
ALTER TABLE "clinical_access_log" SET (fillfactor = 90);--> statement-breakpoint
-- Los permisos no cambian: el rol de la aplicación consulta, inserta y solo
-- actualiza `last_at` y `hits`; no borra, no vacía ni reescribe quién, a quién
-- o qué (0035). Se reafirman por si un despliegue los hubiera ampliado.
REVOKE UPDATE, DELETE, TRUNCATE ON "clinical_access_log" FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "clinical_access_log" TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE ("last_at", "hits") ON "clinical_access_log" TO dentalagent_app;
