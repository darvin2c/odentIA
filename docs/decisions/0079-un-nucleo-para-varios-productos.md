# 0079 · Un núcleo para varios productos: lo dental, aparte

Fecha: 2026-10-22 · Estado: aceptada · Modifica [0064](0064-cada-tabla-en-el-esquema-de-su-dueno.md): un producto tiene su esquema. Plan en la página «odentIA multiproducto», aprobado el 2026-10-22.

## Problema

odentIA quiere una segunda app, para cualquier consultorio médico, con el mismo admin, la misma base y el mismo motor: pacientes, agenda, atención, plan, presupuesto, cobros, conversaciones y agente. Hoy el núcleo es dental en todas sus capas:

- **Tablas comunes con columnas dentales.** Pieza, caras, cuadrante y arcada están en procedimientos, diagnósticos, plan, presupuesto, notas, documentos y mediciones.
- **Conceptos comunes con nombres dentales.** `dentist_user_id`, `schedule_chair` y el rol `dentist` nombran al profesional, a la sala y al rol clínico.
- **Lo dental metido en el perfil de país.** Especialidades y tipos de tratamiento viven ahí.
- **Prompts que se presentan como «una clínica dental».**

Copiar el núcleo duplicaría cada arreglo. Mezclar los dos productos haría que un cambio médico pudiera romper odentIA.

## Decisión y motivo

- **Cada clínica tiene un producto** (`dental` o `medical`). Lo común le pregunta al perfil del producto, igual que hoy le pregunta al perfil del país (0036): tipos de tratamiento, especialidades por país, sistemas de sitio, vocabulario, tipos de imagen, fases del plan y capítulos de diagnóstico preferidos. Las clínicas existentes son dentales.
- **El esquema dice también el producto.** `public` guarda lo que pertenece a una clínica y comparten todos los productos. Lo que solo usa un producto va en su esquema: `dental` para el odontograma, el periodontograma y sus enlaces. Lo global de solo lectura sigue en `catalog`, aunque sea de un producto. Los nombres siguen sin repetirse entre esquemas y el `search_path` incluye `dental`. El esquema no protege por sí solo, porque las dos apps usan la misma API y el mismo rol: protegen el código separado (`packages/dental`) y las pruebas de límites. Lo que gana es la vista: qué es de un producto se ve de un vistazo, y queda aislado si un día ese producto va en su propia base.
- **El dónde es un sitio estándar.** Las tablas comunes guardan sistema, código y calificadores, como `bodySite` en FHIR. Odontología usa ISO 3950 para piezas y áreas, con las caras como calificadores. Qué códigos valen lo valida el producto, no la base.
- **Lo común se nombra en neutro.** El profesional que atiende es `professional_user_id`, el recurso reservable de la sede es `room` (`schedule_room`, `room_id`) y el rol clínico es `clinician`. Lo que ve el usuario lo pone el producto: «Odontólogo» y «Unidad dental» en odentIA, «Médico» y «Consultorio» en la app médica.
- **Los agentes, por producto.** Sofi y Argos tienen una parte común y un bloque de su producto (alcance, urgencias, ejemplos). Clío dicta con un prompt, un formato y un extractor propios de cada producto.
- **Las listas oficiales, completas.** Cada lista de procedimientos se carga entera, con la sección donde el publicador pone cada código (`procedure_code.section`). Cada producto dice sus códigos (`catalog.procedure_code_product`), y el buscador del código de un servicio propio ofrece solo los del producto de la clínica. No basta filtrar por sección: en la CUPS y en la CIE-9-MC lo odontológico está repartido en muchos capítulos.
- **Una app y un paquete de dominio por producto.** `apps/dental-clinic` es la app de la clínica dental (antes `apps/platform`; en producción el servicio sigue llamándose `platform`) y la médica será `apps/medical-clinic`. Su dominio puro va en `packages/dental` y `packages/medical`. Lo compartido (`admin`, `api`, `worker`, `panel` y los demás paquetes) no cambia de nombre.
- **Entregas verticales.** Cada concepto pasa entero (base, código, pantallas y pruebas) en su propio PR, con la CI en verde. En odentIA no cambia nada de lo que se ve.

## Alternativas descartadas

- **Copiar el núcleo para la app médica:** cada arreglo se haría dos veces, y los dos productos se separarían sin que nadie lo decida.
- **Lo dental en `public`, como pedía 0064:** es más barato, pero lo de un producto queda mezclado con lo compartido. Se eligió el esquema propio por visibilidad y por poder separarlo después.
- **Tablas de extensión por cada tabla común (pieza aparte):** el sitio viaja del plan al presupuesto y a la atención, así que cada copia serían dos escrituras con sus propias guardas. El sitio estándar cubre los dos productos con las mismas columnas.
- **Un prompt completo por producto para cada agente:** las mejoras comunes habría que copiarlas a mano.

## Consecuencias

- Hay que mantener la lista de lo que es de un producto. Una prueba falla si lo común importa `packages/dental` o si una tabla común recibe una columna de producto.
- El SQL a mano sigue nombrando tablas sin esquema. Una función que fija su `search_path` tiene que incluir `dental`.
- Revisar si aparece un tercer producto, o si una tabla de un producto empieza a servir a otro: entonces pasa a `public`.

## Referencias

Plan y entregas: página «odentIA multiproducto». `packages/db/src/schema/schemas.ts`, `packages/clinical/src/country-profiles.ts`, `packages/auth/src/permissions.ts`; ISO 3950:2016; HL7 FHIR Dental Data Exchange (`bodySite` con superficie).
