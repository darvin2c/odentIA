# 0096 · Demos para presentar, por tipo de clínica o consultorio

Fecha: 2026-10-27 · Estado: aceptada · Sigue a [0079](0079-un-nucleo-para-varios-productos.md), [0094](0094-la-ficha-de-la-clinica-con-sus-gastos-accion-por-accion.md) y la demo de ventas del PR 279. Lienzo «Demos para presentar», aprobado el 2026-10-27 con las 11 decisiones.

## Problema

En producción había una sola demo, «Dental Smile», y solo se creaba con un comando en el servidor (`DEMO_MODE=produccion` de la semilla de desarrollo). No había demo de latidIA. Tampoco se podían tener dos a la vez ni elegir el tipo de clínica que se visita: un pediatra veía una clínica dental. Y una demo creada hoy y abierta en tres semanas tenía la agenda de hoy vacía.

## Decisión y motivo

- **Se crean desde la administración.** Clínicas › «Crear demo» (solo el rol admin). Se elige el producto, el tipo, el tamaño (pequeño, mediano o grande), los meses de historia (6, 12 o 24), el país (Perú, Colombia o México), el nombre y quién la presenta. Quien presenta es alguien del equipo de la administración: entra como propietario y la ve en «Elige tu clínica». El resto del equipo de la demo es inventado y no tiene cuenta. Son clínicas como las demás, marcadas «Demo» y sin cobro, con el filtro «Clase» en la lista y una franja en su ficha.
- **Una receta por tipo, de cada producto.**
  - odentIA: clínica general, ortodoncia, implantes y odontopediatría.
  - latidIA: las cinco especialidades con que nace un consultorio, más Policlínico.
  - Cada receta dice quién atiende, quién llega (edad, sexo y, si es menor, su responsable), qué se escribe en cada atención (con diagnósticos de la CIE-11 oficial y, en latidIA, signos vitales y examen), qué se pregunta por WhatsApp, qué control se repite y sus servicios de la biblioteca.
  - Viven en `dental/demo-kinds.ts` y `medical/demo-kinds.ts`, y lo común las pide por `products.ts`.
  - El país pone moneda, zona, feriados, nombres, medios de pago, colegio profesional y especialidades.
- **Se inventa cada vez, con lo que ya existe.** La historia sale de `seedReports` y de las demás semillas de Reportes, que ahora aceptan una receta. Sin receta, la historia de Dental Smile queda igual. Cada demo tiene su semilla, así que «Volver a empezar» arma la misma.
- **Siempre al día.** El armado deja las dos semanas que vienen. Cada día de la zona de la clínica, el worker cierra lo que pasó (la mayoría atendida, con su atención firmada y su cobro; unas pocas faltan), agrega el día que entra, cierra las conversaciones viejas y deja la Bandeja y los controles de hoy. Lo que se hizo a mano en una presentación no se toca.
- **En una transacción, en el worker.** Armar tarda de segundos a un par de minutos y no frena las colas: corre aparte, de a una, y la fila late. Si el worker se corta, la demo queda «No se pudo crear» con «Intentar de nuevo», sin nada a medias. El avance se escribe por otra conexión.
- **Solo se borran las demos.** Ninguna función borra una clínica real: la historia clínica y los comprobantes se guardan (decisión del 2026-10-27). Borrar una demo, volver a empezar o el borrado a los 60 días sin abrirse actúan solo sobre una organización con su fila en `admin.saas_demo`; marcar «modo demo» en Cobros no basta.
  - Las tablas se leen de la base: toda tabla que cuelga de una clínica lleva `organization_id`. Así, una tabla nueva no deja restos.
  - Las comprobaciones de la base (claves foráneas, la caja que no se borra) se suspenden solo dentro de esa transacción (`session_replication_role`). Por eso necesita la conexión owner.
- **El comando se retira.** La semilla de desarrollo ya no tiene modo producción, y «Dental Smile» se vuelve a crear con el botón.

## Alternativas descartadas

- **Copiar la semilla de desarrollo para cada tipo.** Son más de 4000 líneas de una sola historia escrita a mano. Diez copias no se mantienen, y seguirían saliendo iguales.
- **Borrado en cascada desde la organización.** Con cascada, un solo borrado por error se lleva años de historias clínicas de una clínica real. Se prefirió que la base lo impida, salvo para las demos.
- **Correr cada demo en su propia cola de mensajes (pgmq).** Una demo tarda minutos y el visible de la cola es de 30 s. Se usó el mismo patrón de reclamo y latido de los avisos, con la fila como estado.
- **Dejar al cliente entrar a la demo.** La demo la muestra quien vende. Para probar solo, el cliente tiene la prueba gratis con su clínica real.

## Referencias

- `packages/db/src/schema/admin-demos.ts` y la migración 0010.
- `packages/services/src/demo-recipes.ts`, `demo-build.ts` (`buildDemo`, `advanceDemo`, `purgeDemoOrganization`), `saas-demos.ts`, `dental/demo-kinds.ts` y `medical/demo-kinds.ts`.
- `packages/services/src/seed-reports.ts` (`ReportsSeedRecipe`).
- `apps/worker/src/demos.ts`, `apps/api/src/routes/admin-demos.ts`.
- `apps/admin/src/components/demos.tsx`, `routes/_app/organizations.tsx` y `organizations_.$organizationId.tsx`.
