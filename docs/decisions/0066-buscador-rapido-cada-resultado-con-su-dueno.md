# 0066 · Buscador rápido: casi todo, sin tildes y cada resultado debajo de su dueño

Fecha: 2026-10-19 · Estado: aceptada · Complementa [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md). Lienzo «Buscador rápido odentIA», aprobado entero el 2026-10-19 (12 decisiones).

## Problema

Cada pantalla tenía su propio buscador y ninguno buscaba en las demás. Para encontrar a Lucía había que decidir antes en qué menú estaba. Además buscaban letra por letra: «lucia» no encontraba a «Lucía». La clínica ya usaba vectores, pero solo para que el agente encontrara servicios y respuestas.

## Decisión y motivo

- **Una ventana desde cualquier pantalla.** Ctrl/⌘+K o «Buscar en todo», la primera utilidad de la cabecera. Va en gris, no con el color de la acción principal; en el teléfono es la lupa. Se abre al centro, porque buscar es un salto y no un trabajo al costado como el agente, y en el teléfono ocupa la pantalla entera.
- **Por letras y sin tildes, en todas partes.** `search_fold` (unaccent + minúsculas) y `search_digits`, con índices de trigramas, aceptan cualquier pedazo de palabra («profilax»). Las búsquedas que ya tenía cada pantalla pasan a usarlos.
- **Casi todo.** Personas, citas, conversaciones y lo que dicen los mensajes, historia clínica, documentos, presupuestos, comprobantes, gastos, comisiones, tareas, oportunidades, servicios y promociones, inventario, compras y proveedores, equipo y sedes, y respuestas del agente. Cada tipo pide el permiso de su pantalla, y lo decide el servidor (`searchEverything`).
- **Cada resultado debajo de su dueño.** El dueño es la persona o la cosa (un servicio, un proveedor, un profesional), y sus cosas aparecen debajo, ya abiertas. Enter lleva directo a la elegida. Así se ve de quién es sin abrir nada, y seis Marías no se mezclan.
- **Lo clínico, con traza.** Solo lo ve quien tiene `clinical.read`, se muestra una sola línea, y cada lectura queda en el registro de accesos como si se abriera la ficha.
- **Significado solo para servicios, promociones y respuestas.** Se usan los vectores que ya existen (0021). Compararlos en Postgres no cuesta nada; solo se paga convertir la frase escrita, que se recuerda unos minutos. Primero se busca por letras, y la frase va al proveedor solo si no trajo a ninguna persona ni nada de la historia: un nombre o un texto clínico nunca sale. Se espera como mucho 0,8 s y, si no llega, quedan los resultados por letras.
- **Filtro por tipo y lo reciente, en el navegador.** Son preferencias de cada persona del equipo en cada clínica, no datos de la clínica; lo reciente guarda solo el nombre.
- **Cada resultado con las reglas de su pantalla.** El odontólogo ve solo los presupuestos que preparó o indicó; lo que el rol no puede abrir se lee pero no se ofrece abrir, y una respuesta del agente se copia.

## Alternativas descartadas

- **Vectores para personas y notas:** un vector cree que «Lucía» y «Lucas» se parecen, un documento no significa nada, y además mandaría nombres a un proveedor externo.
- **Panel lateral como el del agente:** angosta la pantalla para un salto de segundos y compite con el agente por la columna.
- **Agrupar por tipo** (Personas, Citas, Mensajes…): mezcla a varias personas y obliga a adivinar de quién es cada cosa.
- **Árbol con la persona al centro:** obliga a elegir a la persona antes de ver qué tiene. No cabe en el teléfono y con teclado cuesta recorrerlo.

## Consecuencias

- Beneficio: una sola búsqueda para toda la aplicación, y la misma regla de permisos que cada pantalla.
- Sacrificio: tres índices de trigramas más. Además, un tipo nuevo de la clínica tiene que sumar su consulta a `searchEverything`.
- El texto dentro de PDF e imágenes no se busca, porque haría falta reconocerlo (OCR). Tampoco entran las piezas del odontograma, la auditoría ni el spam.
- Hoy ningún agente del equipo tiene herramienta de búsqueda. Cuando la tenga, usará `searchEverything` con los permisos de quien pregunta. «Preguntarle al agente» abre Ayuda con la pregunta.
- Revisar si una clínica grande pasa de unos cientos de milisegundos por búsqueda, o si aparece un tipo que convenga buscar por significado.

## Referencias

`packages/services/src/global-search.ts`, `packages/services/src/search-text.ts`, `packages/db/drizzle/0035_buscador_sin_tildes.sql`, `apps/api/src/routes/search.ts`, `apps/dental-clinic/src/components/global-search.tsx`.
