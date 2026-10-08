# Aplicaciones

## Responsabilidades

- `panel`: acceso a la cuenta, registro/verificación, invitaciones, onboarding y perfil. Facilitar entrar en la organización correcta; no implementar reglas clínicas.
- `platform`: operación del CRM por organización y entradas públicas (portal, widget, confirmación/baja). Conservar los vínculos entre caso, interlocutor, paciente y oportunidad; distinguir explícitamente superficies autenticadas y públicas.
- `api`: frontera HTTP, autenticación/autorización, validación, webhooks y SSE. Abre `withOrgContext` y delega negocio en services; no convertir errores de infraestructura en 404 de dominio.
- `worker`: ingesta, envío, automatizaciones y agente. Ejecuta servicios con contexto de organización, idempotencia y política de autonomía; no crea una segunda implementación del negocio.

## Interfaces web

- Consultar la skill `odentia-ux` y las reglas de `packages/ui-patterns` al cambiar pantallas. Las apps no importan `@tanstack/charts` directamente.
- Estado remoto en React Query; `useOrgEvents` invalida consultas, no crea una copia paralela del estado. Respetar permisos canónicos también en navegación.
- Las rutas hijas de `settings.tsx` y `services.tsx` no añaden otro `PageShell`: lo aporta su layout.
- Ficha del paciente: cinco áreas (`lib/patient-areas.ts`) con entrada por rol; `?tab=` identifica la sección y el área se deriva. Una sección nueva se declara ahí con su permiso, no en la ruta.
- Las subapps de Hono montadas en "/" acotan sus guardas a sus propias rutas: un `use("*")` alcanza a todas las subrutas registradas después.
- Mantener borradores al cargar datos auxiliares. Al cambiar contacto/hilo, limpiar vínculos incompatibles; presupuestos según contacto/paciente efectivos, también al editar.
- El sidebar debe reenviar el evento de clic al router para conservar navegación SPA y bloqueadores de borradores.
- Tablero de oportunidades: scroll único mediante `ScrollArea horizontal`, cabeceras sticky, sin scroll por columna. Movimiento optimista reversible, sin movimientos simultáneos; cerradas no arrastrables y cierre con motivo. Respetar movimiento reducido.

## Integraciones

- SSE transporta avisos mínimos (`orgId/kind/at`), nunca información clínica. Replay solo donde esté implementado; reconexión debe conciliar consultas.
- Worker: `WEB_URL` para enlaces públicos; portal también requiere `COOKIE_DOMAIN`. No derivar origen/RP WebAuthn de entradas no confiables.
- No habilitar correo OAuth sin sus variables ni activar reglas pausadas como efecto secundario de una semilla. Un envío controlado no verifica credenciales externas.
