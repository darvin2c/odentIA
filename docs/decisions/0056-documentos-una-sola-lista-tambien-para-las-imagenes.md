# 0056 · Documentos: una sola lista, también para las imágenes

Fecha: 2026-10-18 · **Estado:** aceptada (lienzo del issue 149, aprobado entero en su versión 3) · Precisa [0035](0035-la-ficha-en-cuatro-secciones.md): las imágenes ya no «se ven en su galería».

## Problema

En la página de una persona, Clínica › Documentos era una lista de papeles, pero el filtro «Imágenes» la cambiaba por otra pantalla: la galería, con su título, su buscador, siete filtros, «Filtrar por piezas» y tarjetas grandes. Un filtro que se veía igual a los demás hacía otra cosa. «Buscar un papel» era un texto sin campo. La fila de una imagen no la abría («Ver en la galería»), la misma tomografía se llamaba «Radiografía» en la lista y «Tomografía (CBCT)» en la galería, la lista fechaba por la subida y la galería por la toma, y con una atención abierta la galería filtraba sola por ella y mostraba cero imágenes sin decir por qué.

## Decisión y motivo

- **Una sola lista.** «Imágenes» acorta la misma lista, como Recetas u Órdenes; «Todo» va primero, como en Historia. La imagen es una fila más: dice su tipo, su fecha de toma, sus piezas y su estado («Sin informar»), con su miniatura, y se ordena por la toma. La lista se separa por mes.
- **La fila abre la imagen de una vez.** La tomografía completa abre su visor; lo demás, el visor de archivos, con «Anterior / Siguiente» por la lista a la vista y «Comparar con» (que propone primero la misma pieza y el mismo tipo). No hay cuadrícula.
- **Un buscador y un filtro de pieza para todo.** El buscador mira nombre, tipo, piezas, estado y etiquetas de todos los papeles; «Pieza» es el de Historia. De los filtros de la galería no queda ninguno más: tipo y etiqueta los cubre el buscador; periodo y orden sobran; atención y tratamiento los dice la fila o el visor. Lo retirado se consulta al pie.
- **Los filtros de tipo solo aparecen si filtran algo**, y cada papel sale una vez: el PDF firmado vive en su consentimiento, el informe de una orden en su orden; lo que no es imagen ni consentimiento va en «Otros archivos».
- **«Sin informar» no cuenta como pendiente.** Toda radiografía nace así y el informe se escribe en la evolución o en la orden: si contara, «Requieren acción» crecería con cada periapical.

Una sola forma de buscar y abrir un papel es lo que pedía el 0035 («Documentos es una sola lista»); la galería era la excepción.

## Alternativas descartadas

- **Mantener la galería como vista dentro del filtro** («Ver como miniaturas»): una segunda forma de ver lo mismo, con sus propios controles que mantener y explicar. Comparar y pasar de una imagen a otra ya viven en el visor.
- **Conservar sus siete filtros en la lista:** era lo que hacía densa la pantalla; el caso común (una pieza) lo cubre «Pieza».
- **Que «Sin informar» cuente en «Requieren acción»:** llenaría la lista de radiografías tomadas en la propia clínica. Si las tomografías externas sin leer se quedan olvidadas, revisar solo para ellas.

## Consecuencias

- Beneficio: abrir la tomografía de una persona pasa de dos clics y otra pantalla a uno; la misma cosa tiene un nombre y una fecha.
- Sacrificio: se pierde la cuadrícula de miniaturas y el filtro por varias piezas a la vez; la lista pide la URL firmada de la miniatura de cada imagen a la vista.
- Revisar si una clínica con cientos de imágenes por persona necesita paginar o volver a una vista de miniaturas.

## Referencias

Lienzo «Documentos e Imágenes» (issue 149, decisiones 1 a 11). Interfaz: `apps/platform/src/components/patient/documentos-panel.tsx` (la lista), `document-viewer.tsx` (el visor de archivos y `DocumentViewerHost`), `apps/platform/src/lib/document-list.ts` (filtros, buscador, cada papel una vez) y `lib/patient-areas.ts` (`DOCUMENT_FILTERS`).
