# 0240 · En gestorIA, Argos perfila a cada clienta y decide sus campañas; Sofi escribe y vende

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «Clientas bien perfiladas y Argos que hace el
marketing solo» (decisiones 1 a 14 y sus reglas firmes)

## Problema

La ficha de la clienta solo tenía su nombre, su teléfono, «Lo que sabemos» y sus pedidos. Para
venderle de nuevo, la tienda tenía que recordar su talla, su distrito y qué compra, y escribirle a
mano. Un CRM de los que se estudiaron (Klaviyo, Shopify, Kommo, respond.io, Mailchimp) le pide a la
tienda llenar campos, armar segmentos y programar campañas: trabajo que una tienda chica no hace.
Escribirle primero por WhatsApp cuesta (Meta cobra cada promoción entregada) y exige su permiso.

## Decisión y motivo

- **Argos perfila solo.** Anota la medida (talla o tono), el distrito, el cumpleaños (día y mes,
  ISO 8601 sin año), el canal, el Instagram y lo que le gusta, de sus pedidos y de lo que ella dijo.
  Cada dato es una fila con su fuente (chat, pedido, cómo responde o la tienda), su cita y su hora:
  el historial son esas filas (`customer_fact`), nada se edita. Lo que corrige una persona queda
  «Lo puso la tienda» y la base le niega a Argos volver a escribirlo. Lo dudoso se usa igual y queda
  «Por confirmar»: no frena nada.
- **Argos usa el modelo solo para leer**, y sin inventar: cada dato de un chat o de una dirección
  trae la cita tal cual, y el código comprueba que está en el mensaje de ella y que el valor existe
  (la talla en el catálogo, la fecha en el calendario). Lo que no pasa, se descarta. Las cifras,
  los grupos y la elección de cada campaña siguen siendo cuentas fijas.
- **El permiso es de ella.** Sofi lo pide en la primera compra y anota la baja cuando ella la pide;
  cada fila (`customer_consent`) sale de un mensaje de ella, con su cita, y solo la escribe Sofi.
  Una persona no dice por ella que sí. A quien no aceptó o pidió la baja nunca se le escribe una
  promoción.

## Alternativas descartadas

- **Que Sofi proponga cada dato y una persona lo acepte** (como `customer_proposal` del primer
  borrador del lienzo): es el CRM pasivo que se quiere dejar atrás. El dueño eligió que Argos lo haga
  solo y que la tienda solo corrija.
- **Columnas por rubro** (talla de calzado, de ropa, tono): una clave «medida» con la etiqueta de la
  primera opción del catálogo sirve a todos los rubros sin migraciones.
- **Unir fichas por el teléfono**: sigue prohibido (ADR 0223). Argos solo lo sugiere.

## Consecuencias

- La ficha dice quién es la clienta sin que nadie llene nada, y cada dato se puede explicar.
- Leer los chats cuesta tokens del modelo: se lee una vez cada mensaje (`argos_reading`), solo de
  conversaciones con una clienta y sin la conversación a medias.
- Revisar si el modelo inventa más de lo que la comprobación de la cita detecta (el banco de Argos lo
  mide).

## Referencias

`gestoria/packages/db/drizzle/0050_el_perfil_de_la_clienta.sql` y su migración de reglas;
`gestoria/apps/api/src/perfil.ts`, `sofi/perfilar.ts` y las herramientas `anotar_permiso` y
`anotar_baja` de `sofi/herramientas.ts`.
