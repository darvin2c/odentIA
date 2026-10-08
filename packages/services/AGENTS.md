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
- Coordinación del tratamiento (`treatment-coordination.ts`): vista mínima para quien agenda sin leer la ficha —títulos, estados y fechas; nunca diagnósticos, piezas, importes ni instrucciones—. Reservar un control desde ahí es la misma operación que la vía clínica.
- Persona única: la identidad se edita desde la ficha o desde la persona y la base la mantiene igual en ambas. El agente no cambia la identidad de quien ya es paciente. Identificar al paciente con otro contacto solo sustituye a una persona provisional.
- Identidad (ADR 0004): nombre separado del que la base deriva `display_name`; catálogos y formatos de `@odentia/clinical` (sexo ISO 5218, documentos, estado civil, instrucción, parentesco), teléfono en E.164 y ubigeo del catálogo INEI, validados igual en ficha, registro y Contactos. Lo que no encaja en un catálogo se conserva en `identity_legacy`, nunca se descarta.
- Datos personales (Ley 29733): consentimiento por versión del aviso y finalidades, otorgado por el paciente o su representante legal; revocarlo da de baja los envíos comerciales. El alta de un menor crea a su representante legal con documento en la misma transacción.
- Consentimientos: con `signerContactId` firma la propia persona o su representante legal vigente y el nombre sale de su registro; sin él se conserva la firma declarada.
- Atención (ADR 0002/0003): un borrador por paciente; solo quien la lleva la edita y firma, otro profesional toma el relevo con registro. Cerrar exige motivo, diagnóstico CIE-10 con tipo, evolución y colegiatura (instantánea en la fila). Anular solo en borrador, con motivo y en cascada; nunca genera cargos. Diagnósticos y procedimientos se anulan, no se borran.
- Plan: un estado por tratamiento y la decisión como atributo; fase, orden y sesiones previstas son planificación (sin atención abierta), las sesiones hechas son procedimientos no anulados.
- Toda lectura clínica atendida deja traza en la bitácora de consultas (`clinical-access.ts`); la leen quienes auditan.
- Notas operativas y evidencia de propuestas inmutables. Notas operativas distintas de notas clínicas; recepción recibe presupuestos mínimos, no líneas/importes clínicos ni caja.
- Métricas: primera respuesta desde aceptación real del envío, no encolado/simulación; históricos sin hora conservan duración desconocida. Ejecución no significa resolución, conversión no significa cobro ni causalidad. Sin datos no mostrar éxito del 100 %.

## Verificación

Tests con fixtures mínimas y PostgreSQL efímero; nunca importar `seed-dev.ts`. La semilla es CLI manual, determinista e idempotente; extenderla para nuevas pantallas/entidades, sin enviar mensajes ni activar automatizaciones.
