# Aplicaciones

## Responsabilidades

- `panel`: acceso a la cuenta, registro/verificación, invitaciones, onboarding y perfil. Facilitar entrar en la organización correcta; no implementar reglas clínicas.
- `platform`: operación del CRM por organización y entradas públicas (portal, widget, confirmación/baja). Conservar los vínculos entre caso, interlocutor, paciente y oportunidad; distinguir explícitamente superficies autenticadas y públicas.
  En la ficha: códigos del dominio a pantalla solo vía `apps/platform/src/lib/glossary.ts` (o las etiquetas de su dominio), selectores con `ChoiceSelect`/`Select` de `@odentia/ui` (no `<select>` nativo) y un solo `h1` por página.
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
- Utilidades globales de cabecera (avisos, panel del agente) las aporta `HeaderUtilitiesProvider` en `_org.tsx`; una pantalla sin `PageHeader` (ficha de paciente) las monta ella misma. El panel del agente se monta una sola vez en el layout, comparte la suscripción SSE del layout y se cierra cuando la navegación se confirma, no al clic, para respetar los bloqueadores de borradores.
- Bandeja: las vistas son chips con su total del servidor (`/api/conversations/summary`, mismos filtros que la lista) y solo vale en la URL una vista que tenga chip; el subtítulo habla de toda la bandeja y calla el total cuando hay filtros. Fila y cabecera del hilo dicen qué espera la conversación con la `attention` del servidor (lista y detalle), con texto y nunca solo con color: la interfaz no la deduce. La banda del hilo no decide nada: abre el panel del agente, que agrupa primero lo «De esta conversación» y devuelve el foco al control que lo abrió.
- Tablero de oportunidades: scroll único mediante `ScrollArea horizontal`, cabeceras sticky, sin scroll por columna. Movimiento optimista reversible, sin movimientos simultáneos; cerradas no arrastrables y cierre con motivo. Respetar movimiento reducido.

## Integraciones

- SSE transporta avisos mínimos (`orgId/kind/at`), nunca información clínica. Replay solo donde esté implementado; reconexión debe conciliar consultas.
- Worker: `WEB_URL` para enlaces públicos; portal también requiere `COOKIE_DOMAIN`. No derivar origen/RP WebAuthn de entradas no confiables.
- No habilitar correo OAuth sin sus variables ni activar reglas pausadas como efecto secundario de una semilla. Un envío controlado no verifica credenciales externas.
