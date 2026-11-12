# Operaciones de negocio

Catálogo de la voz de desarrollo: lo que cada operación de negocio debe cumplir siempre y cómo ya falló. Es el piso, no el techo: se revisa comprobación por comprobación en las operaciones que el área toca, y además la voz arma sus casos y hace sus giras. Crece con lo que cada recorrido devuelve en «Para mi catálogo» y con lo que se le escapó a la mesa, y se poda cuando algo deja de existir o dos comprobaciones dicen lo mismo. No es un inventario del código: funciones, tablas y permisos se leen del código; aquí va lo que el código no dice solo. «Dónde» nombra el archivo por el que se empieza a leer, sin líneas.

Rutas: `S` = `packages/services/src/`, `API` = `apps/api/src/routes/`, `P` = `packages/auth/src/permissions.ts`. Productos: odentIA (dental), latidIA (médico) y vistIA (óptica).

## O-GEN-01 Lo que vale para toda operación

**Dónde:** el servicio de la operación en `S`, su ruta en `API`, su permiso en `P` y, si la comparte con un agente, `S/operation-fields.ts`.

- [ ] El servidor rechaza al rol sin permiso. No basta con esconder el botón, y un botón visible no promete lo que el servidor no deja hacer.
- [ ] Todo lo que escribe va en una sola transacción, con su auditoría. Si se corta a la mitad, no queda nada escrito.
- [ ] Repetirla (doble clic, reintento tras un corte, dos pestañas) devuelve lo ya hecho y no crea otro.
- [ ] Un efecto externo (mensaje, PDF, correo) sale una vez. Si no se sabe si salió, no se reintenta solo.
- [ ] La regla vive en el servicio. La ruta, la pantalla y la herramienta del agente no la repiten ni la calculan a su modo.
- [ ] Un id mal escrito o que no existe responde «no existe», nunca un error del servidor. El error de un dato dice su campo, sin palabras internas.
- [ ] Guardar con datos viejos (otra pestaña, otra persona) no pisa en silencio lo que cambió después.
- [ ] El día y la hora son los de la sede: de noche, en el cambio de día y en el cambio de mes.
- [ ] La sede de lo que se crea es la que la persona eligió o ve, no la que quedó guardada en el navegador.
- [ ] Lo común hace lo mismo en los tres productos. La semilla de cada producto corre completa.

**Ya falló:** un id con un carácter de más dio error del servidor en citas, cierres de caja y gastos; guardar una pantalla de configuración devolvió a su valor anterior lo que otra pestaña acababa de cambiar; una pantalla usó UTC cuando la sede no tenía zona y desde la tarde mostraba lo de pasado mañana; el error de una transición salió con el texto interno; la semilla de un producto falló por una regla que la del otro no tocaba.

## O-AGE-01 Reservar una cita

**Dónde:** `S/appointments.ts` (reservar), `S/to-schedule.ts` (lo que falta agendar), `S/su-enlace.ts` y `S/agent-operations.ts` (la misma reserva desde el enlace y desde Sofi).

- [ ] Sin horario del profesional en esa sede no se reserva. Dos citas seguidas no se solapan y dos reservas a la vez del mismo hueco dejan una sola, también con la excepción de «hora ocupada».
- [ ] Una cita no se crea a una hora que ya pasó, por ninguna vía.
- [ ] La cita nace en el estado que le toca. Quien llama no puede crearla ya atendida, cancelada o «No vino». El origen de la cita lo pone el servidor.
- [ ] La cita tiene un máximo de duración, se diga con minutos o con hora de fin.
- [ ] La cita dice a qué viene. La que se reserva para un control o una sesión queda unida a él, la reserve recepción, Sofi, Clío o «Su enlace».
- [ ] Recepción, el enlace y Sofi reservan con la misma operación. Fuera de horario o a la misma hora, solo el equipo y con aviso. Si el paciente ya tiene otra cita en pie a esa hora, se avisa antes de reservar.
- [ ] El aviso de la cita sale una vez y no se repite donde la persona ya lo vio (su chat, su enlace).
- [ ] La confirmación que se registra es la última respuesta de la persona, no una anterior.
- [ ] La sesión que sigue respeta la espera del tratamiento y se propone con quien atendió. Un día sin atención se avisa.

**Ya falló:** por la API se creó una cita ya «Atendida» sin atención y sin poder corregirla; la cita dada para un control no se unió a él y el control salió «vencido» después de atenderla; «Registrar confirmación» reservó con un «ok» viejo aunque después la persona dijo «no»; la cita nació en la primera sede sin decirlo; la segunda sesión no se unió al tratamiento porque la primera ya lo llevaba; con la excepción de «hora ocupada», el mismo envío dos veces dejó dos citas iguales; el mismo paciente quedó con dos citas a la misma hora sin aviso; una cita duró tres días.

## O-AGE-02 Mover, cancelar, «Llegó» y «No vino»

**Dónde:** `S/appointments.ts` (mover, cambiar estado y llegada), `S/automation.ts` (avisos y recordatorios de la cita).

- [ ] El estado cambia por una sola operación. «Editar» no cambia el estado, revisa el horario como «Mover» y avisa igual, y guarda qué cambió. Lo atendido no se edita.
- [ ] «Atendida» pide la atención firmada unida a la cita, y una cita atendida no cambia más. Con llegada o atención en curso no se cancela ni se marca «No vino».
- [ ] De «Cancelada» y «No vino» solo se vuelve por «Llegó» el mismo día. «No vino» pide que la hora haya pasado. El cambio de estado lleva la versión que se leyó.
- [ ] Mover o estirar no lleva el inicio a una hora que ya pasó.
- [ ] «Vino» dice quién lo marcó y se puede deshacer mientras nada dependa de él.
- [ ] Al mover a otro día, la confirmación anterior no vale para el día nuevo, salvo que la moviera la propia persona.
- [ ] Mover la cita mueve sus recordatorios y borra la llegada si cambia de día; la fecha nueva tiene sus propios recordatorios. Cancelar, llegar o atender cancela los pendientes, y deshacerlo los devuelve.
- [ ] Una cita que ya pasó sin atención pregunta si vino. No se queda «Por confirmar» para siempre ni cuenta como asistencia.
- [ ] Si la sesión se hizo antes de su cita, esa cita no queda apuntando a un tratamiento terminado.
- [ ] Cambiar, confirmar o cancelar desde el enlace dice sobre qué cita actúa y toca solo esa: repetir la llamada no toca otra cita de la persona. El hilo dice quién lo hizo de verdad.

**Ya falló:** citas pasadas seguían «Por confirmar» y Reportes decía que nadie faltó; una sesión hecha antes de su cita dejó la cita en pie con un tratamiento ya terminado; «Reservar otra» cambió cuál era «Tu cita» en el enlace; el hilo decía «Sofi movió» lo que hizo la paciente o recepción; desde el enlace, la segunda llamada a «Cancelar» canceló la cita siguiente; una cita estirada hasta una hora pasada se marcó «Vino» y quedó atendida con una llegada inventada, sin deshacer; «Editar detalles» alargó la cita una hora fuera del turno sin avisar; una cita cancelada volvió a «Confirmada» a mano.

## O-AGE-03 Horarios y ausencias

**Dónde:** `S/availability.ts` (el horario, los bloqueos y la comprobación de disponibilidad).

- [ ] Dos turnos del mismo día no se pisan, y la misma ausencia enviada dos veces queda una vez.
- [ ] El horario se guarda con la versión que se leyó (O-GEN-01): no pisa lo que otra sesión cambió.

**Ya falló:** se guardaron dos turnos del mismo día que se pisaban, con «Horario guardado».

## O-PER-01 Registrar a una persona y corregir sus datos

**Dónde:** `S/patient-registration.ts` (el alta del equipo, del enlace y del registro en línea), `S/patients.ts`, `S/people.ts`, `S/contacts.ts`, `S/registration-hold.ts` (¿es la misma persona?).

- [ ] Una persona, una ficha. Nunca se unen dos fichas por teléfono o por nombre.
- [ ] Antes de crear, el aviso de parecidos muestra a la persona que coincide, también si está archivada. Un documento que ya es de otra persona no se guarda: queda una tarea.
- [ ] El alta es la misma operación desde Pacientes, la Agenda, la página de la persona, el enlace y el registro en línea.
- [ ] Lo que la clínica pide y falta no bloquea: queda como «Faltan datos», dicho igual en todas las pantallas.
- [ ] Un menor se registra con su representante, y desde el enlace no se registra a un menor. Cambiar la fecha de nacimiento recalcula quién decide.
- [ ] El teléfono se guarda con su país. Cambiarlo deja claro a cuál número llegan los recordatorios.
- [ ] Lo que la persona declara de su salud entra como declarado, sin confirmar. Lo que anota el profesional, como suyo.
- [ ] Corregir tiene una sola regla, entre por Pacientes o por Contactos, deja rastro de lo anterior y no pisa lo que otra sesión cambió.

**Ya falló:** el aviso de duplicados mostró cinco homónimos y no a la persona; al escribir «+44…» el país no cambió y se ofreció guardar un número falso; el contacto de emergencia apareció como quien «habla por ella»; la alergia que anotó el profesional quedó como «declarada por el paciente»; guardar la identidad pisó sin aviso el cambio de otra sesión; cambiar el número dejó dos WhatsApp.

## O-ATE-01 Abrir una atención, escribir y registrar lo hecho

**Dónde:** `S/encounters.ts` (el borrador y los procedimientos), `S/encounter-attending.ts` (quién la lleva), `S/plan.ts` (el plan y sus estados), `S/encounter-dictation.ts` y el dictado de cada producto (`S/dental/dictation.ts`, `S/medical/dictation.ts`).

- [ ] «Atender» una cita no abre ni usa la atención en curso de otro profesional sin tomar el relevo. La atención sin cita nace en la sede que el profesional ve.
- [ ] Lo escrito no se pierde si se corta la red o se sale de la pantalla, y dos pestañas no se pisan sin aviso.
- [ ] Un borrador de ayer se retoma, o se descarta si está vacío. Su fecha es la del día en que se atendió.
- [ ] Confirmar algo dictado suma a lo escrito, no lo reemplaza. El mismo tramo no se guarda dos veces.
- [ ] Lo hecho sale del tratamiento abierto del plan que lo indicaba. No crea otro igual ni lo deja también pendiente.
- [ ] Un tratamiento de varias sesiones no se cierra en la primera ni se cobra de nuevo en la siguiente. Lo dictado «en dos sesiones» llega al plan con dos.
- [ ] El mismo gesto deja el mismo estado: lo aceptado y lo «por responder», hechos igual, terminan igual.
- [ ] «Completar» no cierra un tratamiento cuya única sesión está anulada. «Piezas tratadas» nombra solo lo tratado.

**Ya falló:** se cortó la red y la evolución escrita se perdió sin aviso; con dos pestañas se pisaron los signos, el examen y las piezas; en latidIA, confirmar el examen dictado de un sistema borró el hallazgo escrito ahí; «Atender» abrió la atención que tenía otra profesional; la resina hecha hoy quedó también pendiente y se ofreció en el presupuesto; la endodoncia de dos sesiones se cerró en la primera y se cobró otra vez en la segunda; «Completar» cerró un tratamiento con su única sesión anulada.

## O-ATE-02 Firmar la atención

**Dónde:** `S/encounters.ts` (la comprobación del cierre y firmar), `S/service-materials.ts` (el descuento de materiales), `S/follow-ups.ts`.

- [ ] La lista de cierre dice la verdad: lo ya escrito no sale «pendiente» y no promete a un rol lo que ese rol no ve.
- [ ] La validación de un dato mira el dato completo (la presión con sus dos cifras), no cada parte sola.
- [ ] Firmar es una transacción: atención, cita atendida, cargos, materiales y presupuesto armado. Firmar dos veces no carga ni descuenta dos veces.
- [ ] Los materiales salen de la sede de la atención. Si falta stock, la firma no se frena.
- [ ] Lo que se cobra por sesión se carga al firmar cada visita, no antes.
- [ ] Lo firmado no cambia: la corrección va como adenda, con quién la escribió. El odontograma firmado no lleva hallazgos de un borrador.
- [ ] Si un paso de la firma se frena (un consentimiento que falta), lo dictado sin decidir sigue ahí al volver.
- [ ] Firmar pasada la medianoche deja los controles con la fecha y el tipo que se eligieron.

**Ya falló:** «Finalizar y firmar» no cerraba y marcaba en rojo una presión válida; «Firmar con lo dictado» se frenó por un consentimiento y la receta dictada ya se había descartado; el odontograma firmado «a pedido» congeló hallazgos del borrador; firmando pasada la medianoche, «En 6 meses» nació con otro tipo y título; el doble clic en «Finalizar y firmar» no abría el cierre.

## O-ATE-03 Anular una atención

**Dónde:** `S/encounters.ts` (la vista previa y anular), `S/encounter-void-budgets.ts` (lo que pasa con su presupuesto).

- [ ] Anular dice antes todo lo que se va con ella y lo que la frena (un cobro, una firma, algo hecho o revisado).
- [ ] Lo que nació de la atención cae con ella: recetas, órdenes, descansos, consentimientos pendientes, controles y lo indicado sin entregar.
- [ ] La cita reservada para un control anulado no queda en la agenda sin motivo ni con recordatorios.
- [ ] El plan vuelve a su estado: lo que se dio por hecho en ella se reabre.
- [ ] Un papel anulado se ve anulado al comprobarlo con su código. La atención anulada dice qué pasó con su presupuesto.

**Ya falló:** se anuló la atención y el descanso, la orden y el consentimiento siguieron «Vigentes»; se anuló el borrador, el control se canceló y su cita siguió en la agenda; anular no reabrió el tratamiento que se había completado con ella.

## O-ATE-04 Indicar, reservar y cumplir un control

**Dónde:** `S/follow-ups.ts`, `S/to-schedule.ts` (la ventana del control y «control vencido»), `S/plan-next.ts` («Qué sigue»).

- [ ] El control y su cita van unidos: reservar la cita lo deja «con cita» y atenderla lo cumple.
- [ ] Un control no se cumple con la misma atención que lo indicó ni con una anterior.
- [ ] «Control vencido» tiene una sola regla, en código y en SQL. Inicio, Pacientes, la ficha, Reportes y Argos dan la misma cuenta.
- [ ] Quien ya tiene cita, o está hoy en la sala, no recibe «te buscamos un horario».
- [ ] No se crean dos controles iguales para la misma persona y fecha. Atender sin cita a quien tenía uno vencido lo resuelve o pregunta.
- [ ] «Hoy» es el día de la sede, también de noche. Una fecha imposible se rechaza en el servidor.
- [ ] La cita del control se reserva en la sede y con el servicio que corresponden.

**Ya falló:** la Agenda dijo «Sus controles quedaron hechos» con el control recién indicado; «Completar control» aceptó la misma atención que lo indicó y dejó su cita en pie; ya tenía la cita del control y le llegó «te buscamos un horario»; de noche no se pudo indicar un control para hoy; la API aceptó una fecha imposible al cambiar un control; «Programar control» reservó siempre en la primera sede.

## O-PRE-01 Armar, enviar y revisar un presupuesto

**Dónde:** `S/budgets.ts` (armar y revisar), `S/budget-paths.ts` (los caminos), `S/budget-send.ts` (enviar), `S/budget-awaiting.ts` («espera respuesta»).

- [ ] Un solo borrador por persona. Preparar otra vez suma al mismo; no queda un presupuesto vacío por enviar.
- [ ] El total lo calcula el servidor. Las opciones no se suman entre sí: vale la elegida o, mientras tanto, la recomendada de verdad.
- [ ] La revisión conserva todos los caminos sin elegir, y lo aceptado, hecho o cobrado sigue aceptado y con su precio.
- [ ] «Enviado» es que salió: imprimir o mostrar no lo da por enviado. Enviar dice antes a quién y por dónde, y va a quien decide.
- [ ] «Espera respuesta» tiene una sola regla, y Pacientes, Inicio, Reportes y Argos dan la misma cuenta.
- [ ] Lo que lleva algo de una atención en borrador no se pide enviar.
- [ ] Lo que está en otra moneda se debe en esa moneda. No se suman monedas.

**Ya falló:** la revisión de un presupuesto con dos caminos sin elegir borró el segundo; «Imprimir» lo dio por entregado y la ficha dijo «Enviado · espera respuesta»; la revisión de un precio dejó «por responder» lo ya hecho y cobrado; quedó un presupuesto vacío «por enviar» con su botón activo; «sin respuesta» dio una cifra en Pacientes y otra en Inicio.

## O-PRE-02 Responder un presupuesto

**Dónde:** `S/budgets.ts` (la respuesta), `S/portal.ts` (la respuesta de la persona, para portal, enlace y chat), `S/agent-operations.ts`, `S/budget-callback.ts` («No contesta»).

- [ ] La misma operación y los mismos campos desde recepción, el portal, «Su enlace» y el chat.
- [ ] Responde quien decide por el paciente. Si el presupuesto cambió desde que se le mostró, la respuesta se rechaza.
- [ ] Una respuesta parcial no obliga a elegir un camino ni marca el resto como «No elegida».
- [ ] Lo ya respondido no se reescribe. Cualquier respuesta cierra la tarea de volver a llamar.
- [ ] Lo aceptado y dejado «para después» se puede agendar desde donde se aceptó.
- [ ] La oportunidad dice lo mismo que el plan: no está «Ganada» con algo «por decidir».
- [ ] Lo aceptado con una promoción se cobra a ese precio aunque la promoción termine.

**Ya falló:** con dos opciones, anotar una respuesta parcial obligó a elegir una y la otra quedó «No elegida»; aceptó, tocó «Después» y ya no encontró cómo elegir la hora; «Lo piensa» dejó abierta la tarea «No contestó»; la ficha decía «Ganada» y el plan «Por decidir».

## O-COB-01 Cobrar

**Dónde:** `S/payments.ts` (crear el cargo y cobrar), `S/finance.ts` (la caja), `S/clinic-taxes.ts` (el impuesto), `S/counter-sale.ts` y `S/job-orders.ts` (venta de mostrador y pedidos, vistIA).

- [ ] Importes enteros en la unidad menor de su moneda. Un importe con más decimales que la moneda no se redondea en silencio.
- [ ] El ticket numera sin saltos y congela conceptos, medios, clínica y texto. Se imprime y se envía solo desde lo congelado.
- [ ] El cobro y la entrada a caja van en la misma transacción. El reintento con la misma clave devuelve el mismo ticket.
- [ ] Si la cuenta cambió desde que se abrió el cajón, el servidor lo dice. Lo pagado de más no queda a favor en silencio.
- [ ] El efectivo entra a la caja de la sede donde se cobra.
- [ ] Lo cobrado descuenta su deuda: el Resumen, Cobros, la cuenta y Reportes dicen el mismo saldo.
- [ ] En dos monedas, cada cobro guarda su cambio. El vuelto en la otra moneda es su propio movimiento.
- [ ] Un producto vendido descuenta stock una vez y exige la sede. La venta de mostrador se paga entera: no deja deuda ni saldo a favor.

**Ya falló:** con conceptos marcados y un importe mayor, el excedente quedó a favor sin decirlo y el ticket no lo mostró; el cobro en efectivo entró a la caja de otra sede; la ficha decía «todavía no se le ha cobrado nada» encima de sus pagos; el pago de hoy no descontó el tratamiento que pagaba.

## O-COB-02 Adelanto y saldo a favor

**Dónde:** `S/payments.ts` (el adelanto, aplicar el saldo y devolver dinero).

- [ ] El adelanto dice para qué es. Con deuda abierta, uno sin destino lo avisa y ofrece cobrarlo a lo que debe.
- [ ] Lo que queda a favor se ve igual en el ticket, la cuenta, el Resumen y Cobros.
- [ ] Usar saldo a favor no cuenta como dinero que entró hoy, ni vuelve a llevar impuesto.
- [ ] «Devolver dinero» enviado dos veces devuelve una vez. Sale de la caja de hoy y dice de quién es.
- [ ] Un adelanto «para» un tratamiento no se pierde si el tratamiento cambia o se anula.

**Ya falló:** «Devolver dinero» enviado dos veces devolvió dos veces; el ticket dijo que el adelanto quedaba a favor y «A favor» estaba en cero; con saldo a favor, el Resumen dijo «Sin saldo por cobrar»; Caja y Reportes dieron cifras distintas por un adelanto devuelto en parte.

## O-COB-03 Anular un cobro, devolver y cerrar la caja

**Dónde:** `S/payments.ts` (anular un concepto, anular el ticket y devolver desde el ticket), `S/finance.ts` (movimientos, arqueo y cierre), `S/inventory-stock.ts` (lo que vuelve al stock).

- [ ] Anular un ticket revierte todo lo que sus pagos cubrieron, también en otros tickets. Un ticket con una devolución ya no se anula.
- [ ] Devolver deja la venta en pie, numera aparte, saca su parte de impuesto y devuelve al stock solo lo que está en buen estado, una vez.
- [ ] Lo anulado o devuelto baja la comisión de quien atendió, una sola vez. Reportes y Comisiones dan la misma cifra.
- [ ] Los movimientos de caja se anulan desde su origen, no sueltos. Lo anulado sigue a la vista en el día, marcado y con su rastro, también después del cierre.
- [ ] La caja nace sola por sede y solo se cierra. Repetir el cierre no abre otro. El arqueo cuenta solo el efectivo.
- [ ] El efectivo nunca queda negativo. Si no alcanza, lo dice antes de llenar el formulario y con una sola salida.
- [ ] Un movimiento con fecha pasada no sale de la caja de hoy sin decirlo.

**Ya falló:** tras una devolución desde el ticket, Reportes por profesional no cuadró con Comisiones; una devolución en «Movimientos de hoy» no decía de quién era; Deudas contó como deudor a quien tenía a favor lo que debía; la caja no alcanzaba y hubo tres avisos con dos consejos opuestos; el gasto anulado desapareció de «Movimientos de hoy»; «Ingresar o retirar efectivo» borró el gasto a medio escribir.

## O-CON-01 Consentimiento y su firma

**Dónde:** `S/clinical-forms.ts` (emitir, firmar y confirmar lo firmado por enlace), `S/consent-state.ts`, `S/consent-pdf.ts`, `S/su-enlace.ts` (enviar a firmar), `S/professional-profiles.ts` (la firma que se ve).

- [ ] Se pide por lo que se va a hacer hoy, no por lo indicado ni por un camino no elegido.
- [ ] Lo firmado no cambia. Editar la plantilla no toca lo ya firmado, y firmar de nuevo conserva la firma anterior en la historia.
- [ ] Firma quien decide: el paciente o su representante. Un menor no firma.
- [ ] La hoja es la misma en la tablet, el enlace, el celular y el PDF, con la misma declaración, la pieza y el diagnóstico.
- [ ] Lo firmado por enlace queda pendiente hasta que el profesional lo confirma dentro de una atención en curso de ese paciente, sea del día que sea. La constancia dice el día real.
- [ ] Desde el teléfono se firma solo con algo con qué comparar. Sin eso, la hoja dice por qué y cómo seguir.
- [ ] «Firmar en su teléfono» no envía ningún mensaje. «Enviar para firmar» envía uno.
- [ ] Sin consentimiento, el cierre avisa y deja constancia. El profesional decide.

**Ya falló:** al firmar pidió el consentimiento de la extracción que no se eligió; se pidió por los dos caminos en una consulta sin ningún acto, y no al abrir la sesión que lo hacía; la declaración no se veía en el enlace y faltaba la pieza; el enlace de firma abrió el consentimiento más antiguo, no el que se envió.

## O-ENV-01 Enviar un documento

**Dónde:** `S/financial-documents.ts` (comprobante y presupuesto en PDF), `S/health-documents.ts` (papeles de salud), `S/issued-papers.ts` (el papel emitido), `S/portal-papers.ts` (lo que ve en su portal).

- [ ] Enviar un documento manda el PDF. Enviar el portal manda el portal.
- [ ] El papel se emite una vez, con su huella, y es el mismo para verlo, enviarlo y descargarlo. Se ofrece el vigente, no el anulado ni el reemplazado.
- [ ] Los papeles de salud van solo a quien decide por el paciente.
- [ ] «Ya se le envió» se dice solo si salió. Un envío incierto no se reintenta solo, y el mismo documento no sale dos veces por doble clic o por dos caminos.
- [ ] La pantalla promete el canal por el que de verdad saldrá, y dice «no tiene por dónde» solo si es cierto.
- [ ] Fuera de las 24 horas de WhatsApp sale con la plantilla aprobada, y lo que se escribió junto al envío no se pierde.
- [ ] «Se ve en su portal» lo decide el servidor, con la misma regla que arma su lista.
- [ ] Ningún papel cambia un carácter por «?». La letra de los PDF no tiene «−», «≥», «≤», «≈», «→», «←», «∆» ni «✓»: `printable` (`S/document-kit.ts`, `STAND_INS`) escribe su equivalente, salvo en «✓». Un carácter nuevo en el texto de un papel se prueba ahí.
- [ ] Un signo y su importe no se separan al final de una línea: el signo va pegado («‒S/ 410.00»).

**Ya falló:** el signo menos salía «?» en la receta de lentes («?2,00»), en el descuento del presupuesto y en el saldo a favor del ticket, y en la primera versión del arreglo el «–» del descuento podía quedar solo al final de la línea; un documento se mandó como enlace en vez del PDF; enviar la orden dijo «no tiene WhatsApp ni correo» a quien tenía los dos; el resultado de una orden desapareció del portal y la ficha decía que se veía; «se ve en su portal» se calculaba en la pantalla con otra regla; el cajón prometió que el mensaje escrito «queda en la conversación» y con la plantilla se perdía.

## O-ENV-02 «Su enlace»

**Dónde:** `S/booking-links.ts`, `S/su-enlace.ts`, `S/personal-link-token.ts`, `S/patient-todo.ts` (lo que tiene por hacer).

- [ ] Uno por persona y paciente. Emitir otro renueva el vivo. El token no se guarda.
- [ ] Cada mensaje abre lo suyo: la firma, el presupuesto, la cita, los datos. Abre lo que se envió, no lo más antiguo.
- [ ] Vence a los 7 días y deja de servir cuando no queda nada pendiente. «Pendiente» tiene una sola definición.
- [ ] «Quitar enlace» lo corta en todos los caminos, también en los botones de los correos ya enviados.
- [ ] Reserva, cambia y cancela con las operaciones de la Agenda, sin reglas propias. Reservar vence la propuesta que esperaba el «sí» en el chat.
- [ ] Dos pestañas o un doble clic dejan una sola cita, y la segunda pestaña dice lo que pasó.
- [ ] Lo que promete («te escribiremos por WhatsApp») se dice solo si de verdad sale.
- [ ] «Tus datos» se envía una vez y pide solo lo que falta.

**Ya falló:** el enlace de firma y el de presupuesto abrieron el más antiguo; hubo tres definiciones de «pendiente»; se pudo reservar otra cita con un enlace que nunca ofreció reservar; en la segunda pestaña decía «Este enlace ya no sirve» con la cita ya reservada; prometió «por WhatsApp» a quien no recibe recordatorios.

## O-ENV-03 Mensajes automáticos y la baja

**Dónde:** `S/automation.ts`, `S/automation-routing.ts` (por dónde sale), `S/message-gate.ts` (permiso, ventana y hora), `S/automation-messages.ts`.

- [ ] Permiso, ventana, canal y hora se deciden en un solo lugar. Ningún envío los calcula por su cuenta.
- [ ] Como mucho un mensaje al día por persona. Prender una línea no escribe por lo anterior.
- [ ] El mensaje se arma al salir, con los datos de ese momento, y antes se mira si el motivo sigue en pie.
- [ ] «Ningún mensaje» apaga todo, también las despedidas. La pantalla no dice «el agente le avisa» si no saldrá.
- [ ] «Enviado» es que salió hacia el canal. Lo que el canal rechaza después pasa a fallido y alguien lo ve.
- [ ] Una conversación no se cierra sola con una pregunta de la persona sin responder.
- [ ] Un texto con un marcador sin resolver nunca llega a la pantalla ni a la persona.

**Ya falló:** escribió «BAJA» y al día siguiente le llegó «Cuando quieras retomar…»; la pantalla dijo «el agente le avisa» a quien había pedido ningún mensaje; reservó, preguntó algo más y la conversación se cerró a la hora; la Bandeja mostró el marcador del enlace sin resolver; respondieron el mismo tema desde dos pestañas y le llegaron dos precios.

## O-COM-01 Pagar comisiones

**Dónde:** `S/finance.ts` (las reglas, el mes, pagar, cerrar la deuda y anular el pago); la vista `commission_live` de la base.

- [ ] Lo aún sin pagar sale de una sola cuenta. Finanzas, Reportes, la hoja impresa y Argos dan el mismo «Ya pagado» y «Falta pagar».
- [ ] Un cobro, o su parte, entra en un solo pago. Pagar dos veces el mismo mes no paga dos veces.
- [ ] La regla es la del día de la atención. Cambiar el porcentaje no recalcula lo pasado, y lo pagado conserva la suya.
- [ ] Varias sesiones: cada cobro se reparte en partes iguales, cada una de quien hizo su sesión.
- [ ] Cada moneda se mira, se descuenta y se paga aparte.
- [ ] Lo anulado después de pagado se descuenta del siguiente pago de ese profesional, una vez. Anular un pago deshace también su descuento.
- [ ] A quien salió del equipo se le puede pagar lo pendiente, y los meses pasados no cambian solos.
- [ ] El pago dice con qué medio se pagó y si salió de la caja.

**Ya falló:** «por descontar» se restó entero en cada mes y bloqueó el pago; un tratamiento atendido por dos profesionales dio toda la comisión al primero; cambiar el porcentaje recalculó meses anteriores; el doble clic en «Pagar» mandó dos pedidos; anular el pago anterior dejó en pie su descuento; «Ya pagado» fue distinto en Finanzas, Reportes y Argos; el pago de una comisión decía «Otro medio».

## O-GAS-01 Registrar, corregir y anular un gasto

**Dónde:** `S/finance.ts` (registrar, corregir y anular), `S/expense-csv.ts` (la lista para el contador), `S/inventory.ts` (pagar una compra).

- [ ] El reintento tras un corte devuelve el mismo gasto: no quedan dos gastos ni dos salidas de caja.
- [ ] Corregir anula y registra en una transacción, y conserva lo que no se tocó: moneda, fecha, medio, comprobante y proveedor.
- [ ] Solo el efectivo sale de la caja. El medio queda congelado, como en un cobro.
- [ ] La fecha del gasto decide su mes, también el 31 y el 1.
- [ ] «Gastado» es lo mismo en Gastos y en Reportes. El pago del impuesto de lo cobrado no suma.
- [ ] Lo mismo pagado por dos caminos (un gasto suelto y una compra de Inventario) no se cuenta dos veces, o se avisa.
- [ ] El comprobante es el del país, con su número, en todos los lugares que crean gastos.
- [ ] Si dos personas corrigen a la vez, la segunda entiende qué pasó. Un rechazo llega antes de escribir el motivo, no después.

**Ya falló:** un reintento tras un corte dejó el gasto y la salida de caja dos veces; corregir un gasto de dólares a soles lo dejó en dólares; corregir la fecha a «hoy» no la cambió; «0,001» se guardó como 1.00; el material anotado como gasto y pagado después como compra quedó dos veces; pagar una compra perdió el tipo de comprobante; «Gastado» no fue lo que Reportes llamaba gasto.

## O-GAS-02 Lo que se repite y la factura por pagar

**Dónde:** `S/expense-recurring.ts`, `S/expense-recurring-occurrences.ts`, `S/expense-payable.ts`.

- [ ] Anotar no es pagar. Lo anotado sin pagar no sale de la caja ni queda «fuera de la caja» sin que nadie lo diga.
- [ ] «Pagar» muestra el importe y el medio antes de pagar.
- [ ] «Dejar de repetir» vale desde el mes que viene. No borra lo vencido ni lo de este mes.
- [ ] El mes de un gasto que se paga a mes vencido es el suyo, no el del día en que se paga.
- [ ] Un gasto suelto del mismo tipo y mes se une a lo que se repite, o se avisa.
- [ ] Cada pago de una factura es un gasto unido a ella y nunca pasa de lo que falta. Corregir el pago lo deja en su factura.
- [ ] Lo que se repite admite la otra moneda. Los enlaces entre Gastos y Reportes conservan el mes, la sede y el tipo.

**Ya falló:** «Pagar» pagó al instante con el importe de siempre; anotar un sueldo «todavía no» lo dio por pagado hoy; «Dejar de repetir» borró el mes vencido sin pagar; el sueldo del mes anterior salió vencido el día en que se paga; «Cambiar lo que se repite» al importe de siempre no cambió nada; lo que se repite dejó de poder anotarse en dólares; «Ver el reporte» abrió otro mes y «Pagar en Gastos» otra sede.

## O-CFG-01 Cambiar un archivo de la clínica (hoja membretada, logo)

**Dónde:** `S/letterhead.ts`, `API/letterhead.ts`, `S/document-clinic.ts` (la hoja que lleva cada papel).

- [ ] La vista previa usa el archivo que la persona tiene abierto, no «el de hoy» del servidor: si otra persona lo cambió o lo quitó, se dice, no se muestra el ajeno.
- [ ] Un archivo rechazado no deja activo guardar el anterior sin decirlo.
- [ ] Cada motivo de rechazo sale con su texto (clave o protección, dañado, peso, formato), comprobado con el archivo de verdad, no con `instanceof` de la librería.
- [ ] Lo que dibuja el navegador (franjas, miniatura) y lo que guarda el servidor (el PDF) dicen lo mismo, o el servidor lo rehace.
- [ ] Quitar, cambiar y deshacer llevan la versión que se tenía a la vista; el conflicto se dice.
- [ ] Los márgenes extremos dejan lugar a un papel corto entero en una hoja, o la vista previa lo avisa.
- [ ] Lo emitido conserva su versión; lo que se rehace al vuelo (anulados, comprobantes) usa la de su fecha, también los márgenes.

**Ya falló:** la vista previa de «Cambiar la hoja» mostró la hoja que otra persona acababa de subir y, quitada en otra pestaña, decía «Elige la hoja»; el aviso de PDF con clave nunca salía porque pdf-lib no lanza su clase; con 200 mm, una receta de un medicamento salió en dos hojas (QA del 11 nov, corregidos antes de unir).

## O-DOC-01 Subir un documento a la ficha y su fecha

**Dónde:** `S/clinical.ts` (`registerPatientDocument`, `correctDocumentContext`), `API/patients.ts` (`POST /:id/documents`) y `API/patient-document-context.ts`, `S/patient-history.ts` (la Historia), `S/dental/tooth-history.ts` (la pieza), `S/patient-record.ts` (la copia y el FHIR), `S/portal-papers.ts` (el portal).

- [ ] Hay dos fechas y no se mezclan: la del documento (`captured_at`, la que dice la persona) y la de subida (`created_at`, la que pone el servidor). La de subida no cambia y se ve donde se muestra la otra.
- [ ] «La fecha de un documento» es una sola regla (`captured_at`, y si falta `created_at`) y la usan igual Documentos, el visor, la Historia, la historia de la pieza, el detalle de la atención, el portal, el filtro desde/hasta, la copia y el FHIR (`attachment.creation`).
- [ ] Un día elegido no muestra una hora que nadie dijo.
- [ ] La fecha no es futura (5 minutos de margen).
- [ ] La fecha se corrige solo con una versión nueva del contexto, con su motivo y auditoría; la base rechaza cambiar `patient_document.captured_at` sin esa versión (`patient_document_date_guard`).
- [ ] Un documento retirado no sale como vigente en ninguna lista; en la Historia queda plegado con su motivo.
- [ ] La palabra de la fecha sigue a la categoría («toma» en una imagen, «del documento» en un papel).
- [ ] El diálogo que corrige la fecha guarda con la versión con la que se abrió: si otra persona cambió el archivo mientras tanto, lo dice y conserva lo escrito.
- [ ] Un botón de corregir no se ofrece donde el servidor siempre lo rechaza (el PDF que generó una firma, un archivo retirado).
- [ ] Los archivos con la misma fecha salen en un orden estable (el último subido primero).
- [ ] Una corrección que no cambia nada no crea una versión.

**Ya falló:** la Historia ponía por fecha de subida una radiografía con fecha de toma, mientras Documentos la ponía por su toma y la historia de la pieza por la subida; la copia imprimía 12:00 para un día elegido; la Historia mostraba un documento retirado como vigente (mesa del 12 nov); el diálogo de corregir la fecha guardaba encima de otra corrección sin avisar (QA del 12 nov, corregido antes de unir).
**Huecos conocidos:** el mismo envío dos veces deja dos documentos; no hay aviso si la fecha es anterior al nacimiento; el visor ofrece «Corregir la fecha» en el PDF que generó una firma y el servidor lo rechaza con su motivo.

## O-WEB-01 Una escena de la web que se mueve sola

**Dónde:** `apps/web/src/lib/steady.ts` (`useSteadyHeight`), `.fit`/`.fit-ghost` en `apps/web/src/styles/web.css`, cada demostración de `apps/web/src/components/**`; se comprueba con `apps/web/scripts/quietud.mjs`.

- [ ] Lo que se toca no se corre mientras nadie toca nada: al cargar, a 390, 820 y 1440 px.
- [ ] Tampoco al girar el teléfono o cambiar el ancho de la ventana a mitad de la animación.
- [ ] Tampoco cuando la escena pasa sola a una variante que no es la que se arma en el servidor (otro rol, otra pregunta, otro caso, «escribiendo…»).
- [ ] En pausa y con movimiento reducido, cada demostración se ve completa; sin JavaScript nada queda oculto ni apartado.
- [ ] Nada que se pueda tocar desaparece solo mientras la persona está encima.

**Ya falló:** las demostraciones crecían y se encogían y corrían hasta 384 enlaces y botones por web; al girar, el alto se volvía a medir a mitad de camino; la entrada de las secciones bajaba 16 px al cargar; en pausa, el chat de Sofi quedaba en blanco (2026-11-11).

## Casos

Un caso por operación, dicho como estado del dato. Se recorren en el código y, lo que se pueda, en la pantalla.

| Caso | Estado del dato | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| CO1 | Id roto: una cita, un cierre de caja y un gasto con un carácter de más en el id. | GEN-01 | «No existe» en los tres; ningún error del servidor. |
| CO2 | Repetido: la persona reserva desde su enlace con dos pestañas mientras recepción reserva el mismo hueco. | AGE-01, ENV-02 | Una sola cita; las otras dos dicen qué pasó. |
| CO3 | De otro día: la cita de ayer quedó sin atención, y otra cita se movió después de marcar la llegada. | AGE-02 | La de ayer pregunta si vino; la movida tiene sus recordatorios en la fecha nueva y sin llegada vieja. |
| CO4 | Repetido: se registra en línea alguien que ya tiene ficha con el mismo documento; a la vez, caja corrige esa ficha. | PER-01 | No se crea otra ficha ni se unen solas; nadie pisa al otro en silencio. |
| CO5 | A medias: un borrador de ayer en dos pestañas, con la sesión 2 de una endodoncia hecha por otro profesional antes de su cita. | ATE-01 | Nada se pierde; un solo tratamiento, «2 de 2», un solo cobro. |
| CO6 | Repetido: doble clic en firmar, pasada la medianoche, con un consentimiento que falta y un servicio con materiales. | ATE-02 | Una firma, un cargo, un descuento; fechas del día de la sede. |
| CO7 | Anulado: atención con receta, orden, control con cita y un tratamiento completado en ella. | ATE-03 | Todo cae o se reabre con ella; la cita del control no queda suelta. |
| CO8 | De otro día: control vencido de un colega; la persona viene hoy sin cita por otra cosa. | ATE-04 | No recibe «te buscamos un horario»; el vencido se resuelve o se pregunta. |
| CO9 | A medias: presupuesto con dos caminos sin elegir y una línea ya hecha y cobrada; se revisa un precio. | PRE-01 | Siguen los dos caminos; lo hecho sigue aceptado y con su precio. |
| CO10 | Otro rol: la persona acepta una parte en su enlace mientras recepción anota «lo piensa». | PRE-02 | Una respuesta vigente; la segunda se rechaza porque cambió; la tarea se cierra. |
| CO11 | Repetido y en el límite: cobro en dos monedas con vuelto, enviado dos veces con la cuenta ya cambiada. | COB-01 | Un ticket; el servidor avisa del cambio; nada queda a favor en silencio. |
| CO12 | Repetido: adelanto «para» una corona, usado en parte, y «Devolver dinero» enviado dos veces. | COB-02 | Una devolución; el resto a favor igual en ticket, cuenta y Resumen. |
| CO13 | Anulado: ticket de ayer, con la caja cerrada, que pagó un producto y una sesión ya comisionada y pagada. | COB-03, COM-01 | El stock vuelve una vez; el descuento va al siguiente pago de ese profesional; queda el movimiento. |
| CO14 | De otro día: consentimiento firmado por enlace anteayer por la madre; hoy el profesional abre otra atención. | CON-01 | Se confirma hoy, con el día real y a quién se informó; la hoja es la del papel. |
| CO15 | Anulado: se envía una receta, se anula y se emite otra; se reenvía fuera de las 24 horas. | ENV-01 | Sale la vigente, en PDF, una vez; el portal marca la anulada. |
| CO16 | Otro rol: el equipo quita el enlace y la persona toca el botón de un correo viejo. | ENV-02 | No abre nada vivo ni crea otro enlace. |
| CO17 | Otro estado: la persona escribe «BAJA» con una cita mañana y una conversación abierta. | ENV-03 | No recibe más que lo que eligió; el equipo ve a quién llamar. |
| CO18 | Repetido: gasto en dólares con comprobante, guardado tras un corte y corregido por dos personas a la vez. | GAS-01 | Un gasto; la corrección conserva moneda y fecha; la segunda persona entiende. |
| CO19 | De otro mes: sueldo de octubre anotado sin pagar, pagado en noviembre por otro importe; luego «Dejar de repetir». | GAS-02 | Cuenta en octubre; el pago sale cuando se paga; lo vencido no se borra. |
| CO20 | Repetido: la persona con dos citas por venir cancela una desde su enlace con dos pestañas abiertas. | AGE-02, ENV-02 | Una sola cancelada; la otra pestaña dice que ya estaba cancelada. |
| CO21 | En el borde: una cita de hoy a las 16:30 se estira o se mueve a las 12:00 cuando son las 13:00, y después «Vino». | AGE-02 | El cambio se rechaza o avisa que ya pasó; «Vino» deja quién y se deshace. |
| CO22 | Otro estado: recepción cancela y, con el cajón viejo en otra pestaña, alguien pulsa «Confirmar cita». | AGE-02 | La segunda recibe «la cita cambió»; la cita sigue cancelada. |
| CO23 | A medias: cita 17:30–18:00 al final del turno; «Editar detalles» le pone un servicio de 90 minutos. | AGE-02 | Avisa que sale del horario, como al mover, y queda rastro de qué cambió. |
| CO24 | Otro rol, a la vez: la dueña abre «Cambiar la hoja» y otra persona la reemplaza o la quita. | CFG-01 | La vista previa dice que la hoja cambió y no muestra la ajena; guardar o quitar no pisa la de la otra persona. |
| CO25 | De otro día: una radiografía de 2023 y una historia en papel de 2018–2024 se suben hoy con su fecha, y después se retira una. | DOC-01 | La misma fecha en todos los lugares; el retirado queda plegado en la Historia; ninguna hora inventada en el visor ni en la copia. |
| CO26 | Se equivoca y corrige: un informe sube con 2013 en vez de 2023, y dos personas corrigen la fecha a la vez. | DOC-01 | Se corrige con su motivo sin duplicar el archivo; la segunda recibe que el documento cambió. |
| CO27 | Otro rol, a la vez: Ana corrige la fecha de un archivo mientras Luis tiene «Corregir la fecha» abierto con la fecha vieja. | DOC-01 | Luis guarda y la pantalla le dice que el archivo cambió; su fecha y su motivo siguen ahí. |
