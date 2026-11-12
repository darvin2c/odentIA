# Flujos clínicos de todos los productos

Lo que rodea a la atención y es igual en odentIA, latidIA y vistIA: lo que hay que tener listo para atender, lo que ve el paciente y lo que hace Sofi cuando toca lo clínico. Se revisa con el catálogo del producto (`odontologia.md`, `medicina.md` u `optica.md`), con las mismas reglas: comprobaciones, «ya falló», huecos conocidos y fuentes. Rutas: `S` = `packages/services/src/`, `CA` = `packages/clinic-app/src/components/patient/`, `R` = `packages/clinic-app/src/routes/`, `DB` = `packages/db/src/schema/`.

---

## P-COM-01 Perfil del profesional

**Dónde:** `packages/clinic-app/src/components/professional-profile-drawer.tsx`; las tablas `professional_profile`, `professional_specialty` y `professional_drawn_signature` (`DB/clinical-forms.ts`).

- [ ] Antes de su primera atención, el profesional sabe qué le falta para firmar (colegiatura COP o CMP, título y especialidad) y lo completa ahí mismo, sin salir de la atención.
- [ ] La firma dibujada se ve en los papeles. Cambiarla no reescribe lo ya emitido (ADR 0131).
- [ ] La especialidad del profesional coincide con la de la agenda y la de los servicios que ofrece.
- [ ] Nada presenta la firma dibujada como firma digital: en el Perú, lo clínico electrónico pide firma digital y que la historia informatizada esté acreditada. Va como pendiente legal, no frena.

**Fuentes:** ADR 0039 y 0131.

## P-COM-02 Configuración clínica

**Dónde:** Servicios y precios (`R/_org/services.*`, la biblioteca por país), Consentimientos (`R/_org/settings.forms.tsx`), Especialidades (`settings.specialties.tsx`) y Registro de pacientes (`settings.patient-registration.tsx`). Las tablas `treatment_template`, `dental_template_rule`, `service_catalog`, `consent_template`, `consent_template_service`, `clinical_form_template` y `service_material`.

- [ ] Cada servicio tiene lo que la atención necesita: código oficial (CPMS en el Perú), sesiones habituales, caras que admite y lo que deja en la pieza (odentIA), el consentimiento que pide y los materiales que descuenta.
- [ ] La biblioteca trae los servicios de todos los días para cada pieza (la endodoncia de anterior, premolar y molar) y una clínica nueva no arranca con huecos clínicos.
- [ ] Editar una plantilla de consentimiento no cambia lo ya firmado; una plantilla nueva llega a todas las clínicas y lo de cada clínica no se toca.
- [ ] Un formulario clínico propio se publica en versiones y lo respondido no cambia.
- [ ] La lista de diagnósticos de la clínica (CIE-10 del MINSA o CIE-11) se elige y no mezcla códigos.
- [ ] Lo que se pregunta al registrar coincide con lo que la clínica pidió.
- [ ] La lista de diagnósticos de la clínica trae los códigos que propone el odontograma (la caries con exposición pulpar, K02.5, en la CIE-10).

**Ya falló:** la demo solo tenía «Endodoncia anterior vital» activa y se ofrecía para un molar.
**Fuentes:** ADR 0039, 0069, 0093, 0117, 0141 y 0164.

## P-COM-03 De la cita a la atención

**Dónde:** Agenda (`R/_org/agenda.tsx`, `packages/clinic-app/src/components/agenda/`), Inicio («Mis pacientes de hoy») y la tabla `appointment_plan_item`.

- [ ] La cita guarda a qué viene: el tratamiento y la sesión del plan, el control o la primera vez. La atención lo recibe (P-ODO-03).
- [ ] Recepción marca la llegada y el profesional ve quién está esperando (ADR 0032).
- [ ] «Atender» está donde el profesional lo busca: en Inicio, en la cita y en la ficha. Una cita pasada sin atención pregunta si vino.
- [ ] La cita usa la unidad o el consultorio correcto y avisa si está ocupado, sin frenar (ADR 0121; las excepciones las decide el equipo, nunca Sofi).
- [ ] Una cita de sesión 2 no se ofrece el mismo día de la sesión 1 si el tratamiento pide espera.
- [ ] Al firmar, la cita queda atendida y lo que sigue queda reservado o pendiente, sin perderse (ADR 0113).
- [ ] Si una sesión se hace antes de su cita, el cierre ofrece liberar esa cita o usarla para lo que sigue.

**Ya falló:** «¿Vino?» abría «Por confirmar» (PR 551); la grilla no mostraba qué unidad estaba libre (8 nov).
**Fuentes:** ADR 0002, 0032, 0081, 0113, 0121 y 0128.

## P-COM-04 El paciente en su enlace y su portal

**Dónde:** `R/public/portal.tsx` (el portal), «Su enlace» (ADR 0037), `R/public/registro.tsx`, la firma por enlace y el cuestionario antes de la cita (`S/portal-questionnaire.ts`). Las tablas `portal_link`, `portal_session` y `portal_access_log`.

- [ ] El paciente ve su próxima cita, «Antes de tu cita» si hay cuestionario, lo que tiene por decidir (un presupuesto con sus opciones) y sus documentos, según lo que la clínica le dio.
- [ ] Lo que responde en el cuestionario llega a Antecedentes como «declarado por el paciente», y el profesional lo revisa antes de atender. **Hoy solo pasan las alergias** (`S/clinical-forms.ts`, `FIELD_DEFINITIONS`): la medicación y las enfermedades declaradas (un anticoagulante) se quedan en la respuesta del formulario y no se ven al indicar una exodoncia.
- [ ] El adolescente: lo que el representante ve en el portal respeta la confidencialidad que la norma le da al adolescente (planificación familiar, salud mental). Hoy el representante ve todo.
- [ ] Firmar un consentimiento por el enlace muestra la misma hoja que el papel, con la misma declaración, y queda pendiente hasta que el profesional lo confirma.
- [ ] Un menor: decide y firma su representante, y el niño no recibe lo que no le toca.
- [ ] Los papeles de salud se envían solo a quien decide (`S/health-documents.ts`).
- [ ] Cada envío manda el PDF, y el portal muestra todo lo suyo (ADR 0156).
- [ ] A 390 px y con un celular viejo, se lee y se usa.

**Ya falló:** la declaración no se veía en el enlace y faltaba la pieza (PR 479); un documento mandado por enlace en vez del PDF (PR 501).
**Fuentes:** ADR 0037, 0101, 0116, 0148 y 0156.

## P-COM-05 Papeles emitidos y su comprobación

**Dónde:** las rutas de impresión (`R/_org/patients.$patientId.*.print.tsx`: consentimiento, receta, orden y descanso; el odontograma en `apps/dental-clinic`), la tabla `issued_paper` y `R/public/comprobar.$token.tsx`.

- [ ] Cada papel se emite una vez, con su huella, y es el mismo para verlo, enviarlo y descargarlo (ADR 0132).
- [ ] El QR del papel abre su comprobación sin cuenta. Un código falso y uno que no existe dicen lo mismo, sin revelar nada.
- [ ] Lo impreso dice lo mismo que la pantalla: pieza, diagnóstico, dosis, fechas y quién firmó.
- [ ] Un papel anulado se ve anulado al comprobarlo.

**Fuentes:** ADR 0115, 0132 y 0133.

## P-COM-06 Datos personales, historia bloqueada y copia de la historia

**Dónde:** Protección de datos (`R/_org/settings.data-protection.tsx`), `R/_org/people.locked.tsx` y las tablas `patient_data_consent`, `patient_data_request` y `patient_record_opening`.

- [ ] Al registrar se pide el consentimiento para el tratamiento de los datos personales, con sus finalidades, y se puede revocar.
- [ ] Un pedido de la persona (copia, corrección o borrado) se atiende y deja rastro.
- [ ] La historia bloqueada no se abre. Administración la abre con motivo, para leer durante una hora y sin cambiar nada, y queda en la auditoría.
- [ ] «Vuelve a atenderse» desbloquea la ficha entera y queda registrado.

**Ya falló:** lo de permisos y datos no se escribe aquí, porque el repositorio es público: está en los informes privados de `~/odentia-qa/`.
**Fuentes:** Ley 29733 (protección de datos personales) y su reglamento; NTS 139-MINSA; ADR 0080.

## P-COM-07 Historias que vienen de otro sistema

**Dónde:** la carga de una clínica nueva (`S/clinic-import.ts`, la skill `odentia-carga`, ADR 0104).

- [ ] Las personas cargadas no se duplican con las que ya escriben por WhatsApp (persona única).
- [ ] Las alergias, enfermedades y medicación cargadas quedan como antecedentes que el profesional revisa, no como confirmados.
- [ ] Lo cargado dice de dónde viene y cuándo, y no se confunde con lo atendido en odentIA.
- [ ] El saldo y los tratamientos a medias del sistema anterior aparecen donde el profesional los busca.

**Fuentes:** ADR 0001 y 0104.

## P-COM-08 Materiales y lotes

**Dónde:** «Materiales» de la atención (`CA/encounter-materials.tsx`), los materiales del servicio (`service_material`) e Inventario (`product_lot`, ADR 0067 y 0106).

- [ ] Lo que usa el servicio se descuenta solo, por cada vez que se hace, y se puede corregir.
- [ ] Un material vencido o sin stock se avisa antes de usarlo, sin frenar la atención.
- [ ] Lo que tiene que ser trazable (un implante, un injerto, un material de un lote retirado) guarda su lote en la atención del paciente. Hoy la atención no guarda el lote.
- [ ] El látex u otro alérgeno del material avisa si el paciente es alérgico.

**Huecos conocidos:** el lote no queda en la atención; el látex no avisa en los materiales.
**Fuentes:** ADR 0067 y 0106; DIGEMID para la trazabilidad de los dispositivos médicos.

## P-COM-09 Sofi cuando toca lo clínico

**Dónde:** el agente de mensajes (`packages/agent/`), `S/emergency-advice.ts`, los textos de `S/medical/agent-texts.ts` y los avisos de control.

- [ ] Un síntoma para pedir cita no se trata como pedir una persona: Sofi ofrece la cita adecuada (ADR 0095).
- [ ] Una señal de alarma recibe el número de emergencias del país y le llega al equipo. Sofi no da indicaciones clínicas.
- [ ] Sofi sabe cómo va la atención (la sesión que sigue, el control pendiente, el presupuesto por decidir) y lo dice igual que la ficha (ADR 0104).
- [ ] Sofi no guarda datos clínicos en su memoria de la persona (ADR 0010) ni los cuenta a quien no es el paciente o su responsable.
- [ ] El recordatorio del control coincide con el control de la ficha.
- [ ] **odentIA tiene sus propias señales de alarma.** Hoy la lista está vacía (`S/dental/agent-texts.ts`, `alarmSignals: []`): una celulitis que cierra el ojo, no deja tragar o da fiebre (angina de Ludwig), un sangrado que no para después de una exodoncia o un diente que se cayó por un golpe dependen de lo que diga el modelo.
- [ ] La duda clínica que escribe el paciente llega al profesional que lo atiende (P-COM-12).

**Huecos conocidos:** las señales de alarma dentales están vacías.
**Fuentes:** ADR 0010, 0095 y 0104 («Sofi trabaja con la atención entera»); guías de infecciones odontogénicas; IADT para el trauma.

## P-COM-10 Tareas y derivación dentro de la clínica

**Dónde:** Tareas (`R/_org/tasks.tsx`) y la orden de tipo interconsulta (`CA/ordenes-tab.tsx`).

- [ ] La derivación a un colega le llega como tarea con el motivo, la pieza o el problema y lo que se hizo, y la respuesta vuelve a la historia.
- [ ] Un pendiente clínico (un resultado que falta, un control) tiene un solo lugar y no se pierde (ADR 0025).

**Fuentes:** ADR 0025.

## P-COM-11 Evento adverso y reacción adversa

No tiene camino en el código.

- [ ] Una lipotimia, una anafilaxia, una lima fracturada, una reacción a un fármaco o a una vacuna se registra en la atención, con qué pasó y qué se hizo.
- [ ] La alergia que se descubre así pasa a Alergias.
- [ ] Lo que hay que notificar (farmacovigilancia, tecnovigilancia o ESAVI en una vacuna) se avisa al profesional.

**Fuentes:** DIGEMID (farmacovigilancia y tecnovigilancia); la norma de ESAVI del MINSA; seguridad del paciente de la OMS.

## P-COM-12 La duda clínica que llega por mensaje

**Dónde:** `S/agent-operations.ts` manda la duda clínica al profesional que atiende y, si está ausente, a recepción; `S/agent-learning.ts` impide enseñarle a Sofi una respuesta clínica.

- [ ] La pregunta llega al profesional, no se queda con Sofi.
- [ ] La respuesta del profesional por WhatsApp es un consejo clínico: puede quedar en la historia y no se pierde si la persona pide borrar sus conversaciones.
- [ ] Si la duda va a recepción porque el profesional no está, recepción no ve más de lo que le toca.

**Fuentes:** NTS 139-MINSA; Ley 30421 (telesalud).

## P-COM-13 La persona rechaza el tratamiento

- [ ] Si rechaza lo indicado (una exodoncia, una referencia a emergencia), queda constancia de que se le explicaron los riesgos, con su firma o la de su representante. Hoy solo existe «No acepta» en el presupuesto, que es comercial.
- [ ] La negativa se ve en la Historia y no se confunde con «todavía no decide».

**Fuentes:** Ley 29414 y su reglamento.

## P-COM-14 Tratamiento interrumpido

**Dónde:** el estado `suspendido` del plan (`S/plan.ts`), `S/treatment-journey.ts` y «Invitar a volver» (`S/return-invites.ts`).

- [ ] Quien deja una endodoncia o un tratamiento a medias recibe un aviso clínico pronto, no el mismo «Invitar a volver» de 6 meses que una limpieza.
- [ ] Queda constancia de que se le avisó.
- [ ] El profesional ve sus tratamientos interrumpidos con riesgo.

## P-COM-15 Las indicaciones que se lleva el paciente

- [ ] Las indicaciones de la atención (después de una exodoncia, los signos de alarma para la mamá) le llegan a la persona en papel o por mensaje. Hoy solo salen en la Hoja de atención para el seguro (`S/clinical-papers.ts`).
- [ ] La receta y las indicaciones van juntas y dicen lo mismo.

## P-COM-16 Paciente fallecido

No tiene camino en el código.

- [ ] Se puede marcar que la persona falleció, con la fecha. La historia se conserva.
- [ ] Dejan de salir los recordatorios de control, «Invitar a volver» y las promociones (`S/automation-messages.ts`).

**Fuentes:** HL7 FHIR `Patient.deceased`.

## P-COM-17 Formularios clínicos llenados en la atención

**Dónde:** `clinical_form_template`, `clinical_form_response` y `clinical_form_addendum` (`DB/clinical-forms.ts`); por ejemplo, la «Evaluación de endodoncia» de la semilla.

- [ ] Los campos obligatorios se piden, lo finalizado se corrige con una adenda y lo descartado pide motivo.
- [ ] Lo respondido aparece en la Historia, el PDF y FHIR.
- [ ] Lo que se anota ahí (vitalidad, percusión) no queda aislado del examen ni del diagnóstico.

## P-COM-18 Sospecha de violencia o maltrato

No tiene camino en el código.

- [ ] Las lesiones que no cuadran con el relato, sobre todo en un niño, se pueden registrar y el profesional sabe que debe denunciarlas.

**Fuentes:** Ley 30364 (obligación de los profesionales de salud de denunciar; verificar el artículo); guía de maltrato de la AAPD; ficha de tamizaje de violencia del MINSA.

## P-COM-19 Libro de reclamaciones de la clínica

- [ ] Cada clínica, como establecimiento de salud, tiene su libro de reclamaciones. El de `S/consumer-complaints.ts` es el de odentIA como plataforma, no el de la clínica.

**Fuentes:** SUSALUD (reglamento del libro de reclamaciones en salud; verificar el número vigente).

## P-COM-20 Lo que paga la clínica y su comprobante

**Dónde:** Finanzas › Gastos (`packages/clinic-app/src/components/finance/`), Inventario › pagar una compra (`components/inventory/purchase-payment-drawer.tsx`) y Reportes › Finanzas. Las tablas `expense`, `expense_recurring` y `supplier`.

- [ ] Cada pago dice con qué se pagó y su n.º de operación, igual al registrar un gasto, al pagar lo que se repite y al pagar una compra.
- [ ] El comprobante es el del país (tabla 10 de SUNAT en el Perú), con su número. El RUC del proveedor se revisa y se dice si no cuadra.
- [ ] Un comprobante propuesto no se guarda como real: lo que falta (número o RUC) se ve en la lista.
- [ ] El contador puede llevarse la lista del mes con tipo, número, RUC, total, medio y operación.
- [ ] Corregir deja el rastro de todo lo que cambió, incluido el comprobante.
- [ ] El pago a un especialista que no está en planilla (recibo por honorarios) dice a quién y su RUC, y no se suma dos veces con su comisión.
- [ ] Gastos y Reportes dicen la misma cifra por tipo y por sede.
- [ ] Del lado de lo que cobra la clínica: con deuda abierta, un adelanto sin «Para» lo avisa y ofrece cobrarlo a lo que debe; todo ticket dice cuánto le falta pagar y cuánto le queda a favor, y la lista de Cobros no suma como dinero lo que solo usó saldo a favor.
- [ ] En caja, el cobro de un menor lo paga por defecto su representante.

**Fuentes:** ADR 0061, 0150, 0151 y 0167. SUNAT: tabla 10 de comprobantes, RUC de 11 dígitos con verificador y el registro de compras (verificar los artículos antes de citarlos).

## P-COM-21 Avisos en el equipo de cada persona

**Dónde:** el interruptor «Recibir avisos en este equipo» en la campana (`packages/clinic-app/src/components/device-notices.tsx`), el envío del worker (`apps/worker/src/push.ts`, `packages/services/src/push.ts`) y la tabla `push_subscription`.

- [ ] La pantalla bloqueada no muestra nombre, motivo, texto del mensaje, consentimiento ni resultado: solo la clínica y qué pasó.
- [ ] Llega a quien le toca con la regla de Inicio: el clínico, solo lo suyo; con el permiso de ese momento.
- [ ] Fuera del horario de la clínica no avisa lo de «Te espera»; lo de la noche llega al abrir.
- [ ] Leer el aviso no resuelve nada: sigue en «Te espera» hasta que alguien lo atiende.
- [ ] Nada aparece sobre la firma o el registro en la tablet que se le pasa al paciente (hoy: no se activa ahí, lo dice la ayuda).
- [ ] Quien cierra sesión o deja la clínica deja de recibirlos en ese equipo.

**Fuentes:** ADR 0177 y 0084. Ley 29733 de datos personales y su reglamento (datos sensibles de salud; verificar artículos), Ley 26842 (reserva del acto médico; verificar el artículo).

## P-COM-22 Guardia de urgencias de la clínica

- [ ] Una alarma de un paciente fuera de horario tiene un destinatario explícito, o queda dicho que nadie la verá hasta que la clínica abra (hoy no existe la guardia: lo de la noche llega al abrir).

## P-COM-23 La hoja membretada de la clínica en los papeles

**Dónde:** Configuración › Datos de la clínica › «Hoja membretada» (`CA/settings/clinic-letterhead.tsx`); el dibujo en `S/document-kit.ts` (`embedSheet`, `sheetLetterhead`) y la hoja de cada momento en `S/letterhead.ts` (`getLetterheadAt`), tabla `clinic_letterhead`.

- [ ] Receta, orden, descanso, hoja de atención, consentimiento, presupuesto, historia y comprobante en A4 salen sobre la hoja en **todas** sus páginas; el ticket térmico, sin ella.
- [ ] Cada papel lleva la firma dibujada y el sello (nombre, título y colegiatura) de quien lo emite, y la razón social y el RUC en la línea chica bajo la hoja.
- [ ] Con «Mi hoja ya trae la dirección y el teléfono», no se repiten; el comprobante dice siempre una dirección (la fiscal o la de la sede que cobró).
- [ ] Con los márgenes más anchos y más altos que se permiten, una receta de un ítem sale en una hoja con la firma, el sello y el QR enteros y legibles.
- [ ] Lo emitido o firmado antes de cambiar la hoja sale igual al abrirlo después, también si nunca se había abierto (la hoja es la de su fecha de emisión o firma).
- [ ] La hoja que se firma en la tablet o en el enlace muestra su parte de arriba y la de abajo, centrada como un papel.
- [ ] El odontograma impreso lleva la hoja sin marca de agua bajo el gráfico, y su parte de arriba y la de abajo de borde a borde en cada página, sin tapar texto.
- [ ] En una receta de varias páginas, la alergia y el nombre del paciente se leen en la página de la firma.
- [ ] Si la hoja dice el nombre o la colegiatura de una persona, la receta de otro profesional no deja dudas de quién receta (riesgo aceptado: una sola hoja por clínica; se avisa al subirla).

**Ya falló:** con 45 mm a cada lado, el bloque de firma salía letra por letra en la página 2; el odontograma impreso dejaba la parte de abajo de la hoja a media página (QA del 11 nov, corregidos antes de unir).
**Huecos conocidos:** no hay hoja por profesional (ADR 0182).
**Fuentes:** ADR 0115, 0132, 0148 y 0182; Manual de Buenas Prácticas de Prescripción (DIGEMID-MINSA) para los datos del prescriptor.

---

## Casos

| Caso | Situación | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| CC1 | Un profesional nuevo de la clínica va a atender por primera vez, sin colegiatura ni firma. | 01 | Se entera antes de firmar y lo completa sin perder la atención. |
| CC2 | Recepción reserva la sesión 2 de un tratamiento, marca la llegada y el profesional atiende desde Inicio. | 03 | La atención sabe a qué viene y al firmar la cita queda atendida. |
| CC3 | El paciente completa el cuestionario antes de su cita (declara una alergia), revisa su presupuesto en el portal y firma el consentimiento desde su celular. | 04, 05 | La alergia llega como declarada y el profesional la confirma; la firma queda pendiente hasta confirmarla; el PDF coincide. |
| CC4 | Alguien comprueba con el QR una receta impresa y después la receta se anula. | 05 | Antes dice válida; después, anulada. |
| CC5 | Un paciente que no viene hace años pide su copia de la historia y después vuelve a atenderse. | 06 | La copia sale completa; la ficha se desbloquea y queda registrado. |
| CC6 | Se coloca un implante de un lote que luego se retira del mercado. | 08 | Se puede saber a qué paciente se le puso ese lote (hoy no). |
| CC7 | Una mamá escribe por WhatsApp que su hijo se golpeó y se le cayó un diente. | 09 | Sofi lo trata como urgencia, sin indicación clínica, y avisa al equipo. |
| CC8 | «Se me hinchó la cara, no puedo abrir la boca y tengo fiebre», tres días después de una exodoncia. | 09, 12 | Respuesta de urgencia y aviso al equipo; la duda llega al odontólogo (hoy no hay alarmas dentales). |
| CC9 | Una paciente declara en el cuestionario que toma warfarina, y la cita es para una exodoncia. | 04, 13 | El anticoagulante aparece en Antecedentes como declarado y se ve al indicar (hoy no pasa). |
| CC10 | Durante la anestesia, el paciente se desmaya. | 11 | El evento queda en la atención y lo que se hizo; no se pierde. |
| CC11 | El paciente rechaza la exodoncia indicada y se va con la pieza infectada. | 13, 14 | Constancia del rechazo con los riesgos explicados; aviso si no vuelve. |
| CC12 | La familia avisa que el paciente falleció. | 16 | Se marca; no salen más mensajes; la historia queda. |
| CC13 | Fin de mes en una clínica de dos sedes: se paga la luz por otro importe, la factura del laboratorio y los honorarios del endodoncista visitante; se corrige un RUC mal escrito y se le entrega la lista al contador. | 20 | Todo con su comprobante y RUC; la corrección dice qué cambió; la lista se descarga; Gastos y Reportes cuadran. |
| CC14 | A las 22:30 una paciente escribe «se me hinchó la cara y no puedo tragar» tres días después de una exodoncia, mientras otra paciente firma en la tablet de la unidad. | 09, 21, 22 | La paciente recibe el número de emergencias; el aviso al equipo no lleva su nombre y llega al abrir (no hay guardia); la tablet no muestra nada. |
| CC15 | La clínica sube una hoja con el nombre y la colegiatura de una doctora; otro odontólogo emite una receta de 5 ítems a una paciente alérgica a penicilinas, y después la clínica ajusta los márgenes. | 01, 05, 23 | La receta pasa a 2 páginas con la hoja en ambas, la firma y el sello de quien receta; lo emitido antes del ajuste sale igual; una receta nueva con márgenes al máximo deja la firma entera. |
