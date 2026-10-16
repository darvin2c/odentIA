# 0033 · Documentos de la atención en un solo lugar

Fecha: 2026-10-16 · **Estado:** aceptada (fase 3, paso 2B; decisión 3 del lienzo) · Ajusta [0003](0003-nota-clinica-normativa.md): los exámenes auxiliares se piden como órdenes.

## Problema

Durante la visita el odontólogo salía de la atención para preparar un consentimiento, una orden o un formulario (miga › Documentos › Consentimientos › vuelta), y lo creado desde la ficha quedaba unido a la atención sin que esta lo mostrara. El profesional firmaba dos veces (dibujaba su firma en el consentimiento y usaba su perfil en la atención y la receta), la firma en papel no cerraba el pendiente, la orden no tenía tipo imagen ni hoja para entregar, y los «exámenes auxiliares» en texto libre competían con la orden. El cierre estaba repartido: lo que faltaba en una lista, el consentimiento pendiente en otra y lo que quedaba por cobrar recién después de firmar.

## Decisión y motivo

- **Un bloque «Documentos» en la atención** con «Nuevo»: receta, consentimiento, orden, formulario, imagen o archivo, cada uno lleno con lo de la atención (pieza, diagnóstico, procedimiento, quien atiende) y una sola acción por fila (firmar, imprimir, enviar). La receta deja de ser un bloque aparte. Lo que ya existía sigue siendo la misma entidad: no hay documentos paralelos.
- **El consentimiento se propone solo:** cada plantilla dice para qué servicios se pide (`consent_template_service`, por la clave de la plantilla, para que publicar otra versión no lo pierda). Lo que la atención pide se calcula al leer (`getEncounterConsentNeeds`: firmado, pendiente, sin preparar o sin publicar), una sola definición para el bloque, el cierre y la API. «Preparar» genera los que faltan sin duplicar.
- **Tres formas de firmar, con su nivel siempre a la vista** (`signature_method`, `signature_level`): en la silla (pantalla completa, varios seguidos), en papel (la foto de la hoja cierra el pendiente) y por enlace (paso 6). El profesional confirma con su perfil, sin dibujar: `professional_signature` pasa a opcional. El nivel es «simple» mientras no exista la firma avanzada con certificado (issue 47).
- **Un solo cierre que avisa sin bloquear:** un consentimiento sin firmar no impide cerrar, pero pide decir por qué y queda en la atención (`consent_skip_reason`, inmutable como el resto).
- **La orden** admite imagen, laboratorio y derivación; toma el diagnóstico de la atención, se imprime o se envía, recibe su resultado subido a la propia orden y se cancela con motivo. La derivación a un colega de la clínica le deja su tarea. Los exámenes auxiliares en texto libre ya no se escriben en una atención nueva (lo antiguo se sigue leyendo).
- **Papeles de salud solo a la persona o a su representante legal** (`health-documents.ts`), con el mismo envío que los documentos de cobro (`deliverDocumentPdf`): WhatsApp primero, correo si no, y si no hay ninguno, solo imprimir y decirlo. Un responsable económico no los recibe.
- **Sin consentimiento publicado** se firma en papel y quien configura lo ve en «Te espera» hasta publicarlo; se calcula del estado y se va sola.

Se eligió llevar todo a la atención porque es donde ocurre la visita: menos salidas, el contexto ya está y cada documento nace unido a ella. Proponer por servicio evita depender de la memoria del profesional sin inventar reglas clínicas: lo decide la clínica.

## Alternativas descartadas

- **Mantener cada documento en su pestaña de la ficha.** Conserva las salidas y la unión silenciosa; es lo que el estudio mostró como problema.
- **Bloquear el cierre sin consentimiento.** Una urgencia no puede esperar; bloquear empuja a firmar cualquier cosa. Avisar y pedir el motivo deja la constancia.
- **Vincular servicios a una versión de la plantilla.** Cada publicación obligaría a volver a marcarlos.
- **Firma dibujada del profesional.** Duplica lo que ya acredita su perfil (nombre y colegiatura) sin dar más valor legal: ninguna de las dos es firma certificada.

## Consecuencias

- Beneficio: la visita completa sin salir (33 → unos 20 clics en el recorrido del lienzo), el cierre junta todo, la firma en papel cuenta, la orden se entrega y lo que falta publicar no se olvida.
- Sacrificio: más lecturas al abrir la atención (necesidades de consentimiento, órdenes, recetas y formularios); los consentimientos firmados antes quedan sin método y se leen como firmados en la clínica.
- Revisar cuando exista la firma avanzada con certificado (issue 47) o cuando la clínica necesite pedir un consentimiento por algo distinto de un servicio.

## Referencias

Lienzo de la fase 3, tableros 2, 8 y 9 (decisión 3). Migración `packages/db/drizzle/0092_documentos_de_la_atencion.sql`. Contratos: `packages/services/src/clinical-forms.ts` (`getEncounterConsentNeeds`, `prepareEncounterConsents`, `signConsentDocument`, `listConsentsToPublish`, órdenes), `encounters.ts` (`checkEncounterClosing`, `finalizeEncounter`), `health-documents.ts`, `financial-documents.ts` (`deliverDocumentPdf`). Interfaz: `apps/platform/src/components/patient/encounter-documents.tsx`, `consent-signing.tsx`, `encounter-closing.tsx`.
