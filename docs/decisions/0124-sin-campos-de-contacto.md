# 0124 · Sin campos de contacto

Fecha: 2026-10-31 · Estado: aceptada

## Problema

«Campos de contacto» dejaba a cada clínica definir datos propios de sus contactos. Eran solo una anotación en la ficha: no se buscaban ni se filtraban, no salían en Reportes ni en Argos, ninguna automatización ni mensaje los usaba, y no se preguntaban en el registro ni en la carga de pacientes.

Además llevaban a duplicar datos: la pantalla sugería «cómo nos conoció» y la demo creaba DNI, fecha de nacimiento y aseguradora, que la ficha ya tiene. Lo guardado ahí no contaba en Reportes. Sofi tampoco sabía qué campos existían, y al guardar uno reemplazaba todos los demás.

En producción, al decidirlo, ninguna clínica había definido un campo ni guardado un valor.

## Decisión y motivo

Se quita todo: la pantalla, su lugar en la ficha, la API, lo que Sofi leía y escribía, la tabla `custom_field_def` y la columna `contact.custom_fields`.

Una capacidad entra por el valor que aporta, no porque otros CRM la tengan. Esta no aportaba más que una nota, y sumaba una segunda forma de guardar lo que ya tiene un lugar.

Va en dos entregas: primero el código y, ya desplegado, la tabla y la columna. `migrate` corre con sus semillas antes de que suban la API y el worker nuevos, y la versión en marcha pide todas las columnas de `contact`. Borrar todo a la vez la dejaría fallando durante ese tiempo, más aún si una semilla falla, y sin poder volver a la imagen anterior.

## Alternativas descartadas

- *Arreglarlos y conectarlos con búsqueda, filtros, Sofi y registro*: mucha complejidad para algo que nadie usó.
- *Quitar solo la pantalla y dejar la tabla y la columna*: quedaría código y esquema sin uso.

## Consecuencias

- Lo suelto de una persona va en etiquetas o notas; lo práctico que dijo, en lo que Sofi recuerda.
- Un dato que muchas clínicas pidan, como la sede preferida, se agrega como dato real, con lo que hace.
- Se revisa si varias clínicas piden guardar datos que ninguno de esos lugares resuelve.

## Referencias

`compose.prod.yaml` (`migrate`); las migraciones `sin_campos_de_contacto` y `sin_campos_de_contacto_reglas` (borrar los datos de una persona, [0080](0080-pedidos-sobre-sus-datos-y-copia-de-la-historia.md), ya no toca esa columna).
