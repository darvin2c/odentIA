# 0035 · La ficha en cuatro secciones

Fecha: 2026-10-16 · **Estado:** aceptada (fase 3, paso 4; tablero 1 en versión 2 y decisiones 1 y 2 del lienzo) · Precisa [0029](0029-una-persona-una-pagina.md): para quien atiende, abrir la página cuenta como lectura clínica.

## Problema

Quien atiende tenía dos «Resumen»: el de la página y el «Resumen clínico» de Clínica, que era donde estaban las alergias, la última atención y lo pendiente. Clínica tenía trece secciones (Documentos abría otras seis), lo que pasó estaba en tres índices (Historia, Atenciones y Documentos › Todos) y Historia no mostraba los consentimientos, las órdenes ni las atenciones anuladas. Para abrir una atención había tres nombres. Además quedaban en la ficha piezas que no servían: «Paso siguiente» y «revisión sugerida» (no reservan nada ni avisan), «Exámenes auxiliares» en texto libre (la radiografía se pedía en dos sitios), el rol «acompañante» (ninguna regla lo usa) y una casilla de consentimiento en Antecedentes que guardaba una fecha sin versión del aviso ni finalidades.

## Decisión y motivo

- **Para quien lee la clínica (odontólogo, propietario, administrador), la pestaña Resumen es la clínica:** la atención en curso, las alergias y alertas, «Qué sigue» del plan (la misma regla `getPlanNextStep` de Plan), la última atención y la próxima cita. Sale «Resumen clínico». Recepción y caja ven el Resumen de siempre; caja entra por Cobros.
- **Abrir la página es una lectura clínica para esos roles.** La página pide el resumen clínico al abrirse, en cualquier pestaña, y esa lectura deja su traza en «Consultas a la historia» (`resumen`). Para recepción y caja nada cambia: su página no pide nada clínico. Es lo que precisa del 0029, que decía que abrir la página no era una lectura clínica.
- **Clínica en cuatro secciones:** Antecedentes, Odontograma, Historia («qué pasó y cuándo») y Documentos («buscar un papel»). Historia absorbe Atenciones, muestra las anuladas con su motivo y los papeles como hechos (firmó, se pidió, se completó), con los filtros Todo, Atenciones, Plan, Notas clínicas y Pieza. Documentos es una sola lista con filtros por tipo y «Requieren acción» (`?tipo=`); «Nuevo ▾» abre directo el formulario, cada fila se abre al lado y las imágenes se ven en su galería (precisado por el [0057](0057-documentos-una-sola-lista-tambien-para-las-imagenes.md): las imágenes son una fila más de la misma lista y se abren en su visor). Las secciones retiradas redirigen: `clinico` al Resumen, `atenciones` a Historia y cada tipo de papel a Documentos con su filtro.
- **Un botón de atender en la cabecera**, desde cualquier pestaña: «Continuar la atención», «Atender (10:00)» o «Atender». Los vacíos llevan su acción («Todavía no tiene atenciones · Atender»).
- **Se retiran cinco piezas y sus datos** (decisión 2; no hay datos reales): `encounter.next_step`, `next_appointment_at` y `auxiliary_exams` (con su lugar en el dictado y en el disparador de inmutabilidad), el tipo `acompanante` de las responsabilidades y `patient.data_consent_at`/`data_consent_by`. Lo que hace ese trabajo ya existe: los controles reservan y los recuerda el agente, la orden se pide desde la atención, quien solo acompaña va en «Personas vinculadas» y el consentimiento de datos vive en Datos con su versión y finalidades. Las alternativas del plan ya salieron en el 0034.
- **Recepción ve el presupuesto como lo recibe la persona** (decisión 4): cada tratamiento con su sitio («Resina · pieza 16»), sin superficies ni códigos. Caja sigue viéndolo como documento económico, sin pieza.

## Alternativas descartadas

- **Mantener «Resumen clínico» dentro de Clínica y no registrar la apertura.** Es lo que obligaba a la doctora a pasar por dos pantallas para ver una alergia; dejar la traza solo al entrar a Clínica haría que el Resumen mostrara la historia sin dejar constancia.
- **Que la página pida el resumen clínico solo en la pestaña Resumen.** Quien atiende entra por ella; pedirlo en cualquier pestaña da una sola regla («abrir la página es leer la historia») y deja al botón de la cabecera saber si hay una atención en curso.
- **Conservar las pestañas por tipo de documento.** Eran seis listas con su propio «Nuevo»; la lista única con filtros responde lo mismo con un solo lugar.
- **Dejar las columnas retiradas sin uso.** Cualquier pantalla o el dictado podían volver a escribirlas; borrarlas ahora cuesta una migración y no pierde nada.

## Consecuencias

- Beneficio: el odontólogo pasa de 20 a 11 secciones y el propietario de 24 a 15; un solo lugar para cada pregunta (vistazo, qué pasó, papeles, qué hacer) y menos campos que nadie leía.
- Sacrificio: la bitácora de consultas crece (unos 55 MB al año por clínica típica; este cambio suma alrededor de un 15 %, issue 84) y la página de quien atiende hace dos lecturas clínicas al abrir (resumen y antecedentes).
- Revisar si la bitácora necesita un plazo de conservación (issue 50) o si una norma exige registrar cada apertura y no una por hora.

## Referencias

Lienzo de la fase 3, tablero 1 (versión 2) y decisiones 1, 2 y 4. Migración `packages/db/drizzle/0094_la_ficha_en_cuatro_secciones.sql`. Contratos: `apps/platform/src/lib/patient-areas.ts` (secciones, retiradas y filtros de Documentos), `packages/services/src/patient-history.ts` (`getPatientSummary`, `getTimeline`), `packages/services/src/clinical-access.ts`, `apps/api/src/routes/patient-budgets.ts` (vista de cada rol). Interfaz: `apps/platform/src/routes/_org/people.$personId.tsx`, `components/person/person-summary.tsx`, `components/patient/resumen-clinico.tsx`, `documentos-panel.tsx`, `timeline.tsx`, `new-encounter-button.tsx`.
