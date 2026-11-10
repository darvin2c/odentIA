# La verdad: cifras y datos que deben coincidir

Catálogo del auditor. Cada entrada es una cifra, un estado o un dato, con todos los lugares donde se ve y la cuenta para rehacerlo a mano. Es el piso, no el techo: se revisan las entradas que el área toca, comprobación por comprobación, y además el auditor arma sus casos y hace sus giras (`mesa.md`).
Crece con lo que cada recorrido devuelve en «Para mi catálogo» y con lo que se escapó. También se poda: lo que ya no existe se quita y lo repetido se une.
Antes de dar un fallo por cierto, mira «A mano»: varias diferencias son a propósito y están dichas ahí. Los casos son ficticios; si la demo no los trae, se crean.
Rutas: `S` = `packages/services/src/`, `CA` = `packages/clinic-app/src/components/`, `R` = `packages/clinic-app/src/routes/`. Códigos: `DIN` dinero, `EST` estados, `DAT` el mismo dato, `PRO` promesas, `RAS` rastro.

---

## V-DIN-01 La cuenta de la persona: debe, a favor y falta pagar
**Aparece en:** ficha › Cobros (`CA/patient/account-tab.tsx`), ficha › Resumen (`CA/person/person-summary.tsx`), cabecera de la ficha (`CA/patient/patient-header.tsx`), el ticket, Finanzas › Deudas (`CA/finance/debts-tab.tsx`), Pacientes › «Deben» y lo que Sofi sabe de su cuenta (`S/conversation-context.ts`).
**A mano:** a favor = adelantos − lo aplicado − lo devuelto. Falta pagar = debe − a favor, y nunca baja de 0. Un adelanto «Para» un tratamiento no baja la deuda general.
- [ ] Las tres cifras son iguales en Cobros, Resumen, cabecera y ticket, con la misma palabra.
- [ ] Una devolución se ve en la cuenta de la persona, no solo en la caja.
- [ ] Cada pago dice a qué se aplicó. «No se le ha cobrado nada» no aparece encima de pagos.
- [ ] Quien debe 0 después de restar lo que tiene a favor no figura como deudor en ninguna lista.

**Ya falló:** un adelanto a quien ya debía dejó tres cifras distintas de «debe» en la misma ficha.
**Caso:** el lunes 2 de marzo debe S/ 300. El martes 3 deja S/ 100 de adelanto: debe 300, a favor 100, falta pagar 200. El jueves 5 se le devuelven S/ 40: a favor 60, falta pagar 240, y la devolución se lee en su ficha.

## V-DIN-02 El ticket
**Aparece en:** el ticket en pantalla (`CA/finance/ticket-view.tsx`), su PDF (`S/financial-document-pdf.ts`), «Cobro registrado» (`CA/finance/collect-drawer.tsx`), Finanzas › Cobros (`CA/finance/tickets-tab.tsx`) y ficha › Cobros.
**A mano:** suma de líneas − saldo a favor usado − pagado hoy = le falta pagar. El total del ticket es lo que entró hoy. Vuelto = lo entregado − lo cobrado; el vuelto no entra a la caja.
- [ ] Las líneas, el total, lo usado del saldo a favor y lo que falta cuadran a la vista, sin calculadora.
- [ ] Pantalla y PDF dicen lo mismo, con moneda en cada cifra.
- [ ] Un cobro mayor que lo marcado dice qué pasa con el resto antes de cobrar.
- [ ] La lista de tickets no suma como dinero lo que solo usó saldo a favor.

**Ya falló:** líneas por 470 y «TOTAL 370», con el saldo usado dicho más abajo.
**Caso:** el 4 de marzo: resina S/ 250 y profilaxis S/ 220 (470). Usa S/ 100 a favor y paga S/ 150 con un billete de 200. Ticket: usado −100, pagado hoy 150, vuelto 50, le falta pagar 220. La caja sube 150.

## V-DIN-03 Adelanto y devolución, sin duplicar
**Aparece en:** el cajón de cobro («Cobrar un adelanto», «Mejor, a lo que debe»), ficha › Cobros («Tratamiento aceptado»: aceptado, pagó, falta), el ticket del adelanto y Finanzas › Caja › «Movimientos de hoy» (`R/_org/finance.tsx`).
**A mano:** por tratamiento, falta = aceptado − pagó. Nunca se devuelve más de lo que hay a favor.
- [ ] Con deuda abierta, un adelanto sin «Para» lo avisa y ofrece cobrarlo a lo que debe.
- [ ] El importe escrito no se pierde al cambiar entre cobrar lo pendiente y cobrar un adelanto.
- [ ] Repetir el mismo envío (doble clic, dos pestañas, reintento tras un corte) no cobra ni devuelve dos veces.
- [ ] Lo que el cajón promete para «un cobro aparte» se recuerda después del primer cobro.

**Ya falló:** la misma devolución enviada desde dos pestañas salió dos veces de la caja.
**Caso:** el 6 de marzo debe S/ 130 y entrega S/ 200. Se cobran 130 a lo que debe y 70 quedan como adelanto en otro cobro: dos tickets, debe 0, a favor 70. El 9 se devuelven S/ 70 con doble clic: un solo movimiento de −70.

## V-DIN-04 El total del presupuesto, sus opciones y la otra moneda
**Aparece en:** ficha › Plan (`CA/patient/plan/plan-budgets.tsx`), la franja del presupuesto en la atención (`CA/patient/encounter-plan-panel.tsx`), el diálogo de firma, «Qué sigue», la Oportunidad, el PDF (`S/budget-pdf.ts`), el portal (`R/public/portal.tsx`) e Historia.
**A mano:** las opciones nunca se suman: cada una tiene su total. Lo que está en dólares se queda en dólares («S/ X + USD Y»); el total en una moneda es aproximado y lo dice. Lo ya hecho sale del presupuesto y pasa a la cuenta.
- [ ] Con opciones, cada lugar muestra el total de cada una o dice que falta elegir. Ninguno da solo el de la primera.
- [ ] Una revisión conserva todas las opciones y dice qué precio cambió, de cuánto a cuánto.
- [ ] Lo no elegido no vuelve a contarse como pendiente ni entra a un presupuesto nuevo.
- [ ] «Lo está pensando» da el importe de lo que falta decidir, no el del presupuesto entero.

**Ya falló:** el total al firmar sumó alternativas que compiten para la misma pieza.
**Caso:** pieza 46. Opción A: endodoncia S/ 450 + corona S/ 900 = 1,350. Opción B: exodoncia S/ 150. Aparte, un implante de USD 1,000. Se lee «A S/ 1,350 · B S/ 150» y «+ USD 1,000»; nunca S/ 1,500. El 12 de marzo elige A: B queda «No elegida» en todos los lugares.

## V-DIN-05 Lo que carga la atención
**Aparece en:** el diálogo «Finalizar y firmar» y «Atención finalizada» (`CA/patient/encounter-editor.tsx`, `encounter-closing.tsx`), ficha › Cobros, lo que caja ve por cobrar y el ticket.
**A mano:** el cargo nace al firmar, no antes. Un tratamiento de varias sesiones se carga una sola vez. Aceptar no genera deuda.
- [ ] El cierre da una sola cifra de lo que debe en total, y baja al cobrar.
- [ ] En la sesión 2 dice que hoy no se carga nada, sin afirmar que ya está pagado.
- [ ] Lo registrado dos veces (a mano y por dictado, o del catálogo con la indicación ya puesta) no deja dos cargos.
- [ ] Con la atención abierta, alguien puede saber cuánto se cargará al cerrar.

**Ya falló:** el cierre decía «no dejó nada que cobrar» con S/ 250 de esa atención sin pagar.
**Caso:** endodoncia de S/ 650 en 2 sesiones. Lunes 9 de marzo, sesión 1: se cargan 650 y paga 300; debe en total 350. Lunes 16, sesión 2: hoy no se carga nada y debe en total 350.

## V-DIN-06 Lo cobrado del día, la caja y las deudas
**Aparece en:** Inicio › «Caja de hoy» (`CA/home/today.tsx`), Finanzas › Caja, Cobros y Deudas (`R/_org/finance.tsx`), Reportes › Resumen y Finanzas (`CA/reports/summary-tab.tsx`, `finance-tab.tsx`) y Argos (`S/agent-admin.ts`).
**A mano:** la caja es por sede y cuenta desde el último cierre; Inicio cuenta el día. Caja muestra lo cobrado y, aparte, lo devuelto; Reportes muestra el neto. Efectivo en caja = lo ingresado + cobros en efectivo − devoluciones y gastos en efectivo.
- [ ] Cada cifra dice de qué sede y de qué periodo es. Si dos pantallas difieren, la diferencia es justo lo devuelto o lo anterior al cierre.
- [ ] «Devuelto» nombra lo mismo en Caja y en Cobros.
- [ ] La cantidad de deudores y su total coinciden en Deudas, Reportes y Argos.
- [ ] «Más de 30 días» da lo mismo en todas, también el día 30 justo y de noche.

**Ya falló:** una deuda de 30 días exactos entraba en una lista y en otra no.
**Caso:** 10 de marzo, una sede: Yape S/ 200, efectivo S/ 100, tarjeta S/ 65 y una devolución de S/ 50 por Yape. Caja: cobrado 365, devuelto 50. Reportes: 315. Una deuda de S/ 450 nacida el 1 de marzo no es «de más de 30 días» el 31 de marzo y sí el 1 de abril, en todas las pantallas.

## V-DIN-07 La comisión del profesional
**Aparece en:** Finanzas › Comisiones y la vista del profesional («Me corresponde») (`CA/finance/CommissionsPanel.tsx`), la liquidación impresa, Reportes › Finanzas y «Por profesional», la descarga (`S/report-csv.ts`), Gastos (el pago) y Argos.
**A mano:** comisión = lo cobrado de lo que atendió (con IGV, sin restar laboratorio) × su porcentaje. Va a quien llevó la atención, no al de la cita. Lo ya pagado conserva el porcentaje con que se pagó. Falta pagar = le corresponde − pagado − por descontar.
- [ ] La suma de líneas es «Le corresponde», y la suma de profesionales es el total del mes.
- [ ] El porcentaje que se muestra es el que se usó en cada importe, y dice sobre qué base.
- [ ] «Ya pagado» y «por pagar» valen lo mismo en Comisiones, Reportes y Argos.
- [ ] Un mes con una parte pagada dice cuánto falta, no cuánto correspondía.

**Ya falló:** el mismo monto salía como dos porcentajes de «lo cobrado» en la misma página, con dos bases.
**Caso:** en marzo cobra S/ 900 de una corona al 35 %: le corresponden S/ 315. El 5 de abril se le pagan S/ 200: falta 115. El 10 de abril su porcentaje sube a 40 %: marzo sigue en 315.

## V-DIN-08 Gastos, lo que se repite y lo que está por pagar
**Aparece en:** Finanzas › Gastos (`CA/finance/expenses-tab.tsx`, `recurring-due.tsx`, `payables.tsx`), Reportes › Finanzas («Otros gastos», «Lo que debes»), «Descargar el mes» (`S/expense-csv.ts`), Caja e Inventario › pagar una compra (`CA/inventory/purchase-payment-drawer.tsx`).
**A mano:** «Gastado» = suma de las filas vigentes del mes, por el día del pago. Lo que se repite va por el mes al que corresponde. Reportes pone aparte el pago del IGV y el de comisiones. Solo el efectivo toca la caja.
- [ ] Gastado, la suma de filas y la descarga dan la misma cifra. Frente a Reportes, la diferencia son solo las partidas que van aparte.
- [ ] Nada figura como pagado sin que alguien lo pague: anotado, por pagar y pagado se distinguen.
- [ ] Un gasto suelto que es el mismo que uno «por pagar» no queda contado dos veces ni deja el otro pendiente.
- [ ] Dejar de repetir un gasto no borra lo vencido sin pagar.
- [ ] Un gasto anulado baja en el mismo mes en Gastos y en Reportes.

**Ya falló:** «Pagar» registró al instante el importe propuesto, que no era el de la factura.
**Caso:** marzo: alquiler S/ 1,200 (se repite), luz propuesta S/ 670 y pagada el 12 por S/ 280, y un gasto de S/ 100 del 2 de marzo que se anula el 7 de abril. Gastado en marzo: 1,580, con la luz en 280 y no en 670. Tras anular: 1,480 en Gastos y en Reportes, y los 100 no suman en ningún mes.

## V-EST-01 «Sesión N de M»
**Aparece en:** la atención («Hoy viene a…», «Hecho hoy») (`CA/patient/encounter-visit.tsx`, `encounter-treatments.tsx`), el cierre, ficha › Plan, «Qué sigue», «Reservar lo aceptado» (`CA/agenda/booking-drawer.tsx`), la cita en la Agenda y el portal.
**A mano:** N = sesiones firmadas + la de hoy. M = las previstas en el plan. N nunca pasa de M sin que alguien diga «Falta otra sesión». Una cita pasada no cuenta como sesión hecha.
- [ ] La sesión de hoy lleva el mismo número en la atención, el Plan y el cierre.
- [ ] La sesión que se ofrece reservar es la que sigue a lo firmado.
- [ ] Un tratamiento de varias sesiones no se cierra solo en la primera, ni queda abierto con todas hechas sin preguntarlo.
- [ ] Lo que va después (la corona tras la endodoncia) no se ofrece antes en ninguna pantalla.

**Ya falló:** haciendo la sesión 2, la atención decía «sesión 1 de 2».
**Caso:** endodoncia de la 36 en 2 sesiones. El 9 de marzo se firma la 1: todo dice «1 de 2» y ofrece reservar la 2. El 16 se abre la atención: «sesión 2 de 2». Tras firmar con «Sí, terminar»: realizado, y nada ofrece una sesión 3.

## V-EST-02 El tratamiento: lo que decidió y lo que se hizo
**Aparece en:** ficha › Plan y su cabecera de conteos (`CA/patient/plan-tab.tsx`, `plan-fases.tsx`), el Recorrido (`CA/patient/recorrido-tab.tsx`), «Plan y controles» de la atención, el odontograma, Historia y Pacientes › «Por agendar».
**A mano:** son dos ejes: la decisión (por decidir, aceptado, no aceptó, no elegida) y la ejecución (pendiente, en curso, realizado). Hacerlo es aceptarlo. Los conteos de la cabecera deben sumar las filas que se ven.
- [ ] Ninguna fila junta dos estados que chocan (un «No elegida» que sigue «Pendiente» y pide consentimiento).
- [ ] «N tratamientos · realizados · en curso · por decidir» coincide con las filas, sin contar lo cancelado.
- [ ] Lo realizado tiene al menos una sesión firmada y vigente; si esa sesión se anula, deja de estar realizado.
- [ ] Lo hecho hoy no queda además como indicado por decidir.

**Ya falló:** un tratamiento quedó «Realizado» con su única sesión anulada.
**Caso:** el 3 de marzo se indican resina en la 26 (acepta), profilaxis (lo piensa) y blanqueamiento (no acepta). Cabecera: 3 tratamientos, 0 realizados, 1 por decidir. El 10 se hace la resina: 1 realizado. La profilaxis sigue por decidir en Plan, Recorrido y «Qué sigue».

## V-EST-03 El presupuesto: por enviar, entregado, respondido
**Aparece en:** ficha › Plan (`CA/patient/plan/budget-show.tsx`, `budget-response.tsx`), la franja de la atención, «Qué sigue», Historia, la Oportunidad, el portal, Pacientes › «Presupuesto sin respuesta» y Reportes.
**A mano:** enviado es que salió un mensaje; entregado en mano es otra cosa. Mientras una revisión espera respuesta, vale lo último aceptado. Aceptar una parte deja abierto lo que falta.
- [ ] El estado dice cómo llegó (impreso o enviado) y no llama «enviado» a lo que se imprimió.
- [ ] La respuesta se nombra igual en la atención, el Plan y la Historia («Eligió la opción A», no «Aceptó todo»).
- [ ] Una revisión no deja «por responder» lo ya hecho y cobrado.
- [ ] La fecha del presupuesto es la misma en todos los lugares, con año.

**Ya falló:** imprimirlo lo dejó «Enviado · espera respuesta» a quien no tiene WhatsApp ni correo.
**Caso:** el 4 de marzo se imprime y entrega el presupuesto de S/ 340 (resina 220 + profilaxis 120). El 6 acepta la resina y deja la profilaxis: «Lo está pensando · S/ 120» en Plan, «Qué sigue» y Pacientes; la Oportunidad sigue abierta por 120.

## V-EST-04 La cita: por confirmar, sin cerrar, atendida, no vino
**Aparece en:** cabecera, rejilla y lista de la Agenda (`R/_org/agenda.tsx`, «Ya pasaron · sin cerrar») y su cajón (`CA/agenda/appointment-drawer.tsx`), ficha › Citas (`CA/patient/citas-panel.tsx`), cabecera («Próxima cita»), Inicio («Mis pacientes de hoy», «Agenda de hoy», «¿Vino?») (`S/workspace.ts`), Reportes › Agenda y «Sin marcar» (`S/reports.ts`, `S/report-agenda.ts`), el portal y lo que confirma Sofi.
**A mano:** nadie marca sola la inasistencia: una cita pasada sin atención pregunta «¿Vino?». Sin cerrar = su hora pasó, sin llegada ni atención unida, y no está atendida, ni «No vino», ni cancelada; quien llegó o está en atención no es «sin cerrar». «Por confirmar» es solo lo que aún no empieza. «Próxima cita» es la primera que aún no termina. Lo cancelado y lo no asistido no cuentan en el total del día.
- [ ] La misma cita tiene el mismo estado, con el mismo nombre, en Agenda, ficha, Inicio, Reportes y portal. Pendiente no se muestra como confirmada.
- [ ] «Por venir» y «N por confirmar» de la cabecera no cuentan citas que ya pasaron.
- [ ] Reportes › «Sin marcar» no trae a quien llegó o está en atención, y la base de «No vinieron» tampoco. Inicio, Agenda y Reportes cuentan las mismas citas sin cerrar del día.
- [ ] «N citas» cuenta lo mismo en la vista Día y en la lista, y sigue el filtro de profesional.
- [ ] La ficha › Citas pone una cita futura cancelada en su fecha, no en «Citas anteriores», y dice la sede en una clínica con varias.
- [ ] Si la sesión se hizo antes de su cita, esa cita no queda en pie sin objeto: el cierre lo dice.
- [ ] La cita dice lo que lleva (tratamiento y sesión) y dura lo que el aviso calculó.

**Ya falló:** una cita de ayer sin atención era «sin cerrar» en Inicio, «Por confirmar» en la ficha y no existía en Reportes; quien llegó y quien estaba en atención salían en «Sin marcar» de Reportes, y una cita pasada era «1 por confirmar» en la cabecera.
**Caso:** cita el jueves 12 de marzo a las 10:00 para la sesión 2. El paciente viene el martes 10 y se hace ese día. Al firmar, el cierre nombra la cita del 12 y ofrece liberarla; la cabecera ya no la muestra como próxima. Otro: el lunes 9 a las 10:00 una cita queda sin cerrar; el martes 10 otra paciente con cita a las 11:00 llega a las 12:50. A las 13:00 la primera dice «sin cerrar» en todo, y la segunda «en sala» en todo y fuera de «Sin marcar».

## V-EST-05 El control: pendiente, con cita, vencido, realizado
**Aparece en:** ficha › Plan › Controles (`CA/patient/clinical-panels.tsx`), ficha › Resumen («Próximo control») (`CA/patient/next-up.tsx`), la atención y su cierre, Historia, Pacientes › «Control vencido», Inicio, Argos y el recordatorio que sale por mensaje.
**A mano:** vencido = pendiente, su día pasó y no hay cita por venir. Cualquier visita dentro de su ventana lo cumple si se marca. Cancelar un control no cancela su cita.
- [ ] El mismo control tiene el mismo estado y la misma cita en Resumen, Plan, Historia y la lista de Pacientes.
- [ ] Atender a la persona sin cita cumple el control o lo deja pendiente, igual en todos los lugares.
- [ ] Ningún texto afirma «sus controles quedaron hechos» sin leerlos.
- [ ] Dos controles iguales el mismo día dicen de qué pieza es cada uno; reservar uno no deja el otro «por reservar» sin decirlo.

**Ya falló:** «Sin cita reservada» en el Plan para un control que el Resumen mostraba con cita.
**Caso:** control de mantenimiento para el 20 de marzo. El 18 se le reserva una resina para el 20. El 21, tras atenderla y marcarlo: «Realizado» con esa cita en Plan, Resumen e Historia, y fuera de «Control vencido».

## V-EST-06 Enviado, entregado, firmado y confirmado
**Aparece en:** el envío de documentos (`CA/patient/health-document-send.tsx`), la Bandeja, ficha › Documentos, la firma por enlace y su aviso en la atención (`CA/patient/link-signed-notice.tsx`), el PDF del consentimiento (`S/consent-pdf.ts`), el portal y Reportes › Agente.
**A mano:** en cola no es enviado, enviado no es entregado y abierto no es leído. Firmado por enlace queda pendiente hasta que el profesional lo confirma. Un tema no está resuelto si la respuesta no salió.
- [ ] Un mensaje que falló se ve como fallido en la Bandeja y en Inicio, y no cuenta como respuesta en Reportes.
- [ ] El consentimiento firmado por enlace aparece en la atención a la que corresponde, como pendiente de confirmar.
- [ ] Enlace, tablet y PDF muestran la misma hoja, con la pieza y la declaración.
- [ ] En una demo, lo simulado no se presenta como entregado de verdad.

**Ya falló:** la tarea se cerraba al poner el mensaje en cola, aunque después no saliera.
**Caso:** el 16 de marzo a las 18:00 se envía el consentimiento de la exodoncia de la 48. El paciente lo firma a las 21:30. El 17 a las 09:00 la atención lo muestra firmado por enlace y pendiente de confirmar; tras confirmarlo, el PDF dice quién y cuándo.

## V-DAT-01 «Qué sigue» de la persona
**Aparece en:** ficha › Resumen y Plan (`CA/patient/plan/plan-next.tsx`, `S/plan-next.ts`), la fila de Pacientes (`R/_org/people.index.tsx`), «Lo que sigue» de la atención firmada (`CA/patient/encounter-handoff.tsx`), Inicio y lo que Sofi le dice a la persona.
**A mano:** es una sola lista que arma el servidor, con el mismo orden en todas partes. Solo se agenda lo aceptado.
- [ ] Los cuatro lugares dicen lo mismo, en el mismo orden, para la misma persona.
- [ ] «Nada pendiente en el plan» no aparece con un tratamiento a medias, por decidir o suspendido.
- [ ] La atención firmada lista lo mismo que la ficha manda reservar.
- [ ] Lo que dice Sofi de la sesión que sigue o del control coincide con la ficha.

**Ya falló:** el Resumen ponía primero el control vencido y el Plan, lo aceptado.
**Caso:** al 11 de marzo: endodoncia con la sesión 1 firmada el 9, corona aceptada que va después y control vencido el 1 de marzo. En los cuatro lugares: primero la sesión 2, luego el control; la corona, después de terminar la endodoncia.

## V-DAT-02 Las cuentas de seguimiento
**Aparece en:** los atajos de Pacientes («Por agendar», «Presupuesto sin respuesta», «Control vencido», «Por invitar a volver», «Deben») (`S/people-shortcuts.ts`), Inicio («Te espera», «Sin apuro») (`CA/home/waiting-list.tsx`), el número del menú, Reportes y sus listas (`CA/reports/report-list-drawer.tsx`), Argos y la Ayuda (`S/help-guide.ts`).
**A mano:** hay que saber qué cuenta cada una: personas, tratamientos, conversaciones o filas. Argos espera unos días antes de contar. Las listas en pantalla tienen tope y el resto va en la descarga.
- [ ] Dos pantallas con el mismo nombre dan el mismo número, o dicen en qué se diferencian.
- [ ] La cifra de una tarjeta es la cantidad de filas de la lista que abre, y su suma.
- [ ] «Falta su cita» no nombra a quien ya tiene cita para eso.
- [ ] La Ayuda no afirma «son las mismas cuentas» si no lo son.
- [ ] Reportes no se contradice entre pestañas: el mismo porcentaje usa la misma base.

**Ya falló:** «N personas esperan» en el menú y otro número en Inicio, porque uno contaba tres grupos y el otro uno.
**Caso:** una clínica con 40 personas que aceptaron y no tienen cita. Inicio, Pacientes › «Por agendar» y Reportes dicen 40; la lista trae 40 filas. Reservar una cita para una de ellas baja las tres a 39.

## V-DAT-03 La cita, el profesional y las fechas
**Aparece en:** Agenda, cabecera y Citas de la ficha, Inicio, la atención, Historia, los recordatorios, el portal, las listas de Reportes y las respuestas de Argos.
**A mano:** la agenda conserva al profesional de la cita; la atención dice quién atendió. Toda fecha que puede ser de otro año lleva el año. El día se corta en la zona horaria de la clínica.
- [ ] Sede, hora, profesional y motivo de la cita son iguales en todos los lugares.
- [ ] La sesión siguiente y el control se proponen con quien atendió; si no puede ser, se dice.
- [ ] Ninguna lista muestra «3 de noviembre» para algo de hace un año.
- [ ] A las 23:00 las cifras de «hoy» son las del día de la clínica.

**Ya falló:** «Última visita» con día y mes de una visita del año anterior.
**Caso:** paciente con última visita el 21 de noviembre de 2025 y cita el 20 de marzo de 2026 a las 16:00 con la Dra. A. El 20 la atiende el Dr. B. Pacientes muestra la visita con año; la Agenda conserva a la Dra. A y la Historia dice que atendió el Dr. B.

## V-DAT-04 Pieza, hallazgo y diagnóstico
**Aparece en:** la atención y su vista firmada (`CA/patient/encounter-detail-view.tsx`), Historia (`CA/patient/encounter-history-card.tsx`, `timeline.tsx`), el odontograma firmado, ficha › Resumen («Última atención»), el consentimiento, la hoja de atención (`S/attention-sheet.ts`) y la historia impresa o exportada (`S/patient-record.ts`).
**A mano:** lo firmado es una foto y no cambia. «Tratada» es la pieza donde se hizo algo, no toda pieza con hallazgo. Un hallazgo de dos caras es una sola lesión.
- [ ] Lo escrito en la consulta está igual en la vista firmada, la Historia y el impreso.
- [ ] Las piezas tratadas son las de «Lo que se hizo».
- [ ] El diagnóstico de un procedimiento es el suyo: no arrastra uno ya resuelto ni el de otra pieza.
- [ ] La Historia dice lo mismo plegada que abierta, sin estados sin traducir.

**Ya falló:** «Piezas tratadas: 36, 46» con solo la 36 hecha.
**Caso:** el 9 de marzo: caries oclusal y distal en la 46, pulpitis, y resina en la 36. Firmado: tratada la 36; la 46, un solo hallazgo vigente. El 23 se cementa la corona de la 46: su diagnóstico no es la pulpitis ya resuelta.

## V-PRO-01 Enlaces y botones que llevan a lo que dicen
**Aparece en:** «Ver cobros» de Inicio, «Ver el reporte» de Gastos y «Ver los gastos» de Reportes (`R/_org/finance.tsx`, `CA/reports/finance-tab.tsx`), «Lo que debes», los enlaces de la Ayuda, «Imprimir», «Cancelar» de los cajones y «Dejar de repetir».
**A mano:** se pulsa cada uno y se compara el destino con el origen: mismo mes, misma sede, mismo filtro y la misma cifra.
- [ ] El destino conserva mes, sede y tipo, y su total es el de la cifra que se pulsó.
- [ ] «Cancelar» descarta; si la pantalla autoguarda, el botón no se llama así.
- [ ] «Guardado» aparece solo cuando algo cambió.
- [ ] Anular dice todo lo que se anula con ello, y lo que no (la cita de un control).

**Ya falló:** la barra de un mes abría los gastos de otro mes, sin filtro.
**Caso:** en Reportes de febrero, sede Centro, la barra «Personal S/ 5,700». «Ver los gastos» abre Gastos de febrero, Centro, tipo Personal, y sus filas suman 5,700.

## V-PRO-02 Avisos que dicen la verdad
**Aparece en:** el aviso al reservar («El agente le avisa…») (`CA/agenda/booking-drawer.tsx`), los textos del cierre («recepción lo verá») (`CA/patient/encounter-closing.tsx`), «Sin conexión» de la atención, el envío de documentos, la página de reserva (`R/public/reserva.tsx`), «Tus mensajes» del enlace (`CA/public/personal-link-page.tsx`) y los avisos de la caja.
**A mano:** por cada aviso se busca el hecho: el mensaje en la conversación, la tarea de recepción, el texto guardado tras recargar, el cargo creado.
- [ ] Promete un canal solo si la persona lo tiene y aceptó mensajes.
- [ ] El cierre no dice «recepción no lo verá» con la cita ya reservada, ni «queda por cobrar» sin nada por cobrar.
- [ ] «Se guarda al volver la conexión» se cumple también si la persona sale o recarga.
- [ ] Dos avisos del mismo cajón no dicen cosas opuestas ni dejan cifras de antes al cambiar de moneda.
- [ ] El enlace del paciente no dice «Recordatorios de tus citas: sí» si la clínica no los envía.

**Ya falló:** «El agente le avisa por su conversación» a quien pidió no recibir mensajes.
**Caso:** el 13 de marzo se reserva una cita a un paciente que pidió ningún mensaje. El aviso dice que no se le escribirá y la conversación no tiene mensaje nuevo. Con otro paciente que sí acepta, el mensaje está en el hilo.

## V-RAS-01 Rastro del dinero
**Aparece en:** Caja › «Movimientos de hoy», ficha › Cobros, el detalle de un gasto, Comisiones y la actividad del equipo (`R/_org/settings.audit.tsx`, `S/audit-words.ts`).
**A mano:** por cada movimiento se busca quién, cuándo, a quién y por cuánto. Corregir es anular y crear de nuevo, enlazados. Nada se borra.
- [ ] Una devolución dice a quién se devolvió, en la caja y en su ficha.
- [ ] Un gasto corregido o anulado se sigue viendo, con el antes, el después y quién lo hizo.
- [ ] Cambiar un porcentaje de comisión guarda de quién y de cuánto a cuánto.
- [ ] La actividad nombra sobre qué fue el cambio, no «Hizo un cambio».

**Ya falló:** la caja mostraba «Devolución a favor · −50» sin la persona.
**Caso:** el 10 de marzo a las 11:00 se registra un gasto de S/ 30 en efectivo y a las 11:20 se corrige a S/ 45. Movimientos muestra −30, +30 y −45, con quién y a qué hora; la caja baja 45 en total.

## V-RAS-02 Rastro de firmas, datos clínicos y anulaciones
**Aparece en:** la atención firmada («Correcciones después del cierre») (`CA/patient/encounter-detail-view.tsx`), Historia, Antecedentes, ficha › Plan (controles y respuesta del presupuesto), ficha › Documentos y la comprobación del papel (`R/public/comprobar.$token.tsx`).
**A mano:** lo firmado no cambia: se corrige con una adenda que dice quién y cuándo. Anular una atención anula lo que nació en ella.
- [ ] La adenda muestra su autor y marca lo que corrige.
- [ ] La respuesta al presupuesto dice quién decidió y quién la anotó.
- [ ] Un control dice quién lo indicó y en qué atención.
- [ ] La atención anulada nombra lo que se anuló con ella, y sus papeles no siguen «vigentes».
- [ ] Un dato que agrega el equipo no queda como «declarado por el paciente», ni al revés.

**Ya falló:** se anuló una atención y la orden emitida en ella siguió vigente al comprobarla.
**Caso:** el 9 de marzo se firma una atención con receta y orden de radiografía. El 10 se anula con motivo. Historia la muestra anulada, con quién y cuándo; la receta y la orden se ven anuladas en Documentos y al comprobar su código.

## V-RAS-03 Rastro de la cita
**Aparece en:** el cajón de la cita (`CA/agenda/appointment-drawer.tsx`), ficha › Citas (`CA/patient/citas-panel.tsx`), Configuración › Actividad del equipo (`R/_org/settings.audit.tsx`, `S/workspace.ts`) y Reportes › «Cancelaron» (`CA/reports/report-list-drawer.tsx`).
**A mano:** cada reserva, cambio y cancelación dice quién, cuándo y, al mover, de qué fecha y profesional a cuál. Al cancelar, el motivo y la nota. El motivo sí tiene efecto (decide si se ofrece otra fecha): no se quita, se muestra.
- [ ] La Actividad muestra la fecha que tenía la cita en ese momento, no la de hoy.
- [ ] Mover dice de dónde a dónde, también cuando lo hace el paciente desde su enlace.
- [ ] El motivo y la nota de cancelación se ven donde se mira la cita cancelada.
- [ ] El cajón de la cita dice quién la dio y quién la cambió o canceló por última vez.

**Ya falló:** una cita reservada, movida y luego cambiada por la paciente desde su enlace: las tres filas de la Actividad decían la fecha final; el motivo de cancelación no se veía en el cajón, la ficha ni Reportes.
**Caso:** el 10 de marzo a las 9:00 recepción da una cita para el 12 a las 10:00; a las 9:30 la mueve al 13 a las 11:00; a las 20:00 la paciente la cancela desde su enlace por viaje. La Actividad y el cajón dicen los tres momentos con su fecha de entonces, y la cancelada muestra el motivo.
