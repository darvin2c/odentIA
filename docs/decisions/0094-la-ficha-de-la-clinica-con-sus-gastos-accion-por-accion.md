# 0094 · La ficha de la clínica, con sus gastos acción por acción

Fecha: 2026-10-27 · Estado: aceptada · Sigue a [0085](0085-cobro-por-tipo-de-accion.md) y [0091](0091-una-administracion-neutra-para-los-dos-productos.md). Lienzo «Gastos por organización», aprobado el 2026-10-27.

## Problema

En la administración no se podía ver en qué gastaba una clínica. La ficha era una columna angosta al lado de la lista. Solo Clío tenía detalle: hasta 20 atenciones y «9 llamadas». Las preguntas a Argos no sabían lo que costaba cada una: `ai_usage.report_question_id` existía, pero nadie lo llenaba. Además, soporte veía montos y precios, y la regla dice que no ve cobros.

## Decisión y motivo

- **La ficha es una página** (`/organizations/<id>`) con cinco pestañas: Resumen, Gastos, Precio y prueba, Equipo y Actividad. La pestaña y los filtros de Gastos van en la dirección, y la lista conserva su búsqueda. La tabla de gastos no cabe en un panel al lado de la lista.
- **Cada acción con su costo** (`saas-cost-detail.ts`). Usa la misma unión de gastos y acciones que «Costo y margen» (`loadClinicCostContext`), así que una acción cuesta lo mismo en la lista que en su fila. Al abrir una acción se ve de qué se compone:
  - **Clío:** las pausas de la atención y lo que sugirió cada una.
  - **Sofi:** cada respuesta y lo que hizo, por las herramientas de su corrida.
  - **Argos:** lo que entendió de la pregunta y sus llamadas.

  Lo que no se cobró va aparte, con su costo.
- **Nada clínico ni ningún mensaje.**
  - De Clío se dice qué dejó hecho («nota y diagnóstico»), nunca lo dictado.
  - De Sofi, lo que hizo, nunca el texto.
  - De Argos, lo que entendió (su título), nunca lo que escribió la persona (ADR 0070). Si la pregunta era sobre un paciente, solo dice eso, porque el título puede llevar su nombre.
  - El paciente se nombra con la inicial y el apellido; el equipo, con su nombre.
- **El costo de cada pregunta se anota con ella.** `askArgos` avisa el id al anotar la pregunta (`onQuestion`). `meterAiUse` acepta un vínculo que se lee al guardar, porque el id llega cuando ya se gastó. Las preguntas de antes no tienen ese vínculo: su costo se reparte entre las preguntas de ese día y se marca «repartido». Las llamadas del buscador, que deciden adónde ir antes de que haya una pregunta, siguen sin pregunta.
- **Soporte no ve importes.** Ve el Resumen con cuántas conversaciones, atenciones y preguntas hubo (`GET /organizations/:id/agents`), además de Equipo y Actividad. Precio y prueba y Gastos son del rol admin, también en la API: leer o cambiar el precio, la prueba o el ciclo responde 403 a soporte. Antes, soporte podía proponer un descuento o una prueba para que la administración la aprobara; ahora lo pide a la administración.
- **El crédito del mes va en gris.** Usarlo entero es lo normal: lo que pasa se suma a la factura. El rojo queda para la alarma interna.

## Alternativas descartadas

- **Guardar lo que se le escribe a Argos.** Obliga a cambiar la ADR 0070 y los términos, porque las preguntas llevan nombres de pacientes. Lo que entendió alcanza para revisar qué pidió la clínica y cuánto costó.
- **Ampliar el panel al lado de la lista.** Una tabla de ocho columnas no cabe sin cortarse, y el enlace a los gastos de una clínica no se podría compartir.
- **Estimar el costo de cada pregunta con los tokens.** Sería otra cuenta distinta de la que reporta el proveedor; el vínculo da la exacta.

## Referencias

- `packages/services/src/saas-cost.ts` (`loadClinicCostContext`), `saas-cost-detail.ts` y `seed-saas-cost.ts`.
- `packages/agent/src/ai-usage.ts` (`meterAiUse`) y `argos.ts` (`onQuestion`).
- `apps/api/src/routes/reports.ts`, `saas-billing.ts` y `admin-organizations.ts`.
- `apps/admin/src/routes/_app/organizations_.$organizationId.tsx`, `components/org-summary.tsx` y `org-spending.tsx`.
