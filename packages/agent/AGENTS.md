# Agente

Objetivo: ayudar a resolver la atención con contexto autorizado y acciones trazables, sin sustituir las reglas de negocio ni la identidad verificada.

- Conocimiento publicado/versionado y contexto filtrado por autorización. No SQL directo del modelo, credenciales en prompts ni fetch arbitrario.
- Contexto e historial se reemplazan entre turnos, no se acumulan copias. Recuperar detalle comercial mediante `leer_contexto_comercial` y cursores, sin historia clínica fuera de permiso.
- Continuidad omnicanal: el prompt incluye un resumen acotado de otros hilos del mismo contacto verificado (`listContactChannelHistory`, con procedencia canal/fecha) y la herramienta `ver_otros_canales` pagina el resto. La autorización la da el contactId vigente del hilo, nunca coincidencia de teléfono; reasignar una identidad mueve sus hilos y revoca ese contexto.
- Enviar respuesta, mover etapa, crear oportunidad, actualizar seguimiento y cerrar pasan por política de autonomía y propuestas reales. Idempotencia por mensaje/herramienta/payload; actor, motivo y efecto previsto auditables.
- Aprobación requiere `agent.decide` y permiso operativo del acto. Confirmación del interlocutor exige modo vigente `confirmar_usuario` y mensaje afirmativo posterior a la propuesta; aprobación del empleado no lo sustituye.
- Una sola propuesta esperando confirmación por hilo. Distinguir bloqueo `PROPOSAL_PENDING_CONFIRM` de `PROPOSAL_PENDING_APPROVAL` según la propuesta bloqueante.
- Evidencia `expected_state` inmutable; mover/cerrar/reprogramar verifica estado actual bajo bloqueo. Fallo de dominio deja propuesta `fallida` con `result.errorCode`, sin efectos parciales.
- Caducidad de 48 horas conciliada al consultar/decidir/confirmar/crear. Confirmar transacción antes de devolver `expirada`; no revertirla lanzando una excepción después del update.
- Mensajes directos que comunican propuestas también respetan política de envío. `buscar_huecos` entrega sede, sillón, profesional, inicio, fin, duración y zona.
- Simulación comparte modelo efectivo, pero no envía mensajes ni muta citas/tareas/oportunidades/propuestas; no afirmar que reproduce memoria persistente o todos los controles de producción.
- `LLM_MODEL=fake` es demostración determinista. Solo ejecución con proveedor real permite evaluar su calidad; registrar límites de la evidencia.
