# Medidas de las tareas frecuentes

El catálogo de la voz de diseño UX: las tareas que más se repiten en un día, con sus pasos medidos, para saber si un cambio las mejora o las empeora. Es el piso, no el techo: la voz revisa las tareas que el área toca, vuelve a medirlas y además arma sus casos y sus giras. Cada ronda vuelve a medir y actualiza la línea base (la fecha la da git). Crece con lo que la voz devuelve en «Para mi catálogo», y se poda lo que ya no existe.

**Cómo se mide:** pantallas, cajones, clics o toques, tecleos (campos escritos), saltos (salir de donde estaba) y decisiones, siempre con el ancho. «A mantener» = no debe subir. «A mejorar» = todavía cuesta de más. «Medida vieja» = la pantalla cambió después; se mide de nuevo antes de comparar. Una voz simulada contó estos pasos: no es el tiempo de una clínica real.

**Abreviaturas:** `CA` = `packages/clinic-app/src/components/`, `R` = `packages/clinic-app/src/routes/_org/`, `UP` = `packages/ui-patterns/src/`, `UI` = `packages/ui/src/components/`, `A` = `apps/admin/src/`. Cuántas veces al día se hace cada tarea es **supuesto** en todas: ninguna tiene fuente de una clínica real.

**Lista común** (se revisa en cada tarea, además de lo propio):

- Fluido: no interrumpe, no cambia de pantalla ni pide decidir sin necesidad.
- Intuitivo: lo frecuente se descubre solo y con las palabras de quien lo usa.
- Límites: lo que no se puede se dice donde ocurre, con su salida.
- Estados: vacío, cargando, error, a medias y hecho; pendiente ≠ confirmado.
- Recuperación: conserva el borrador y deja corregir sin rehacer.
- Teclado de punta a punta y 390 px sin desplazamiento lateral.
- Coherente: se comporta como la misma acción en el resto de la app.

## Atención

### M-ATE-01 Consulta nueva, de «Atender» a firmar
**Quién:** odontólogo; varias veces al día (supuesto).
**Dónde:** `R/patients.$patientId.encounters.$encounterId.tsx`, `CA/patient/encounter-editor.tsx`, `encounter-visit.tsx` («Hoy viene a…»), `encounter-plan-panel.tsx`.
**Medida:** unos 45 clics, 1 página, 0 saltos, con hallazgo, diagnóstico, dos opciones, respuesta y firma (1464 px). **A mejorar.**

- [ ] Todo ocurre en una página; el odontograma sigue a la vista.
- [ ] Al indicar, el formulario hereda la pieza y el diagnóstico: no se escriben dos veces.
- [ ] Un servicio que no va con la pieza (molar, temporal) avisa y ofrece el correcto ahí mismo.
- [ ] El presupuesto va en una línea, con un solo botón.
- [ ] «Indicado hoy» no se lee como «hecho hoy».
- [ ] A 390 px las filas del Plan se leen sin desplazamiento lateral.
**Ya falló:** una pantalla en blanco que no sabía a qué venía el paciente; cajones apilados para cada dato.
**Patrones:** `PageNotice` y `NoticeStrip` (`UP/`) para el aviso con su botón; `Field` (`UI/field.tsx`).

### M-ATE-02 La sesión que sigue («Continuar hoy»)
**Quién:** odontólogo; varias veces al día (supuesto).
**Dónde:** `CA/patient/encounter-visit.tsx`, `encounter-procedures.tsx`.
**Medida:** 7 clics hasta firmar; unos 9 contando hasta «Atención finalizada» (1440 px). 0 saltos. **A mantener.**

- [ ] «Hoy viene a…» nombra la sesión, la pieza y el número correcto («sesión 2 de 2»).
- [ ] Motivo, diagnóstico y sesión llegan en un toque, igual con cita que sin cita.
- [ ] El diagnóstico que propone es el del tratamiento, no uno ya resuelto de la misma pieza.
- [ ] Al llegar a las sesiones previstas, «Sí, terminar» viene marcado.
- [ ] Si la sesión se hace antes de su cita, la cita que queda sin objeto se decide antes de salir y no se pierde con «Listo».
**Ya falló:** volver a escribir el diagnóstico de la sesión anterior; «sesión 1 de 2» haciendo la 2; la cita huérfana que nadie decide.
**Patrones:** la fila de `CA/patient/next-up.tsx`; `freed-appointments.tsx`.

### M-ATE-03 Cerrar y firmar
**Quién:** odontólogo; una vez por atención (supuesto).
**Dónde:** `CA/patient/encounter-closing.tsx`.
**Medida:** 11 bloques antes de firmar; pide 4 decisiones y 1 era necesaria (el motivo del consentimiento). A 1440 px los controles quedan bajo el pliegue; a 390 px, unas 4 pantallas de desplazamiento. **A mejorar.**

- [ ] Lo que se decide va antes que lo que solo se lee.
- [ ] Controles, «¿Cuándo vuelve?» y el resumen dicen lo mismo; quitar un control cambia el resumen.
- [ ] El botón «Finalizar y firmar» no cambia de lugar cuando cambia el texto del estado.
- [ ] Escape, mientras se edita una fecha, cierra solo esa edición; reabrir conserva lo elegido.
- [ ] «Quitar» un control da «Deshacer».
- [ ] Seguir sin consentimiento es un toque («Urgencia», «Lo firmó en papel», «Otro motivo»), sin campo rojo vacío.
- [ ] Una atención abierta ayer no dice «hoy» ni propone una hora de fin de hoy.
**Ya falló:** tres listas con tres fuentes distintas en el mismo cierre; una decisión que vive en un aviso que se cierra.
**Patrones:** `ConfirmDialog` (`UP/confirm-dialog.tsx`); `CA/choice-buttons.tsx`; `DatePickerButton` (`UP/`).

### M-ATE-04 Corregir: quitar, cambiar o anular
**Quién:** odontólogo; alguna vez al día (supuesto).
**Dónde:** `CA/patient/encounter-plan-panel.tsx` («Cambiar», «Quitar»), `encounter-void-dialog.tsx`.
**Medida:** «Quitar» 1 clic; «Cambiar» unos 6 clics; anular 3 clics más el motivo, también con presupuesto (1464 px). **A mantener.**

- [ ] «Quitar» no pide confirmar, pero ofrece «Deshacer».
- [ ] «Cambiar» pide lo mismo que «Indicar» (sesiones y fase) y no deja datos del servicio anterior.
- [ ] Anular dice qué más se anula (el presupuesto, con su número) antes de confirmar.
- [ ] Lo que frena una anulación se dice con su salida, no con un aviso sin botón.
- [ ] Después de anular, el Plan queda limpio y la atención anulada no ofrece acciones que ya no sirven.
**Ya falló:** equivocarse costaba 14 clics por 4 pantallas y dejaba renglones tachados.
**Patrones:** `ConfirmDialog` con hijos; el aviso con «Deshacer» de `UI/sonner.tsx`, como en `CA/agenda/arrival.tsx`.

### M-ATE-05 Preparar la atención y preguntar los antecedentes
**Quién:** odontólogo; antes de cada paciente (supuesto).
**Dónde:** `CA/home/today.tsx` («Mis pacientes de hoy»), `CA/patient/patient-header.tsx`, `antecedentes-tab.tsx`, `health-review-notice.tsx`.
**Medida:** 1 clic desde Inicio; alergias y alertas a 0 clics; los antecedentes se responden con 3 toques (1440 px). **A mantener.**

- [ ] Alergia, enfermedad y medicación se ven en la cabecera en todas las pestañas, sin abrir nada.
- [ ] Lo declarado por el paciente se distingue de lo confirmado por el profesional.
- [ ] El aviso de revisar no frena «Atender».
- [ ] A 390 px la cabecera no tapa la acción principal.
**Ya falló:** un «sin antecedentes» que nadie había preguntado.
**Patrones:** `NoticeStrip` (`UP/notice-strip.tsx`); `DetailList` de `UP/detail/detail-rows.tsx`.

## Ficha

### M-FIC-01 Encontrar al paciente y saber qué sigue
**Quién:** recepción; decenas de veces al día (supuesto).
**Dónde:** `CA/global-search.tsx`, `R/patients.index.tsx`, `CA/patient/patient-header.tsx`, `resumen-tab.tsx`, `next-up.tsx`.
**Medida:** 2 o 3 clics hasta la ficha (con Enter abre el primero); próxima cita, alergias y lo pendiente a 0 clics (1440 px). **A mantener.**

- [ ] El primero de la búsqueda es la persona, y Enter abre su ficha.
- [ ] Con homónimos se distingue quién es quién sin abrir cada uno.
- [ ] «Qué sigue» es una sola lista, con un botón por fila que nombra su objeto.
- [ ] Recargar con la búsqueda escrita no rompe la página.
- [ ] A 390 px se llega a «Qué sigue» sin pasar por un menú de secciones.
**Ya falló:** dos «Reservar cita» para lo mismo; una fila que repetía como pendiente algo ya aceptado.
**Patrones:** `FilterBar` y `search-input` (`UP/list-filtering/`); `SectionNav` (`UP/section-nav/`).

### M-FIC-02 Registrar a un paciente (adulto o menor)
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/patient/new-patient-drawer.tsx`, `CA/person/person-links.tsx` («Registrar a alguien a su cargo»), `CA/person-picker.tsx`.
**Medida:** adulto, unos 9 clics en 1 cajón; menor con su representante, 7 clics en 1 cajón (1440 px). **A mantener.**

- [ ] El menor se registra con su responsable en el mismo cajón, sin crear antes otra ficha.
- [ ] Lo que falta (un documento) no frena: queda en «Faltan datos».
- [ ] Un teléfono que ya es de otra persona se avisa igual al registrar que al editar.
- [ ] El formulario no se mueve bajo el dedo cuando aparece la edad.
- [ ] El país del teléfono se elige sin recorrer una lista larga.
**Ya falló:** unos 18 toques, 3 cajones y una página ajena para un menor; un error que pedía un campo que no estaba en pantalla.
**Patrones:** `FormDrawer` (`UP/form/form-drawer.tsx`); `PhoneInput` (`UP/phone/`); `useDraftBlocker` (`UP/draft-blocker.ts`).

### M-FIC-03 Anotar su salud: alergia, enfermedad y medicación
**Quién:** recepción o el profesional; en cada paciente nuevo (supuesto).
**Dónde:** `CA/patient/allergies-card.tsx`, `allergen-picker.tsx`, `antecedentes-tab.tsx`, `diagnosis-search.tsx`, `medication-picker.tsx`.
**Medida:** una alergia, 5 clics; una enfermedad con su medicación, unos 14 clics; editar el teléfono, 4 (1440 px). **La alergia, a mantener; la enfermedad con medicación, a mejorar.**

- [ ] La búsqueda trae primero lo común («hipertensión» antes que una variante rara).
- [ ] Cada acción sale una sola vez en la fila.
- [ ] Lo guardado aparece al momento en la cabecera.
- [ ] Lo mismo dicho con dos nombres no entra repetido.
**Ya falló:** el buscador de diagnósticos ordenado por código y no por uso.
**Patrones:** `UI/combobox.tsx`; `CA/official-code-field.tsx`.

### M-FIC-04 El presupuesto: qué respondió
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/patient/plan/budget-response.tsx`, `budget-no-answer.tsx`, `next-step-action.tsx`, `plan-budgets.tsx`.
**Medida:** «¿Qué respondió?», 4 clics; «No contesta», 2 clics; el presupuesto se arma solo al firmar, 0 clics (1440 px). **A mantener.**

- [ ] La respuesta se anota sin imprimir ni enviar.
- [ ] Después de responder, cada fila dice solo lo que falta decidir, con su monto.
- [ ] «Volver a llamar» avisa si ese día ya tiene cita.
- [ ] Un botón que crea algo en el acto lo dice antes.
**Ya falló:** anotar un «sí» pedía 6 clics, 2 saltos e imprimir; una opción no elegida volvía a contarse como pendiente.
**Patrones:** `RowActions` (`UP/row-actions.tsx`); `CA/choice-buttons.tsx`.

### M-FIC-05 Reservar lo aceptado
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/patient/plan/next-step-action.tsx` («Sumar a su cita»), `CA/agenda/booking-drawer.tsx`, `CA/patient/follow-up-scheduler.tsx`.
**Medida:** reservar una cita desde la ficha, 5 clics; «Sumar a su cita», 1 clic con «Deshacer»; reservar la sesión que sigue, 3 clics y 0 saltos (1440 px). **A mantener.**

- [ ] El cajón abre con el tratamiento, la sesión y el servicio ya puestos.
- [ ] La cita a la que se sumó algo lo dice en la cabecera, en Citas y en su cajón, y avisa si queda corta.
- [ ] El servicio se encuentra con la palabra que usa recepción.
- [ ] No se ofrecen horas que ya pasaron.
- [ ] Si quien lo indicó no atiende en esa sede, se dice arriba, no bajo la grilla.
**Ya falló:** 8 clics y 1 salto para la sesión 2; un aviso de duración que solo salía en un mensaje que desaparece.
**Patrones:** `FormDrawer`; `UP/schedule/`; `CA/agenda/when.tsx`.

## Agenda

En todas las tareas de Agenda, además de lo propio:
- [ ] Se hace de punta a punta con teclado (crear el bloque de hora, elegir, guardar) y cada botón tiene nombre para el lector de pantalla.

### M-AGE-01 Mover una cita
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `R/agenda.tsx`, `CA/agenda/appointment-drawer.tsx` («Reprogramar»), `CA/agenda/when.tsx`.
**Medida:** 3 toques en 1 cajón desde la cita (5 desde la Agenda, contando el profesional y la cita); 0 saltos; conserva profesional y servicio (390 px). **A mantener.**

- [ ] Quien quiere cancelar para dar otro día encuentra «Reprogramar» antes de cancelar.
- [ ] A 390 px el botón no queda tapado por el pie del cajón.
- [ ] Ni la hora ni el profesional propuestos cambian solos («Cualquiera» incluido). Si la hora se ocupa, se dice ahí con «Usar su próximo hueco».
- [ ] Dice que es la misma cita en otro horario.
**Ya falló:** cancelar y crear otra costaba unos 10 toques, 1 diálogo y 2 cajones, y perdía el servicio; el botón «Mover … a las 11:00» pasó solo a las 12:00 cuando otra persona ocupó la hora.
**Patrones:** `ConfirmDialog`; `DetailDrawer` (`UP/detail/detail-drawer.tsx`) con las acciones en el pie; el aviso de hora ocupada de `CA/agenda/when.tsx`.

### M-AGE-02 Marcar que llegó o que vino
**Quién:** recepción; una vez por paciente, y cada día por lo que quedó sin cerrar (supuesto).
**Dónde:** `CA/agenda/arrival.tsx`, `CA/home/today.tsx`, `row-panels.tsx` (`VisitPanel`), `waiting-list.tsx`, `R/agenda.tsx` (lista «Ya pasaron · sin cerrar»), `CA/agenda/appointment-drawer.tsx`.
**Medida:** «Llegó», 2 toques, con «Deshacer» (390 px). Cita pasada (1440 px): Inicio pregunta «¿Vino?», 2 clics por respuesta; la lista da «No vino» en 1 toque, y «Vino» solo en el cajón (2 clics); el cajón pone «Llegó» como principal. **A mejorar** (meta: la misma pregunta en los tres lugares, 2 clics).

- [ ] El aviso confirma y trae «Deshacer».
- [ ] «Vino» dice antes de pulsar qué hace, y confirma después.
- [ ] El texto de la fila y el del panel dicen lo mismo: la cita pasada dice «Sin cerrar», no «Confirmada» ni «Por confirmar».
- [ ] Inicio, la lista y el cajón de la Agenda preguntan «¿Vino?» con las mismas dos respuestas, y nombran igual la cita, con lo sumado.
- [ ] En una cita que pasó hace horas, «Llegó» no es el botón principal.
**Ya falló:** un panel que se cierra en silencio; «¿Vino?» que abría otra cosa; «No vino» como botón grande de la lista y «Vino» ausente de la fila.
**Patrones:** el aviso con «Deshacer» de `UI/sonner.tsx`; `VisitPanel` de `CA/home/row-panels.tsx`.

### M-AGE-03 Registrar a alguien nuevo y darle cita desde la Agenda
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/agenda/booking-drawer.tsx` («Registrar paciente nuevo»), `CA/agenda/when.tsx`.
**Medida:** 11 clics y 4 tecleos, 1 cajón, 0 saltos, 4 decisiones, unas 81 palabras antes de reservar (1440 px). **A mantener.**

- [ ] La hora propuesta no cambia sola; si se ocupa, se dice ahí con «Usar su próximo hueco».
- [ ] Tocar otra cita a mitad del borrador la abre encima y, al volver, el borrador sigue. Cerrar con × tampoco lo pierde.
**Ya falló:** cerrar «Nueva cita» a medias solo preguntaba, y «Descartar» perdía todo.
**Patrones:** `CA/choice-buttons.tsx`; el aviso de hora ocupada de `CA/agenda/when.tsx`.

### M-AGE-04 Mandarle el enlace de su cita
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/agenda/appointment-drawer.tsx`, `CA/patient/send-personal-link.tsx` (`PersonalLinkActions`), `CA/patient/resumen-tab.tsx`.
**Medida:** 2 clics y 0 saltos bajo «Datos › Completar» si le faltan datos; sin camino si no le faltan; unos 25 clics y 2 saltos para quien no lo conoce (1440 px). **A mejorar** (meta: 1 o 2 clics con su nombre, siempre).

- [ ] Desde la cita hay una acción con nombre propio («Su enlace»), falten datos o no.
- [ ] Si no se puede enviar, dice por qué ahí y deja copiar o mostrar el código.
- [ ] La Ayuda contesta dónde está.
**Ya falló:** el enlace solo aparecía como «Copiar enlace» bajo «Faltan datos», y la Ayuda contestó «No.».
**Patrones:** `PersonalLinkActions`.

## Enlace del paciente

### M-PAC-01 La paciente cancela desde su enlace y quiere otra
**Quién:** paciente, en el celular.
**Dónde:** `CA/public/personal-link-page.tsx`, `CA/public/appointment-block.tsx`, `packages/services/src/booking-links.ts` (`bookAnotherOf`).
**Medida:** cancelar, 2 toques; recuperar, sin salida (390 px). **A mejorar** (meta: «Reservar otra» en 1 toque, o a quién escribir).

- [ ] Tras cancelar se ofrece «Reservar otra» o dice a quién escribir, con su teléfono.
- [ ] El diálogo de cancelar dice la fecha bien escrita, sin doble punto tras «a. m.».
**Ya falló:** la tarjeta desaparecía entera, con «Reservar otra» dentro.
**Patrones:** el mismo «Reservar otra» de la tarjeta de la cita.

## Cobros

### M-COB-01 Cobrar desde la ficha: parcial y adelanto
**Quién:** caja; decenas de veces al día (supuesto).
**Dónde:** `CA/patient/account-tab.tsx`, `collect-flow.tsx`, `CA/finance/collect-drawer.tsx`.
**Medida:** cobro parcial, 4 clics; adelanto «Para» un tratamiento, 3 clics; un concepto suelto con vuelto, 5 clics (1440 px). **A mantener.**

- [ ] El cajón abre con el importe y el «Para» ya puestos.
- [ ] El ticket dice una sola cifra de lo que falta y lo que queda a favor.
- [ ] Con deuda, el adelanto avisa y ofrece cobrarlo a lo que debe, en un toque.
- [ ] En un menor, quien paga por defecto es su representante.
- [ ] Escape sin haber tocado nada no pregunta «¿Salir sin guardar?».
**Ya falló:** adelanto con deuda en 6 clics y 3 cifras; el resto del adelanto se perdía al cobrar.
**Patrones:** `FormDrawer`; `useDraftBlocker`; `SubmitButton` (`UP/form/submit-button.tsx`) con el importe en el botón.

### M-COB-02 Dar el comprobante después de cobrar
**Quién:** caja; en cada cobro (supuesto).
**Dónde:** `CA/finance/ticket-panel.tsx`, `ticket-view.tsx`, `CA/finance-documents/`.
**Medida vieja:** 2 pantallas, 3 cajones, 6 toques y 1 desplazamiento, saliendo de Finanzas (390 px). **Volver a medir; la meta era 1 toque para imprimir.**

- [ ] «Imprimir» y «Enviar» se ven sin desplazarse, en el pie del mismo cajón.
- [ ] «Enviar» se ofrece solo si hay por dónde, y si no, dice la causa real.
- [ ] No hay que salir de Finanzas para entregar el ticket.
**Ya falló:** botones bajo el pliegue en un cajón que no se desplazaba.
**Patrones:** `actions` de `DetailDrawer` / `DetailSurface` (`UP/detail/`).

### M-COB-03 Anotar, corregir y pagar un gasto
**Quién:** caja; varias veces al día (supuesto).
**Dónde:** `CA/finance/expense-form-drawer.tsx`, `expenses-tab.tsx`, `recurring-due.tsx`.
**Medida (390 px):** en efectivo, 5 toques y 3 tecleos (8 toques con comprobante), 1 cajón, 0 saltos, 3 decisiones, unas 60 palabras. Por Yape, 7 toques y 3 tecleos. Corregir, 4 toques y 1 tecleo, y queda 1 fila. Pagar lo que se repite, 2 toques. Gasto de materiales, 9 toques, 2 tecleos y 1 decisión obligatoria: **a mejorar**. El resto, **a mantener.**

- [ ] El cajón vacío pide solo lo que la tarea necesita; lo opcional aparece al elegirlo (el n.º de operación con Yape).
- [ ] La línea de la caja dice la verdad, también al corregir.
- [ ] Tocar la fila abre el detalle; corregir no crea una segunda fila.
- [ ] El botón lleva el importe.
- [ ] Un error al guardar conserva lo escrito.
- [ ] «Anotar lo que se repite» no vuelve a crecer: se cuentan sus campos y sus palabras.
**Ya falló:** un cajón que borraba el gasto a medio escribir; el reintento que duplicaba; un formulario que volvió a crecer después de recortarlo.
**Patrones:** `FormDrawer`; `RowActions`; `CA/finance/expense-money-fields.tsx`; `MonthPicker.tsx`.

### M-COB-04 La factura por pagar: ver sus pagos y anularla
**Quién:** caja o la dueña; alguna vez al mes (supuesto).
**Dónde:** `CA/finance/payables.tsx` («Ver sus pagos»), `expenses-tab.tsx` («Descargar el mes»).
**Medida (1440 px):** ver los pagos de una factura, 4 o 5 clics y solo los del mes elegido; anular una con un pago, 11 clics en 3 superficies; descargar el mes, 1 clic. **A mejorar** (meta dicha: 1 clic y 7 clics en un solo detalle).

- [ ] La factura se abre y muestra todos sus pagos, de cualquier mes.
- [ ] Si «Anular» no se puede por un pago, lo dice ahí y lleva al pago.
- [ ] Buscar un número de factura contesta siempre: pagada, por pagar o anulada.
- [ ] Lo anulado se puede ver en algún lugar.
- [ ] Una descarga filtrada dice que está filtrada.
**Ya falló:** un motivo escrito en vano antes de saber que no se podía; una búsqueda que solo miraba el mes.
**Patrones:** `DetailDrawer`; `FilterBar`; `UI/dropdown-menu.tsx` para elegir qué se descarga.

## Bandeja

### M-BAN-01 Mandarle su enlace desde la conversación
**Quién:** recepción; varias veces al día (supuesto).
**Dónde:** `CA/inbox/thread-view.tsx` («Enviarle su enlace»), `CA/patient/send-personal-link.tsx`.
**Medida vieja:** 9 toques, 2 pantallas y 1 salida de la Bandeja (390 px). **Volver a medir; la meta era 2 toques en la misma conversación.**

- [ ] Se manda sin salir de la conversación.
- [ ] Un solo nombre para una sola cosa: cada enlace dice lo que abre.
- [ ] Antes de enviar se ve qué va a recibir la persona.
- [ ] Enviado, pendiente y fallido se distinguen en el hilo.
**Ya falló:** tres caminos con tres nombres para el mismo enlace.
**Patrones:** `RowActions` / `CA/header-more-menu.tsx`; `CA/write-to-person.tsx`.

### M-BAN-02 Responder lo que Sofi pasó
**Quién:** recepción y el profesional; varias veces al día (supuesto).
**Dónde:** `R/tasks.tsx`, `R/inbox.tsx`, `CA/inbox/thread-view.tsx` («Ver el caso»), `CA/home/waiting-list.tsx`.
**Medida:** llegando por Tareas, 5 toques y 3 pantallas para responder; una duda clínica, 5 toques y 3 cajones que tapan la pregunta; «Ver el caso», 2 toques (1440 px). **A mejorar.**

- [ ] Desde la tarea se ve la pregunta de la persona y se responde ahí.
- [ ] Cerrar un tema sin responder no es el botón principal.
- [ ] La duda clínica se responde con las alergias y la última atención a la vista.
- [ ] La conversación dice si se va a cerrar sola y cuándo.
**Ya falló:** «Hecha» cerraba el tema sin responderle a la persona.
**Patrones:** `MasterDetail` (`UP/master-detail.tsx`); `DockedSurface` (`UP/docked-surface.tsx`) en vez de cajones apilados.

## Mostrador de óptica

### M-OPT-01 Vender en el mostrador y cobrar el adelanto
**Quién:** ventas; con cola, decenas de veces en un día lleno (supuesto).
**Dónde:** `CA/finance/counter-sale-drawer.tsx`, `CA/orders/sale-drawer.tsx`, `R/orders.tsx`.
**Medida:** sin medir. Al medir, sumar el tiempo por cliente y dónde se forma la cola.

- [ ] Una venta sin ficha (lentes de sol) no pide registrar a la persona.
- [ ] La venta de la montura, la orden y el adelanto se hacen en un solo recorrido.
- [ ] Se puede dejar una venta a medias, atender a otro y volver.
- [ ] El ticket dice lo que falta pagar y cuándo se entrega.
**Patrones:** `FormDrawer`; `useDraftBlocker`; el cobro de `collect-drawer.tsx`.

### M-OPT-02 Medir la vista al paso y pasar la medida a la orden
**Quién:** optómetra y ventas; varias veces al día (supuesto).
**Dónde:** `apps/optical-clinic/src/product/optical/examination.tsx`, `prescription-block.tsx`, `orders-section.tsx`, `lens-fields.tsx`.
**Medida:** sin medir.

- [ ] La medida se escribe con teclado, en el orden del papel (OD, OI; esfera, cilindro, eje).
- [ ] La orden toma la medida sin volver a escribirla.
- [ ] Quien vende sabe a quién le toca sin salir de la venta.
- [ ] Un valor fuera de rango avisa sin frenar.
**Patrones:** `Field` y `FieldGroup` (`UI/field.tsx`); `UI/input-group.tsx`.

## Administración (equipo interno)

Las cuentas de odentIA en la administración, con el rol Administración o Soporte. «Antes» se contó en las capturas del 11 nov; lo de este cambio se contó en su código, sin recorrer la pantalla nueva: hay que medirlo antes de compararlo.

### M-ADM-01 Abrir desde Inicio lo primero del día
**Quién:** administración y soporte; al empezar el día y varias veces más (supuesto).
**Dónde:** `A/routes/_app/index.tsx`, `A/lib/support-words.ts`, `A/lib/invitation-words.ts`, `A/components/skeletons/home.tsx`.
**Medida:** antes (1440 px), un número por cola: 2 clics y 1 salto para abrir un prospecto o un caso, después de buscarlo a ojo en la lista. Con este cambio, en el código: 1 clic en su fila, 1 salto a la pantalla con el elemento ya abierto, 0 búsquedas y 0 decisiones sobre el orden. **Volver a medir.**

- [ ] Cada fila dice quién, qué espera y hasta cuándo sin abrirla, y el botón nombra lo que abre.
- [ ] Al volver, la lista de detrás conserva sus filtros y la fila resuelta ya no está en Inicio.
- [ ] El filtro de producto es una sola parada de teclado y se recorre con flechas.
- [ ] Mientras carga, el esqueleto tiene forma de filas; si una parte falla, las demás siguen.
- [ ] A 390 px cada fila se lee entera, con su botón.
**Ya falló:** contadores que no decían a quién; el elemento se buscaba otra vez en la lista.
**Patrones:** `EmptyState`, `ErrorState` y `SkeletonRegion` (`UP/`); `ProductFilter` (`A/components/product.tsx`).

### M-ADM-02 Anotar un contacto con la fecha para volver
**Quién:** administración y soporte; varias veces al día mientras haya prospectos (supuesto).
**Dónde:** `A/routes/_app/waitlist.tsx` (el cajón, «Seguimiento»).
**Medida:** antes (1440 px), 2 clics y 1 tecleo («Guardar nota»), sin fecha posible. Con este cambio, en el código: 1 clic para abrir la solicitud, 1 tecleo («¿Qué pasó?»), 1 toque para la fecha (0 si sigue la que había) y 1 clic en «Anotar…»: 2 o 3 clics, 1 cajón, 0 saltos. **Volver a medir.**

- [ ] La fecha se elige en un grupo de botones que es una sola parada de teclado, y anuncia cuál está elegida.
- [ ] Cerrar el recordatorio se elige a propósito; nunca viene elegido al abrir.
- [ ] El botón dice qué va a pasar con la fecha antes de pulsarlo.
- [ ] Lo escrito sin anotar avisa antes de cerrar el cajón o de ir a otra pantalla.
**Ya falló:** una sola nota que se reemplazaba, sin autor ni fecha para volver.
**Patrones:** `DetailDrawer` (`UP/`); `ToggleGroup` (`UI/toggle-group.tsx`); `DatePickerButton` (`UP/`).

### M-ADM-03 Pedir el acceso de diagnóstico, y que la clínica lo autorice
**Quién:** soporte; algunas veces por semana (supuesto). Del otro lado, la propietaria o un administrador de la clínica.
**Dónde:** `A/routes/_app/support.tsx` («Pedir acceso de diagnóstico…»); en la clínica, `CA/support-cases.tsx` («Autorizar acceso»).
**Medida:** antes, no había botón: el pedido se escribía a mano en la respuesta y solo lo veía quien abrió el caso. Con este cambio, en el código: soporte, 3 clics y 0 tecleos desde la cola (abrir el caso, el botón y «Pedir acceso» en el diálogo); la clínica, 2 clics desde el caso abierto en Ayuda (la «Duración» viene en 30 minutos y «Autorizar acceso»). **Volver a medir.**

- [ ] El diálogo muestra el texto exacto y a quién le llega antes de enviarlo.
- [ ] Si quien abrió no puede autorizar, la pantalla de la clínica le dice quién puede, sin un paso más.
- [ ] Autorizar no pide escribir nada: el caso vuelve a soporte solo.
**Ya falló:** quien abrió el caso no podía autorizar y nadie más de la clínica lo veía.
**Patrones:** `ConfirmDialog` (`UP/confirm-dialog.tsx`) con el mensaje dentro.

### M-ADM-04 Rechazar un comprobante
**Quién:** administración; algunas veces por semana (supuesto).
**Dónde:** `A/routes/_app/billing.tsx` («Comprobantes por confirmar»), `A/components/reason-dialog.tsx`.
**Medida:** antes (1440 px), no se podía: «Reversar» fallaba sobre un pendiente. Con este cambio, en el código: 2 clics y 1 tecleo («Rechazar», el motivo y «Rechazar»), 1 diálogo y 0 saltos; «Ver» el archivo antes es 1 clic más. **Volver a medir.**

- [ ] El diálogo dice el archivo, el importe y la clínica en el título, y que no sale correo.
- [ ] El campo del motivo no deja pasarse del largo que acepta el servidor.
- [ ] La fila sale de la lista al momento, sin recargar.
**Ya falló:** un botón que siempre daba error.
**Patrones:** `ReasonDialog` (`A/components/reason-dialog.tsx`).
