# Persistencia

Objetivo: integridad e aislamiento de organización reforzados en PostgreSQL, con evolución reproducible del esquema.

- Drizzle + migraciones versionadas. No aplicar cambios manuales al esquema.
- `DATABASE_URL`: owner para migraciones/semillas, bypass RLS. `APP_DATABASE_URL`: app runtime, sujeto a RLS.
- Tablas de dominio con `organization_id`; `cie10_code` e `inbound_event` son globales sin RLS. Vínculos compuestos deben impedir referencias entre tenants.
- Proteger en DB concurrencia, inmutabilidad y restricciones que no pueden depender solo de una comprobación previa del servicio.
- El rol de la aplicación recibe por defecto lectura y escritura completas sobre cada tabla nueva: lo que la aplicación no debe borrar o reescribir se le retira en la migración con `REVOKE`; un `GRANT` parcial no restringe nada.
- Persona única: la base garantiza que cada paciente tenga su persona (`self`) y que la identidad sea igual en `patient` y `contact`. No escribir identidad con triggers deshabilitados ni retirar el vínculo propio; ficha y vínculos se borran en la misma transacción.
- La atención finalizada es inmutable en su contenido clínico (trigger) y `clinical_access_log` es de solo anexado: la aplicación no borra ni reescribe quién consultó.
- Una función o bloque `$$` en una migración va entero entre dos `--> statement-breakpoint`.
- Catálogos clínicos oficiales, no formatos inventados. `seed:cie10` es prerrequisito de la semilla dev.
- CPMS: `import:cpms` regenera CSV desde XLSX oficial y verifica SHA-256. Edición `RM-550-2023-MINSA`, secciones 1.3 y 2.7 completas (505 procedimientos); no afirmar equivalencia CDT/ICHI ni vigencia posterior.
- `seed:procedures` concilia códigos, plantillas y procedencia en una transacción, conserva versiones retiradas y rechaza reactivar una edición retirada sobre otra vigente. No cambiar precios ni snapshots clínicos al actualizar catálogos.
- Migraciones y pruebas usan `dentalagent-postgres:18.6`; configuración y comandos en `../../docs/development.md`.
