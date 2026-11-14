# Tareas de cada rol en su día

El catálogo de la voz novato: lo que recepción, caja, ventas y el paciente hacen en un día, y dónde tropieza quien lo hace por primera vez.
Es el piso, no el techo: el novato revisa las comprobaciones de las tareas que el área toca, una por una, y además arma sus propias tareas y hace sus giras.
Crece con lo que cada recorrido devuelve en «Para mi catálogo», y se poda: lo que ya no existe se quita y lo repetido se une.
Cada comprobación se mira en la pantalla, sin leer el código. «Ya falló» dice cómo tropezó alguien antes; no es una sospecha sobre el cambio de hoy.
Rutas: `R` = `packages/clinic-app/src/routes/`, `C` = `packages/clinic-app/src/components/`.

En toda tarea se prueban cuatro cosas, además de las suyas: **interrupción** (dejarla a medias y volver), **error propio** (equivocarse y corregir), **«¿se guardó?»** y **otro día** (lo que quedó de ayer).

---

## En toda tarea

- [ ] La Ayuda contesta cómo se hace esta tarea, preguntada con mis palabras, y con esa respuesta sola la termino.
- [ ] La Ayuda nombra los botones y las pantallas como los veo.
- [ ] La Ayuda no me dice que no se puede algo que sí puedo hacer.
- [ ] En la computadora, si ensancho el formulario de la derecha, sigo pudiendo usar la lista de atrás: sus botones de cada fila (como «Hecha») se ven, y lo que queda debajo se nota y se alcanza.

**Ya falló:** la Ayuda contestó sobre otra pantalla; con el formulario de la derecha ensanchado, la lista de Tareas se leía letra por letra y «Hecha» quedaba fuera de la vista sin aviso.

## Recepción

### T-REC-01 Registrar a un paciente nuevo y darle cita
**Dónde:** Pacientes (`R/_org/people.index.tsx`), «Nuevo paciente» (`C/person/new-person-drawer.tsx`) y «Nueva cita» (`C/agenda/booking-drawer.tsx`).
- [ ] Encuentro «Nuevo paciente» desde donde estoy, y antes de crearlo el sistema me dice si esa persona ya existe.
- [ ] Si falta algo, «Registrar» me lleva a lo que falta y lo dice con palabras. Nunca se queda sin hacer nada.
- [ ] Un campo en rojo dice qué tiene mal.
- [ ] Los textos tratan bien a un señor y a una señora («atenderlo», «él o ella»).
- [ ] Al terminar me ofrece reservar la cita ahí mismo, y «Nueva cita» dice en qué sede la estoy dando.
- [ ] Los textos de «Nueva cita» se entienden sin explicación.
- [ ] Si la persona ya tiene otra cita a esa hora, «Nueva cita» me avisa antes de reservar.
- [ ] ¿Se guardó? Veo su número de historia y, después de reservar, veo la cita en la agenda sin tener que buscarla.
- [ ] Interrupción: suena el teléfono, toco otra cita o cierro la hoja, y al volver lo escrito sigue ahí; no basta con preguntar antes de perderlo.
- [ ] Error propio: escribí mal el apellido o el celular y lo corrijo desde su ficha en pocos pasos.

**Ya falló:** «Registrar» no hacía nada y la pregunta que faltaba estaba más abajo, fuera de la vista; el celular quedaba en rojo sin mensaje; después de reservar, la agenda mostraba a otro doctor y la cita no se veía; «Faltan datos para atenderla» a un señor; cerrar «Nueva cita» a medias solo preguntaba, y «Descartar» lo perdía todo; una segunda cita a la misma hora se reservó sin aviso.

### T-REC-02 Registrar a un niño con su mamá o su papá
**Dónde:** «Nuevo paciente» (`C/person/new-person-drawer.tsx`) y «Nuevo contacto» (`C/inbox-new-conversation.tsx`).
- [ ] Al poner la fecha de nacimiento de un niño, la pantalla pide al responsable y me deja escribirlo ahí.
- [ ] Si el papá todavía no está en la clínica, lo registro sin salir y sin perder lo que escribí del niño.
- [ ] Si falta el teléfono del responsable, el aviso trae el campo para escribirlo.
- [ ] ¿Se guardó? La ficha del niño dice quién decide por él.
- [ ] Otro día: la mamá llama y la encuentro por su nombre, con el niño a su cargo.

**Ya falló:** crear al papá llevaba a otra página y se perdía el formulario del niño; el error pedía «el teléfono del responsable» sin un lugar para escribirlo.

### T-REC-03 Marcar que llegó, y «¿Vino?» de una cita pasada
**Dónde:** Inicio (`R/_org/home.tsx`, `C/home/today.tsx`, `C/home/row-panels.tsx`), la llegada (`C/agenda/arrival.tsx`), la cita (`C/agenda/appointment-drawer.tsx`) y la lista de la Agenda (`R/_org/agenda.tsx`).
- [ ] Marco «Llegó» en un toque desde Inicio o desde la cita, y sé que el doctor ya lo ve esperando.
- [ ] El número de personas que esperan es el mismo en el menú, en Inicio y en la sala.
- [ ] En una cita de ayer, «¿Vino?» me deja contestar, y la pantalla dice si me toca a mí o al doctor.
- [ ] En la lista de la Agenda, la cita que ya pasó dice «Sin cerrar», no «Por confirmar» ni «Confirmada», y el botón pregunta «¿Vino?» en vez de afirmar «No vino».
- [ ] ¿Se guardó? Sale un aviso con «Deshacer» y el panel deja de preguntar.
- [ ] Error propio: marqué al paciente equivocado y lo deshago.

**Ya falló:** «Llegó» no decía si el doctor se enteró; tres números distintos de «personas que esperan»; «Vino» se guardaba en silencio y el panel seguía mostrando «No vino / Vino»; en la lista de la Agenda, la cita pasada decía «Por confirmar» y el botón grande era «No vino».

### T-REC-04 Cambiar o cancelar una cita
**Dónde:** la cita (`C/agenda/appointment-drawer.tsx`) y elegir el horario (`C/agenda/when.tsx`), en la Agenda (`R/_org/agenda.tsx`).
- [ ] En el celular llego a los botones de cambiar y cancelar sin que nada los tape.
- [ ] Al cambiar, entiendo cómo pasar de la mañana a la tarde o a otro día.
- [ ] La hora que dice el botón «Mover…» no cambia sola. Si ese horario se ocupa mientras lo miro, la pantalla lo dice antes de mover.
- [ ] Al cancelar, me ofrece darle otro día, y la cita nueva conserva el servicio y el doctor.
- [ ] ¿Se guardó? Veo la cita en su nuevo horario y sé si a la persona le llegó un aviso.
- [ ] Error propio: moví la cita equivocada y la devuelvo a su hora.
- [ ] Otro día: la cita cancelada no sigue saliendo como pendiente.

**Ya falló:** en el celular la hoja no bajaba y los botones quedaban tapados; cancelar no ofrecía otro día y al reservar de nuevo se perdían el servicio y el doctor; no se entendía cómo pasar a la tarde; el botón «Mover a las 11:00» pasó solo a las 12:00 cuando otra persona ocupó las 11:00, y la cita quedó a las 12:00.

### T-REC-05 Confirmar por teléfono las citas de mañana
**Dónde:** Inicio (`C/home/today.tsx`) y la cita (`C/agenda/appointment-drawer.tsx`).
- [ ] Veo en una lista a quiénes llamar para mañana, con su teléfono.
- [ ] Dejo anotado qué pasó con cada llamada: confirmó, no contesta o pidió cambiar.
- [ ] Interrupción: corto la ronda de llamadas y al volver sé a quién ya llamé.
- [ ] Otro día: una cita que ya pasó no sigue «Por confirmar».

**Ya falló:** no había a quién llamar ni dónde anotar la llamada; citas pasadas seguían «Por confirmar».

### T-REC-06 Contestar en la Bandeja al que más espera
**Dónde:** la Bandeja (`R/_org/inbox.tsx`, `C/inbox/thread-view.tsx`, `C/inbox/topic-list.tsx`) y pasar el tema (`C/inbox/pass-topic-dialog.tsx`).
- [ ] Veo quién lleva más tiempo esperando.
- [ ] ¿Se guardó? Sé si mi respuesta le llegó. Si no salió, lo dice y me deja reintentar; el tema no queda como resuelto.
- [ ] Contestar no cierra el tema si lo que pidió sigue sin resolverse.
- [ ] Puedo pasarle el tema a caja o al doctor, y la lista dice quién es cada uno.
- [ ] Interrupción: dejo una respuesta a medias, abro otra conversación y al volver mi texto sigue ahí.
- [ ] Lo que hizo la persona desde su enlace (mover, cancelar) dice que lo hizo ella, no Sofi, y me avisa en Inicio.
- [ ] Otro día: lo que dice «Te toca» no está escondido entre las cerradas.

**Ya falló:** «Tema resuelto» aunque la respuesta no salió; la lista para pasar el tema no decía quién era caja; una conversación cerrada decía «Te toca»; un mensaje de la lista mostraba un código en vez del enlace; una cita cancelada desde el enlace no apareció en Inicio.

### T-REC-07 Decir cuánto cuesta algo y si hay promoción
**Dónde:** el buscador (`C/global-search.tsx`), Servicios (`R/_org/services.index.tsx`) y Promociones (`R/_org/services.promotions.tsx`).
- [ ] Busco como habla el paciente («limpieza», «curación», «sacar una muela») y encuentro el servicio y su precio.
- [ ] Si no hay resultados, el texto está bien escrito y me dice qué probar.
- [ ] Veo si hay una promoción vigente para ese servicio, sin sacar cuentas.
- [ ] Si me pierdo, la Ayuda responde sobre lo que estoy mirando.

**Ya falló:** «extracción», «muela», «limpieza» y «curación» no encontraban nada; el vacío decía «Ninguna prestación activas»; la Ayuda contestó sobre otra pantalla.

### T-REC-08 Cambiar su celular y los mensajes que quiere recibir
**Dónde:** la ficha (`R/_org/people.$personId.tsx`), Datos (`C/person/person-data.tsx`), el teléfono (`C/person/phone-whatsapp.tsx`) y sus mensajes (`C/patient/message-permissions-section.tsx`).
- [ ] Desde «editar sus datos» puedo cambiar el celular y la dirección.
- [ ] Un número de otro país se elige fácil y no queda en rojo si está bien.
- [ ] Después del cambio queda claro a qué número le llegan los recordatorios.
- [ ] «No quiere promociones» y «no quiere ningún mensaje» se anotan en pocos pasos, y dice cómo lo pidió.
- [ ] ¿Se guardó? La ficha muestra el número nuevo y si tiene WhatsApp.
- [ ] Error propio: puse un dígito mal y lo corrijo sin crear otro contacto.

**Ya falló:** «Editar datos personales» no tenía el teléfono; escribir el número con otro prefijo no cambiaba el país; quedaban dos WhatsApp sin decir cuál se usa; con el celular recién puesto, la ficha decía que no tenía WhatsApp.

### T-REC-09 Decirle qué le falta y cuándo le toca volver
**Dónde:** la ficha del paciente (`R/_org/patients.$patientId.tsx`), «Qué sigue» (`C/patient/plan/plan-next.tsx`) y reservar (`C/agenda/booking-drawer.tsx`).
- [ ] En la ficha veo su próxima cita y lo que le falta, con una sola etiqueta por tratamiento.
- [ ] Un control vencido aparece arriba y dice desde cuándo.
- [ ] Puedo dejar «un control en un mes» y queda como control, no como una cita suelta.
- [ ] Lo aceptado se reserva desde ahí, o se suma a una cita que ya tiene; si el tiempo no alcanza, me avisa.
- [ ] Al reservar me avisa si la persona no tiene teléfono ni correo para recordarle.
- [ ] ¿Se guardó? «Pendientes» no dice «sin pendientes» mientras todavía carga.
- [ ] Otro día: la sesión que quedó a medias ayer aparece como lo primero por reservar.

**Ya falló:** «Próxima cita: Ninguna» a una paciente que estaba en la sala; dos etiquetas que se contradecían en el mismo tratamiento; el control se guardaba como cita suelta; un control vencido hace meses no aparecía en pendientes; el servicio seguía elegido después de quitarle el visto.

### T-REC-10 Mandarle su enlace o su presupuesto
**Dónde:** «Su enlace» (`C/patient/send-personal-link.tsx`), la cita (`C/agenda/appointment-drawer.tsx`), el acceso al portal (`C/portal/portal-access-section.tsx`) y el presupuesto (`C/patient/plan/plan-budgets.tsx`).
- [ ] Sé qué enlace mando y para qué sirve: elegir cita, completar datos o ver sus cosas. No hay dos botones con nombres parecidos.
- [ ] Desde la cita hay un botón con nombre propio para mandar o copiar su enlace, falten datos o no.
- [ ] Veo el texto antes de enviarlo.
- [ ] ¿Se guardó? Dice «enviado» y por dónde, y si no pudo salir dice por qué.
- [ ] Después de enviar un presupuesto sé qué pasa con la conversación.
- [ ] Si le reservo una cita a quien escribió por el chat, sé si el sistema le avisó.
- [ ] Otro día: veo si abrió el enlace o respondió.

**Ya falló:** tres enlaces con nombres parecidos; dar el acceso estaba escondido y el botón a la vista cambiaba algo de toda la clínica; el cobro decía «pídele su correo» y no había dónde escribirlo; el enlace de la cita solo aparecía como «Copiar enlace» bajo «Faltan datos», y la Ayuda contestó que no se podía.

### T-REC-11 Seguir trabajando si se va el internet, y recibir avisos
**Dónde:** los avisos (`C/workspace-notifications.tsx`) y las notas de la persona (`C/person/person-notes.tsx`).
- [ ] Si se va el internet, la pantalla lo dice y lo que escribí sigue ahí.
- [ ] Al guardar sin internet me dice que no se guardó; no gira sin fin, y puedo cancelar.
- [ ] Cuando vuelve, guardo una vez y queda una sola nota.
- [ ] Al activar los avisos, la frase dice claro si me llegan con el programa cerrado.
- [ ] Si el navegador no puede, dice el motivo verdadero.

**Ya falló:** «Guardar» giró 40 segundos sin mensaje; el error mandaba a «revisar la conexión» cuando el problema era el navegador; después de dar el permiso, el interruptor seguía bloqueado.

### T-REC-12 Revisar la Agenda del día y encontrar una cita
**Dónde:** la Agenda (`R/_org/agenda.tsx`, vistas Día, Semana y lista), su buscador (`C/agenda/appointment-search.tsx`) e Inicio (`C/home/today.tsx`).
- [ ] Busco por el nombre a quien viene hoy y aparece primero, aunque su cita ya empezó.
- [ ] «Agenda de hoy» en Inicio da un total igual a la suma de sus grupos, también lo que pasó sin cerrar.
- [ ] La Semana dice en el título los mismos días que muestra.

**Ya falló:** el nombre no traía primero a quien venía hoy y su cita ya empezada no salía; el título decía seis días y se veían siete; el total de «Agenda de hoy» no era la suma de sus grupos.

### T-REC-13 Dejar en la ficha los papeles que trae un paciente nuevo
**Dónde:** la ficha (`R/_org/people.$personId.tsx`): Clínica › Documentos (quien atiende) y «Subir tomografía» (recepción).
- [ ] Desde recepción sé dónde dejar la historia escaneada y las radiografías, o la pantalla dice a quién dárselas (hoy recepción solo sube la tomografía).
- [ ] Cada papel lleva su fecha (la de la historia, el consentimiento o el informe), no solo la de subida, y la puedo corregir después sin retirar el archivo.
- [ ] El mismo papel tiene la misma fecha en Documentos y en la Historia.
- [ ] Con muchos papeles no repito la categoría ni la fecha uno por uno («Para todos»), también a 390 px.
- [ ] Interrupción: cierro el cajón a medias y, o me pregunta antes de perderlo, o lo elegido sigue ahí.
- [ ] ¿Se guardó? Después de subir, el botón dice «Listo», no «Cancelar».
- [ ] La Ayuda, preguntada con mis palabras («radiografías», «historia escaneada»), nombra una pantalla que mi rol sí tiene.
- [ ] Si el odontólogo no puede registrar pacientes, la pantalla o la Ayuda dicen quién sí (hoy la Ayuda le promete «Nuevo paciente»).
- [ ] La Ayuda habla de «fecha del documento» para un papel y de «fecha de toma» solo para una imagen.
- [ ] Hay un lugar claro para una historia escaneada de otra clínica (la Ayuda dice «Informe»).
- [ ] Al corregir la fecha, el visor no me saca de donde estaba sin decirlo (hoy salta de «1 de 6» a «6 de 6»).

**Ya falló:** «Subir tomografía» rechaza una radiografía y un PDF; una historia de 2018–2024 y un consentimiento de 2019 quedaban «Subida 12/11/2026»; una radiografía de marzo de 2024 salía bajo noviembre de 2026 en la Historia; la Ayuda mandó a recepción a una pestaña que no tiene (mesa del 12 nov); sin el modelo, la Ayuda no encontró «corregir la fecha» dicho con otras palabras (QA del 12 nov: se sumaron las frases).

---

## Caja

### T-CAJ-01 Cobrar lo que debe y entregar el ticket
**Dónde:** Finanzas (`R/_org/finance.tsx`), «Cobrar» (`C/finance/collect-drawer.tsx`), las deudas (`C/finance/debts-tab.tsx`) y el ticket (`C/finance/ticket-view.tsx`, `C/finance/ticket-panel.tsx`).
- [ ] Busco a la persona y veo cuánto debe y de qué, antes de cobrar.
- [ ] El botón dice el monto que voy a cobrar.
- [ ] El ticket dice qué pagó, cuánto le falta y cuánto le queda a favor.
- [ ] Puedo enviarlo o imprimirlo. Si no tiene WhatsApp ni correo, me deja escribir a dónde.
- [ ] ¿Se guardó? «Caja de hoy» sube con el cobro, en mi sede, y dice lo mismo en Inicio y en Finanzas.
- [ ] Interrupción: cierro el cajón a medias y me pregunta antes de perderlo.
- [ ] Error propio: cobré otro monto o a otra persona; puedo anular o devolver, también en el celular.
- [ ] Otro día: un pago de ayer se ve aplicado a lo que debía.

**Ya falló:** cobré en efectivo y «Caja de hoy» seguía en cero; el filtro «Deben» no decía cuánto debe cada uno; un pago salía hecho y el servicio seguía sin pagar; en el celular los botones de enviar, devolver y anular quedaban tapados.

### T-CAJ-02 Recibir un adelanto, y cobrar lo de un menor
**Dónde:** «Cobrar» (`C/finance/collect-drawer.tsx`) y el ticket (`C/finance/ticket-view.tsx`).
- [ ] Si no debe nada, la pantalla dice que es un adelanto y que queda a su favor.
- [ ] Si ya tenía saldo a favor, lo veo antes de cobrar.
- [ ] En un menor, quien paga es su representante, y se ve sin bajar la pantalla.
- [ ] El ticket dice quién pagó.

**Ya falló:** «Queda a cuenta de: lo que debe» en alguien que no debía nada; quién paga aparecía al final del cajón y en el celular no se veía.

### T-CAJ-03 Saber cuánto entró hoy y cerrar la caja
**Dónde:** «Cerrar caja» (`C/finance/cash-close-drawer.tsx`) en Finanzas.
- [ ] Encuentro «Cerrar caja» sin abrir menús escondidos.
- [ ] Mientras escribo los montos, los campos no saltan.
- [ ] «Entregas» y «Dejas en caja» se calculan solos y con dos decimales.
- [ ] Interrupción: salgo con el conteo a medias y me pregunta antes de perderlo.
- [ ] ¿Se guardó? Sé que la caja quedó cerrada y con cuánto.
- [ ] Otro día: la caja abre con lo que dejé ayer.

**Ya falló:** en la computadora «Cerrar caja» estaba dentro de «…»; los campos saltaban al escribir; «Dejas en caja» quedaba «0.000» y «Entregas» sin calcular.

### T-CAJ-04 Anotar un gasto del día y corregirlo
**Dónde:** Gastos (`C/finance/expenses-tab.tsx`) y el formulario (`C/finance/expense-form-drawer.tsx`, `C/finance/expense-money-fields.tsx`).
- [ ] Encuentro dónde anotar un gasto sin preguntar.
- [ ] Anotar un gasto chico pide lo justo: en qué, cuánto y con qué se pagó.
- [ ] Si pago con el efectivo de la caja y no alcanza, me dice cuánto hay y no pierdo lo escrito.
- [ ] Si ya hay uno parecido ese día o ese mes, me avisa antes de guardar.
- [ ] ¿Se guardó? Lo veo arriba en la lista, con su tipo y si salió de la caja, también en el celular.
- [ ] Error propio: puse S/ 42 y eran S/ 24; «Corregir» está a la vista y no tengo que anular y escribir todo de nuevo.
- [ ] Interrupción: salgo a mitad y al volver encuentro lo escrito, o me preguntó antes.
- [ ] La pantalla abre en la sede donde trabajo.

**Ya falló:** corregir obligaba a anular y reescribir; al corregir un gasto en efectivo, la cifra de la caja era falsa; lo escrito se perdía al salir; dejó anotar dos alquileres del mismo mes sin avisar; «Corregir» estaba escondido y solo se veía «Anular»; abría en otra sede.

### T-CAJ-05 Anotar una factura para pagar después, y pagarla en partes
**Dónde:** «Por pagar» (`C/finance/payables.tsx`) y Gastos (`C/finance/expenses-tab.tsx`).
- [ ] Desde «Registrar gasto» llego a «lo pago después».
- [ ] La factura guarda proveedor, número, importe y vencimiento, y avisa si el vencimiento es anterior a la emisión.
- [ ] Al pagar una parte, veo cuánto falta y cuándo vence.
- [ ] Si pago de más, el error me dice cuánto es lo máximo.
- [ ] ¿Se guardó? El aviso dice qué factura pagué y cuánto queda.
- [ ] Error propio: importe mal escrito; lo corrijo sin anular.
- [ ] Interrupción: salgo a mitad de anotar la factura y no pierdo lo escrito.
- [ ] Otro día: encuentro la factura, sus pagos y la anulada en el historial.
- [ ] «Descargar el mes» baja todo el mes y cuadra con lo que dice la pantalla.

**Ya falló:** anotar la factura perdía lo escrito al interrumpir; el aviso del pago decía solo «Gasto registrado»; la descarga bajaba solo lo filtrado, con el total del mes al lado; después de anular, el panel quedaba abierto y preguntaba «¿Salir sin guardar?»; dejaba escribir el motivo de anular para recién decir que no se podía.

### T-CAJ-06 Lo que se paga todos los meses
**Dónde:** «Lo que se repite» (`C/finance/recurring-due.tsx`).
- [ ] Dejo un gasto que se repite (alquiler, internet) con su día, y el mes siguiente me lo recuerda.
- [ ] Solo anotarlo no lo da por pagado.
- [ ] «Pagar» me muestra importe y medio antes de registrar.
- [ ] «Pagar otro importe» cambia solo este mes, o me pregunta si cambia los siguientes.
- [ ] Cerrar el cajón sin registrar no rompe la pantalla.
- [ ] Error propio: «Deshacer» devuelve el pago a «por pagar».
- [ ] Otro día: lo pagado «por mi lado» no queda además como por pagar.

**Ya falló:** «Pagar» registró al instante sin preguntar nada; cerrar «Pagar otro importe» tumbó Finanzas; «otro importe» cambió también los meses siguientes; la luz anotada aparte no se unió con la que estaba por pagar.

---

## Quien administra la clínica

### T-ADM-01 Poner la hoja membretada de la clínica en las recetas
**Dónde:** Configuración › Datos de la clínica › «Hoja membretada» (`CA/settings/clinic-letterhead.tsx`).
- [ ] La encuentro desde Configuración y, antes de guardarla, veo cómo sale una receta sobre ella.
- [ ] Error propio: marqué mal la casilla o un margen y lo corrijo sin volver a subirla.
- [ ] Quitarla y volver a ponerla con «Deshacer», también en el celular.
- [ ] La Ayuda me contesta con mis palabras («papel con el diseño de la clínica»).
- [ ] Una receta ya emitida dice con qué hoja salió.

### T-ADM-02 Decidir qué se le pregunta al paciente y tener mi propia ficha
**Dónde:** Configuración › «Preguntas al paciente» (`R/_org/settings.patient-registration.tsx`) y «Formularios propios» (`R/_org/settings.forms.tsx`); en la ficha, Clínica › Documentos (`C/patient/formularios-tab.tsx`).
- [ ] «Quiero mi propia ficha (ortodoncia, odontopediatría) para llenarla en la consulta, con medidas en mm y un Sí/No»: la encuentro desde Configuración sin la Ayuda y la veo al atender.
- [ ] «Mi paciente nuevo completa antes de venir lo mismo que preguntaba mi hoja de papel: nacimiento, DNI, alergias, medicación y embarazo»: lo que contesta aparece en Antecedentes de la ficha, y lo que puse como Opcional u Obligatorio se pregunta de verdad.
- [ ] «Quiero agregar una pregunta mía (¿toma anticoagulantes?) a lo que se le pregunta al paciente antes de venir»: sé dónde, el paciente la ve y su respuesta llega a la ficha.
- [ ] Interrupción: dejé una evaluación a medias por una llamada y vuelvo mañana; el borrador conserva lo escrito, también tras recargar y con un valor inválido.
- [ ] Error propio: publiqué una ficha por error o quiero cambiarle una pregunta; la pantalla dice cuál publica, y lo ya vigente se puede archivar.
- [ ] Le pregunto a la Ayuda lo mismo de tres formas, con mis palabras y no las de la pantalla: las tres llevan a la ruta.

---

## Ventas en óptica

Todavía sin tareas: ninguna ronda recorrió vistIA con la voz novato. La primera que lo haga suma aquí `T-VEN-01` y las que sigan (venta al paso, medida de la vista, montura y adelanto), con lo que vio en pantalla.

---

## Paciente o apoderado, desde su enlace

### T-PAC-01 Reservar su cita
**Dónde:** `R/public/reserva.tsx`, `C/public/choose-appointment.tsx`, `C/public/week-slots.tsx` y `C/booking-data-form.tsx`.
- [ ] Al abrir el enlace veo el nombre de mi clínica y sé que es de ellos.
- [ ] Elijo sede, doctor y hora en el celular sin perderme, y puedo decir si es para mí o para otra persona.
- [ ] Lo que me pide (documento, nacimiento) dice para qué es.
- [ ] ¿Se guardó? «Tu cita quedó reservada», con día, hora y cómo llegar.
- [ ] Error propio: elegí mal la hora y vuelvo un paso sin empezar de cero.
- [ ] Otro día: abro el mismo enlace y veo mi cita, no el formulario otra vez.

**Ya falló:** con una cita ya reservada no había cómo pedir otra, para un hijo o para otro tratamiento, ni un texto que dijera qué hacer; todo se reservaba como «Consulta» sin poder elegir a qué viene.

### T-PAC-02 Confirmar, cambiar o cancelar su cita
**Dónde:** `C/public/personal-link-page.tsx` y `C/public/appointment-block.tsx`.
- [ ] Veo primero mi cita, con Confirmar, Cambiar y Cancelar.
- [ ] Al cambiar, entiendo que es la misma cita en otro horario.
- [ ] Antes de cancelar me dice qué cita es y qué pasa con el horario, bien escrito.
- [ ] ¿Se guardó? «Confirmada», «quedó cambiada» o «quedó cancelada», con la fecha.
- [ ] Error propio: cancelé sin querer y la página me deja reservar de nuevo o me dice a quién escribir.

**Ya falló:** después de cancelar, el enlace ya no dejaba reservar ni decía qué hacer; el diálogo de cancelar decía «9:00 a. m..», con doble punto.

### T-PAC-03 Completar sus datos antes de la cita
**Dónde:** `R/public/registro.tsx`, `C/public/personal-data-form.tsx` y `C/public/link-steps.tsx`.
- [ ] El enlace abre en mi cita o en lo que me pidieron, no en un formulario largo sin explicación.
- [ ] Sé cuántos pasos son y cuántos me faltan, y el número coincide con la lista.
- [ ] Interrupción: cierro a mitad y al volver sigo donde me quedé.
- [ ] Si ya estoy registrado, la página dice para qué más sirve (registrar a mi hijo o a un familiar).
- [ ] «Te escribimos por WhatsApp» solo sale si tengo WhatsApp con la clínica.

**Ya falló:** el enlace abría en «Paso 1 de 5» y la cita quedaba detrás de un botón; «Faltan 4» y la lista nombraba más cosas.

### T-PAC-04 Firmar un papel y responder su presupuesto
**Dónde:** «Tus pendientes» (`R/public/pendientes.tsx`), `C/public/link-steps.tsx` y `C/public/budget-responder.tsx`.
- [ ] Arriba dice mi clínica, mi doctor y de quién es el papel. Si es de mi hijo o mi nieto, lo dice con su nombre.
- [ ] Cada fila dice qué me va a pedir; «tus datos» dice qué datos.
- [ ] Si la firma me salió mal, puedo limpiarla antes de enviar. Después de firmar dice cómo cambiar algo.
- [ ] ¿Se guardó? Un mensaje claro de que la firma llegó a la clínica, antes de mostrar lo que falta.
- [ ] En el presupuesto entiendo que aceptar no es pagar, y que «después» no lo pierde.
- [ ] Otro día: si el enlace venció, dice que no perdí nada y a dónde me llega el nuevo.
- [ ] Se lee y se usa a 390 px, sin palabras de doctor que no entiendo.

### T-PAC-05 Elegir qué mensajes quiere recibir
**Dónde:** `R/public/baja.$token.tsx` y «Tus mensajes» en `C/public/personal-link-page.tsx`.
- [ ] Si escribo que no quiero más mensajes, la respuesta dice qué dejo de recibir y qué me seguirá llegando.
- [ ] Los interruptores se entienden sin ayuda.
- [ ] ¿Se guardó? Lo que elegí queda igual al volver a abrir.
- [ ] En la clínica, recepción ve lo mismo que yo elegí y cómo lo pedí.
- [ ] «Recordatorios de tus citas: sí» sale solo si la clínica de verdad los envía.

**Ya falló:** decía «Recordatorios de tus citas: sí» en una clínica que no los envía.

---

### T-WEB-01 Visitante: decidir si pide una invitación
**Dónde:** las tres webs públicas (`apps/web`), en el teléfono primero.
- [ ] Ya soy cliente: entro a mi cuenta desde cualquier punto de la página, en un toque.
- [ ] ¿Cuánto me cuesta y cómo empiezo? La oferta (cuota, regalo, prueba, plan) dice lo mismo en la portada, en precios, en las preguntas y en el pie, y cada web nombra solo su marca.
- [ ] Pauso el movimiento para leer: cada demostración queda completa.
- [ ] Toco lo que parece un botón en una demostración: o responde o no parece botón, y nada que se pueda tocar desaparece solo.
- [ ] ¿Puedo traer mis pacientes de mi Excel y llevármelos si me voy? Las tres webs lo responden igual.

**Ya falló:** en pausa el chat de Sofi quedaba en blanco; los horarios de la demostración se elegían solos a los 6 s; «Ingresar» no estaba a mitad de página.

## Casos

| Caso | Situación | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| CT1 | «Llegó la señora Maribel Chávez, es nueva. Regístrala y dale limpieza para mañana a las 10.» Suena el teléfono a mitad. | REC-01 | No pierde lo escrito; queda con historia y cita, y la ve en la agenda. |
| CT2 | «Vino el señor Óscar con su hijo Bruno, de 7 años. El niño es el paciente y el papá no está registrado.» | REC-02 | Registra a los dos sin salir; la ficha de Bruno dice que decide Óscar. |
| CT3 | «Ya llegó la paciente de las 9:30. Y la de ayer a las 5, ¿vino?» | REC-03 | El doctor la ve esperando; la de ayer queda contestada, con aviso. |
| CT4 | «Llama la mamá de Thiago: no puede el jueves a las 4, quiere el viernes en la tarde.» En el celular; primero mueve la cita de otro niño. | REC-04 | Corrige su error y la cita queda el viernes, con el mismo servicio y doctor. |
| CT5 | «Son las 6: llama a los de mañana para confirmar.» Uno no contesta y otra pide cambiar. | REC-05, REC-04 | Queda anotado qué pasó con cada uno; mañana no hay que adivinar. |
| CT6 | «Hay cuatro esperando en la Bandeja. Contesta al que más espera; pregunta por un pago.» | REC-06 | Sabe que le llegó; el tema pasa a caja y no queda como resuelto. |
| CT7 | «¿Cuánto cuesta sacar una muela? ¿Hay promoción de limpieza?», por teléfono. | REC-07 | Responde en menos de un minuto, con las palabras del paciente. |
| CT8 | «La señora Nora cambió de número, ahora vive fuera y no quiere promociones.» | REC-08 | Un solo número, del país correcto; solo las promociones apagadas. |
| CT9 | «¿Qué le falta a don Ernesto y cuándo le toca?» Ayer quedó en la sesión 1 de 2 y aceptó una limpieza. | REC-09 | Ve la sesión 2 primero y suma la limpieza a esa cita. |
| CT10 | «Mándale a Julia su presupuesto y el enlace para que elija su cita.» Mañana: ¿respondió? | REC-10 | Sabe qué envió y por dónde; al otro día ve si lo abrió. |
| CT11 | «El joven paga lo que debe, S/ 180 en efectivo, y quiere su comprobante.» Primero escribe S/ 108. | CAJ-01 | Corrige el monto; el ticket dice que no debe nada y la caja sube S/ 180. |
| CT12 | «La mamá de Bruno deja S/ 50 a cuenta de la ortodoncia.» | CAJ-02 | Adelanto a favor de Bruno; pagó su mamá y el ticket lo dice. |
| CT13 | «Son las 8, cierra la caja: hay S/ 640 en efectivo y dejas S/ 100 para mañana.» | CAJ-03 | Entrega S/ 540; al otro día abre con S/ 100. |
| CT14 | «Compré algodón y gasas, S/ 42 en efectivo, con boleta.» Después: eran S/ 24. | CAJ-04 | Lo anota y lo corrige sin anular; la caja queda bien. |
| CT15 | «Llegó la factura del laboratorio, S/ 250, se paga a fin de mes.» Paga S/ 100 por Yape hoy y el resto otro día; el contador pide la lista del mes. | CAJ-05 | Faltan S/ 150 y dice cuándo vence; la lista baja completa. |
| CT16 | «El internet es S/ 199 el 5 de cada mes; este mes llegó S/ 215.» | CAJ-06 | Paga S/ 215 este mes y el siguiente vuelve a recordar S/ 199. |
| CT17 | Una señora de 54 años recibe el enlace, reserva para el martes, se equivoca y cancela; después quiere otra cita para su nieto. | PAC-01, PAC-02 | Puede reservar otra vez y para otra persona, o la página dice qué hacer. |
| CT18 | Dos días antes de la cita abre «tres cosas por hacer»: firma el consentimiento de su nieto, deja el presupuesto para después y lo abre una semana más tarde. | PAC-03, PAC-04 | Sabe de quién es el papel y que la firma llegó; el enlace vencido no la asusta. |
| CT19 | «Ya no quiero promociones, pero sí que me recuerden mi cita.» | PAC-05, REC-08 | Queda como lo pidió, y recepción ve lo mismo. |
| CT20 | «Llama: no puede a las 10, ¿a las 11?» Mientras tanto, otra recepcionista reserva las 11. | REC-04 | La cita queda a las 11, o la pantalla avisa que se ocupó antes de mover. |
| CT21 | La paciente cancela por error desde su enlace y lo vuelve a abrir. | PAC-02, REC-06 | Puede reservar otra o ve a quién escribir; recepción ve la cancelación en Inicio. |
| CT22 | «¿A qué hora venía la señora Dora?» Su cita de hoy ya empezó. | REC-12 | La encuentra por su nombre, primera, con su cita de hoy. |
| CT23 | «Llegó un paciente de otra clínica con su historia escaneada de 2018 a 2024 y una radiografía. Déjalas en su ficha para que el doctor las vea.» | REC-01, REC-13 | La historia queda con su fecha, no con la de hoy; la radiografía en la fecha en que se tomó, igual en Documentos y en la Historia. |
| CT24 | «Hoy trae seis papeles juntos: tres radiografías, un consentimiento de 2019, un informe de 2023 y una foto.» En el celular. | REC-13 | Los sube sin repetir la categoría seis veces y cada uno queda en su año. |
