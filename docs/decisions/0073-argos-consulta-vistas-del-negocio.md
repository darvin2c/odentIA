# 0073 · Argos consulta las vistas del negocio con la llave de quien pregunta

Fecha: 2026-10-20 · Estado: aceptada · Sustituye en parte a [0070](0070-argos-responde-con-las-cifras-de-reportes.md): el modelo ya no elige de un catálogo cerrado. Issue darvin2c/odentIA#192; lienzo «Argos conoce la base», aprobado entero el 2026-10-20 (decisiones D1 a D7).

## Problema

Con 36 preguntas escritas por un dueño, el Argos de 0070 acertó 17. Falló de dos maneras: dijo «todavía no sé» aunque el dato existía (lo que no estaba entre sus 32 cifras) y respondió otra cifra parecida sin decirlo. Un catálogo cerrado no alcanza para cruzar, ordenar o comparar lo que nadie previó. Pero dejar que un modelo escriba consultas sobre las tablas tiene tres riesgos: números distintos a la pantalla (sumar pagos sin descontar lo anulado), ver lo que el rol no ve y leer otra clínica.

## Decisión y motivo

- **Vistas del negocio, no tablas.** El esquema `argos` tiene vistas que ya traen las reglas de odentIA: lo cobrado sin lo anulado ni lo devuelto, una opción por presupuesto, el estado único de la cita, personas sin spam, el día en la zona de la clínica. Solo leen lo que aporta un número y los nombres que lo acompañan: nunca texto libre (mensajes, notas, motivos escritos) ni historia clínica.
- **La base garantiza los permisos, no el modelo.** Las vistas son de `argos_dueno`, un rol sin `BYPASSRLS` sujeto a la RLS de la clínica. Cada rol de la aplicación tiene su llave de solo lectura (`argos_gestion`, `argos_recepcion`, `argos_clinico`, `argos_caja`) con acceso solo a las vistas que su rol ve, y ninguna a las tablas. La consulta corre en una transacción de solo lectura, con la clínica fijada, `SET LOCAL ROLE` a la llave, tope de 3 segundos y de filas. `set_config` deja de ser de todos: así una consulta no puede cambiar de clínica.
- **Un revisor antes de correrla** (defensa adicional): una sola sentencia de lectura, solo vistas `argos` o nombres de su `WITH`, solo funciones de una lista.
- **El modelo nunca ve los datos.** ChatGPT 6 recibe la pregunta y la descripción de las vistas y devuelve la consulta, una frase con huecos y «Así lo calculé». odentIA llena los huecos con el resultado: nombres y cifras no viajan al proveedor y ningún número lo escribe el modelo. Jev decide antes, con solo el texto, si la pregunta es del negocio, de cómo se usa (Ayuda) o de otra cosa. Si la base rechaza la consulta, el modelo la corrige una vez con el error, que no trae datos.
- **Las vistas van enteras, no las elige Jev.** El modelo que escribe recibe todas las vistas que lee el rol de quien pregunta (`argos-catalog.ts`), con las reglas de las cifras de Reportes. Es la parte fija del mensaje, que la caché del proveedor cobra a la décima parte; si Jev eligiera las vistas, el prefijo cambiaría en cada pregunta (más caro) y una vista olvidada dejaría la pregunta sin respuesta. El lienzo decía «Jev elige los datos»: se cambió por esto.
- **La frase dice qué calculó, en pocas palabras.** El periodo o la comparación con sus nombres («del 1 al 20 de octubre, frente a los mismos días de septiembre») y, si la pregunta se puede entender de dos formas, qué contó («que llevaban más de 6 meses sin venir»); solo cuando cambia la cifra. El detalle queda en «Así lo calculé». Así una lectura equivocada se ve en la misma respuesta.
- **Dos reglas de las respuestas.** Lo que no tiene valor nunca sale primero: el revisor agrega `NULLS LAST` a cada `DESC` que no dice dónde van (sin depender del modelo). «Ticket promedio» es el importe promedio por venta (una fila de `ventas`), no el de los tickets de pago, que juntan lo cobrado en una visita; lo dice la descripción de las vistas que lee el modelo.
- **Cuadre con la pantalla.** Cada cifra de Reportes que una vista puede dar tiene una prueba que compara las dos sobre los mismos datos.

## Alternativas descartadas

- **Seguir con el catálogo cerrado (0070):** 17 de 36; cada pregunta nueva exige programar una cifra.
- **Consultas sobre las tablas:** los números no cuadran y los permisos dependen de la conducta del modelo.
- **Una capa que compila métricas y dimensiones declaradas:** vuelve a ser un catálogo; lo que no está declarado no se pregunta.
- **Que el modelo vea el resultado para redactar:** mandaría nombres de pacientes al proveedor.

## Consecuencias

- El campo de Reportes vuelve con el Argos nuevo (D7): pregunta con el periodo y la sede de arriba, y el panel los deja a la vista con «Quitar» para que no sigan puestos sin saberlo. Las respuestas fijadas de las 32 cifras (0070) siguen en el Resumen; ya no se pregunta con ellas.
- Una tabla o un dato nuevo que Argos deba conocer entra como columna o vista de `argos` en el mismo cambio, con su `GRANT` por rol, su descripción en `argos-catalog.ts` (una prueba compara el catálogo con la base) y, si es una cifra de Reportes, su prueba de cuadre.
- Cada pregunta deja en `report_question` la consulta que corrió y cómo terminó, nunca el texto (D2). Lo que falló por el modelo o la base no cuenta para el tope diario (D6).
- También deja su plan (`report_question.plan`): las frases con huecos, «Así lo calculé», el título y las consultas para seguir. Con eso se fija (se vuelve a correr con la llave de quien mira), se descarga y se sigue sin volver a llamar al modelo; el id solo le sirve a quien preguntó. Se conserva como el resto de `report_question`, sin plazo propio.
- D2 no guarda el texto de la pregunta, pero lo que se escribe para filtrar puede quedar en la consulta o en el título (un nombre: `ilike '%rosa quispe%'`). Queda dentro de la clínica (RLS) y lo fijado lo ve quien ve Reportes; no se intenta quitarlo porque es la consulta misma.
- Prueba rápida del 2026-10-20 (sin llaves por rol ni Jev): 33 de 36 en el examen tras ajustarlo con esas preguntas y 9 de 14 con preguntas de reserva sin ajustar; los fallos fueron vistas que faltaban y dos reglas del modelo. Costo medido: USD 0,0004 a 0,0005 por pregunta. Las 55 preguntas de reserva (`packages/agent/eval/argos-holdout.json`) se usaron para ajustar reglas y columnas, así que ya no sirven de reserva: la medición final usa preguntas nuevas del dueño, cada una dos veces.
- Revisar si una clínica grande hace que una vista pase el tope de tiempo, o si aparece una pregunta frecuente que ninguna vista cubre.

## Referencias

`packages/db/drizzle/0050_argos_vistas_del_negocio.sql`, `packages/services/src/argos-query.ts`, `packages/services/src/argos-catalog.ts`, `packages/services/src/argos-answer.ts`, `packages/services/src/argos-views.test.ts`, `packages/agent/src/argos.ts`, `packages/agent/src/decision/eval-argos.ts`, `packages/agent/eval/argos-holdout.json`, `packages/agent/eval/argos-examen.json`, `packages/agent/src/decision/eval-argos-respuestas.ts`.
