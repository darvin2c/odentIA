# Servicios de negocio

Objetivo: una operación de negocio coherente para personal, portal y agente, con aislamiento e integridad transaccional.

- Toda función recibe `tx: Db` YA ejecutándose con tenant. Rutas/worker abren `withOrgContext`; los servicios nunca lo abren.
- Secretos de conexión: AES-256-GCM mediante `encryptJson`/`secretsKeyFromEnv` de `secrets.ts`.
- Agenda: horario explícito por profesional/sede; sin horario no se reserva. Intervalos semiabiertos y protección ante reservas concurrentes; citas contiguas no se solapan.
- Caja: enteros en centavos, arqueo solo efectivo y movimientos electrónicos separados. Anulaciones revierten efectos; cuotas recalculadas y comisiones sin reutilizar fuentes.
- Inventario: recepción parcial idempotente, traslados de doble movimiento y saldo nunca negativo.
- Formularios/consentimientos: versiones publicadas y registros finalizados inmutables. Consentimiento no equivale a firma digital certificada.
- Portal deshabilitado por defecto. Personal verifica identidad/representación y alcance; activación por conversación o QR más PIN separado. Reingreso con passkey descubrible y verificación del usuario. Revocación invalida sesiones/enlaces; recuperación exige revocar explícitamente la credencial perdida.
- Contactos/oportunidades: paginación y orden servidor, cursores con microsegundos y totales sobre todos los resultados filtrados, no sobre la página cargada.
- Una tarea abierta de seguimiento por oportunidad. Completar limpia solo su próxima acción, no una reprogramación posterior; editar/reabrir seguimiento mediante la oportunidad.
- Controles clínicos: programar reserva o vincula una cita real del mismo paciente y organización en la misma transacción. Mover la cita reprograma el control; cancelarla, inasistencia o atención lo devuelve a pendiente conservando la traza; cancelar el control no cancela la cita. Históricos sin cita conservan `legacyScheduledAt` sin marcarse como reserva verificada.
- Notas operativas y evidencia de propuestas inmutables. Notas operativas distintas de notas clínicas; recepción recibe presupuestos mínimos, no líneas/importes clínicos ni caja.
- Métricas: primera respuesta desde aceptación real del envío, no encolado/simulación; históricos sin hora conservan duración desconocida. Ejecución no significa resolución, conversión no significa cobro ni causalidad. Sin datos no mostrar éxito del 100 %.

## Verificación

Tests con fixtures mínimas y PostgreSQL efímero; nunca importar `seed-dev.ts`. La semilla es CLI manual, determinista e idempotente; extenderla para nuevas pantallas/entidades, sin enviar mensajes ni activar automatizaciones.
