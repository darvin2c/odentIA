# 0165 · La atención es una sola página que sabe a qué viene la persona

Fecha: 2026-11-09 · Estado: aceptada · Sustituye, de ADR 0033, que la atención en borrador se edite por bloques que se abren en un cajón con «Listo», y que el consentimiento se pida por lo indicado

## Problema

El dueño usó la atención y dijo que no sirve. Un odontólogo con ojo de UX la recorrió en la demo (QA del 8 nov): cada bloque era una tarjeta cerrada con un conteo («2 hallazgos», «3 indicados hoy»), para ver o escribir algo había que pulsar «Abrir» y solo cabía un bloque a la vez en un cajón; lo de todos los días (odontograma, procedimientos, plan, documentos) estaba en «Agregar si ocurrió». Una primera consulta costaba unos 80 clics y 10 cajones. Sin cita, la atención salía en blanco aunque la persona viniera a su sesión 2, a su control o con un plan a medias: la sesión y el control aparecían recién al firmar, «Hecho hoy» decía «sesión 1 de 2» con la 2 registrada y el control de otro doctor venía desmarcado. El consentimiento se pedía por todo lo indicado: la corona de dentro de semanas se firmaba el día de la endodoncia.

## Decisión y motivo

- **Una sola página editable, con la estructura de la atención firmada.** Consulta (motivo y tiempo en línea; el relato, con un toque), el examen del producto (latidIA: siempre; odentIA: en «También»), el odontograma siempre, a todo el ancho, con lo registrado hoy debajo, diagnósticos, «Realizado hoy», Plan con el presupuesto, Documentos y «Evolución e indicaciones». Lo opcional que no tiene nada (examen clínico, pronóstico, periodontograma) va en una fila «También» y, con algo escrito, queda abierto. Solo lo que tiene varios campos o un catálogo sigue en cajón: registrar un procedimiento o un diagnóstico, el panel de la pieza, anotar la respuesta, firmar. Guardado solo automático, como antes; sin «Listo».
- **«Hoy viene a…» lo calcula el servidor al leer la atención** (`encounterVisitOf`), con o sin cita: lo que trae su cita, los tratamientos aceptados por hacer con la sesión que le toca hoy (las hechas en otras atenciones más una) y los controles con su ventana abierta, con quién los indicó. Elegir prepara, no hace: «Hacerla hoy» o «Continuar hoy» une el tratamiento a la atención como lo haría su cita (`bringTreatmentToEncounter`), pone «Continúa: …» si el motivo está vacío y registra el diagnóstico que sigue con su tipo de la última vez (nunca lo sube a definitivo; sin uno conocido, lo propone); la sesión cuenta al registrar su procedimiento y, si no se registra, el cierre lo avisa también sin cita. «Hoy no» lo saca mientras no tenga su sesión. «Viene a su control» queda en la atención (`encounter.visit_follow_up_id`): el cierre lo trae marcado aunque lo haya indicado otro doctor y se cumple al firmar, como cualquier control (ADR 0152). «Es una urgencia» solo deja el motivo listo para escribir: no es un estado.
- **El consentimiento es de lo que se hace hoy**: lo registrado como hecho y lo traído a la atención (su cita o «Hacerla hoy»). Lo indicado para otro día lo pide el día que se hace; firmarlo antes sigue a mano con «Nuevo» › Consentimiento. «Firmar ahora» abre primero el que se pulsó.
- **Corregir lo indicado hoy, en el mismo renglón.** «Quitar» (`removeIndicatedFromEncounter`) vale solo para lo indicado en esta atención, sin respuesta y con su presupuesto aún en borrador: sale del presupuesto (la opción que queda vacía, con él) y se cancela con un motivo fijo que el Plan no lista. «Cambiar» es `updatePlanItem`, el mismo del Plan.
- **El presupuesto en una línea honesta**: cada opción con su total, «falta que elija» y, elegida, «Eligió la opción A» con lo que cuesta esa opción (`budgetLine`). Un solo botón principal, «Anotar su respuesta»; mostrar, imprimir y enviar van en un menú.
- **Dictar es un botón de la cabecera**; los ejemplos, la primera vez que se dicta o con «¿Qué puedo decir?». Lo que Clío lee y hace no cambia.

Vale para odentIA y latidIA: la página, la franja, el consentimiento y el presupuesto son comunes; latidIA no tiene odontograma y su examen va siempre a la vista.

## Alternativas descartadas

- *Mantener los cajones y abrir varios a la vez:* sigue escondiendo lo hecho detrás de un conteo, que es lo que el dueño rechazó.
- *Calcular «Hoy viene a…» al crear la atención:* se pierde al recargar o si cambia el plan; al leerla siempre está al día.
- *Marcar todos los controles por cumplir al firmar:* un control vencido se daría por cumplido en una urgencia que no lo cumple; por eso se elige.
- *Pedir consentimiento por lo aceptado hoy:* la opción A (endodoncia y corona) se acepta junta y la corona se hace en semanas.

## Consecuencias

- Menos clics en la pantalla real (de «Atender» a firmar): paciente nuevo con dos opciones, de unos 64 a 39; sesión 2 sin cita, de unos 19 a 7; control de otro doctor, de unos 16 a 9.
- La página es más larga: lo que falta para firmar lleva a su campo desde el pie fijo.
- Sacrificio: el consentimiento aparece cuando se registra o se trae lo de hoy, no al indicarlo; quien prefiera firmar el plan entero lo hace a mano.
- Se revisaría si las clínicas firman habitualmente todo el plan el primer día.

## Referencias

- Informe: QA «La atención de odentIA, usada de verdad» (8 nov 2026), apartado 4.
- `packages/services/src/encounter-visit.ts`, `encounter-plan-remove.ts`, `clinical-forms.ts` (`getEncounterConsentNeeds`), `plan-next.ts` (`budgetLine`), `packages/db/drizzle/0070_atencion_viene_a_su_control.sql`, `0071_hoy_no_quita_lo_traido.sql`.
- `packages/clinic-app/src/components/patient/encounter-editor.tsx`, `encounter-visit.tsx`, `encounter-plan-panel.tsx`.
- Pruebas: `encounter-visit.test.ts`, `budget-paths.test.ts`, `site-findings.test.ts`.
