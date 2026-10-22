# Recorridos E2E

Objetivo: demostrar comportamiento observable entre superficies reales, con aislamiento de dev y entre casos.

- Ejecutar `pnpm e2e [specs] [opciones Playwright]`, nunca Playwright directo sin supervisor. PostgreSQL, RustFS (S3), Mailpit, proxy HTTPS, CA y bundles propios; no cargar `.env` ni reutilizar dev.
- No se admiten `E2E_KEEP`/`E2E_HARNESS`. Dos workers por defecto; reducir con `--workers=1` o `E2E_WORKERS=1`. Sin retries para ocultar fallos.
- Cada caso tiene identidad/tenant independientes; solo hash y cliente DB cerrable compartidos por worker. Registro/verificación/invitaciones mantienen recorrido UI. No importar semilla manual.
- Prerrequisitos y sockets por plataforma: `../docs/development.md`. No arrancar ni reconfigurar el runtime automáticamente.
- `--debug` mantiene entorno mientras siga abierto el inspector; al terminar cerrar inspector o Ctrl+C. Supervisor retira recursos propios; SIGKILL/apagón no garantizan limpieza.
- Evidencia en `test-results/<runId>/`: logs, JSON, capturas y trazas. `runtime.json` no contiene credenciales; las trazas pueden contener credenciales de prueba y son privadas.
- Verificar permisos con servidor, no solo controles ocultos; simulaciones y proveedores controlados no acreditan integraciones externas reales.
- Pruebas permanentes de comportamiento, fronteras, transiciones y errores; no snapshots de redacción ni comprobaciones del texto fuente. Inspección visual real para layout, scroll, drag y foco.
