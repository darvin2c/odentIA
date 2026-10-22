# 0011 · El asesor recomienda con consultas, no con un modelo

Fecha: 2026-10-10 · Estado: sustituida por [0015](0015-administrador-lineas-prendidas-o-apagadas.md), que conserva que toda cifra salga de una consulta

## Problema

Quien administra una clínica mediana no tiene tiempo de recorrer agenda, presupuestos, atenciones, seguimientos y cobranza para descubrir qué se está quedando sin atender. Un asistente que «analiza» la clínica con un modelo de lenguaje puede redactar bien, pero un número mal dicho —catorce pacientes donde hay nueve— destruye la confianza en todos los demás, y no hay forma de comprobarlo. Además, cada rol ve cosas distintas: una recomendación no puede enseñar a caja lo que es de la historia clínica.

## Decisión y motivo

- **Cada detección es una consulta a la base de datos**, escrita y probada: controles vencidos sin cita, presupuestos aceptados sin cita, atenciones sin firmar, seguimientos sin responsable, cobranza vencida y, desde el 2026-10-12, inasistencias sin otra cita y presupuestos sin respuesta. El título, la cifra, la lista y «cómo se calculó» salen del mismo resultado. No interviene ningún modelo, así que no cuesta por uso ni puede inventar un número.
- **Se calcula al leer**, con los datos de ese momento; no hay una foto diaria que pueda quedar vieja ni un proceso que mantener.
- **Los permisos son los de quien lee.** Cada detección declara el permiso de su dominio y el servicio solo calcula las que ese rol puede ver. Leer recomendaciones no exige permiso del agente; encender el asesor, apagar una detección, cambiar su umbral o posponerla es administrar el agente.
- **Solo recomienda.** La acción preparada —una tarea por persona de la lista— la pide y la confirma una persona, y repetirla el mismo día no duplica nada. El asesor no envía mensajes ni enciende automatizaciones por su cuenta.
- **Donde hay una automatización real, la ofrece; no la ejecuta.** Una detección puede declarar la automatización que evita que su lista vuelva a llenarse («Controles vencidos» → recordatorio de control; «Inasistencias sin otra cita» → recordatorio de cita; «Presupuestos sin respuesta» → seguimiento de presupuesto). El asesor lee su estado con el listado de reglas de Automatizaciones y lo muestra solo a quien puede verlas (`crm.read`). «Encender recordatorio» es la misma operación de esa pantalla (`/api/automations/rules`, permiso `crm.write`), la pide una persona y se confirma; crear las tareas queda como acción secundaria. El texto dice lo que la regla hace de verdad: avisa antes de la fecha y no escribe a quienes ya la pasaron.
- **Pocas y ordenadas**: tres a la vez en Inicio, en orden fijo; el resto, a pedido. En Reportes la misma recomendación acompaña a la cifra de su pregunta (una como mucho por pregunta) y se abre con la misma ficha. Cada una se apaga para toda la clínica, se oculta una semana o cambia su umbral.
- **Se puede ver antes de encender**: la página del asesor muestra lo que recomendaría hoy.

## Alternativas descartadas

- *Un modelo que lea reportes y recomiende*: coste por lectura, números sin garantía y recomendaciones que no se pueden reproducir ni probar.
- *Una foto calculada cada mañana*: simple de mostrar («con tus datos de las 8:00»), pero una lista que ya se resolvió seguiría apareciendo y habría que operar un proceso más.
- *Ejecutar la acción automáticamente*: crear tareas o escribir a pacientes sin que nadie lo pida convierte una ayuda en ruido y en riesgo.

## Consecuencias

- Beneficio: toda cifra se abre y muestra quiénes son; el asesor funciona igual con cualquier proveedor de modelo, o sin ninguno.
- Sacrificio: no descubre nada que no se haya escrito como detección, y el texto de cada recomendación es fijo. Una detección nueva es código, con su prueba.
- Las consultas corren en cada visita a Inicio; se revisa su coste si alguna clínica acumula miles de filas pendientes.
- Pendiente: el diseño muestra que encender el recordatorio escribe a quienes ya tienen el control vencido y crea tareas para quienes no dieron su consentimiento. La regla actual solo avisa de controles próximos; cubrir los vencidos es un cambio de las automatizaciones, no del asesor. Las reglas de recordatorio de cita y de seguimiento de presupuesto tampoco escriben a quien ya faltó o ya recibió su aviso: el texto de cada recomendación lo dice. Las otras cuatro detecciones no tienen una automatización equivalente.

## Referencias

- `packages/services/src/agent-advisor.ts`, `apps/api/src/routes/agent-advisor.ts`, `apps/dental-clinic/src/components/agent/advisor.tsx`, migración `0053`.
