# Ventas: lo que hace vender y lo que hace perder la venta

Catálogo de la voz comercial. Cada entrada es un tramo del camino a la venta, con dónde vive, lo que debe cumplir y un caso para recorrerlo. Es el piso, no el techo: se revisan las entradas que el área toca, comprobación por comprobación, y además la voz arma sus casos y hace sus giras (`mesa.md`).
Crece con lo que cada recorrido devuelve en «Para mi catálogo» y con lo que se escapó. También se poda: lo que ya no existe se quita y lo repetido se une.
Se escribe leyendo el código y la pantalla: lo que dice «Dónde» existe. Los casos son ficticios; si la demo no los trae, se crean.
Rutas: `W` = `apps/web/src/`, `G` = `gestoria/apps/`, `R` = `packages/clinic-app/src/routes/`, `CA` = `packages/clinic-app/src/components/`. Códigos: `WEB` la web, `GES` gestorIA, `CLI` lo que vende en las clínicas.

---

## En toda venta

- [ ] Lo que se ofrece se entiende en una frase, con las palabras del cliente, sin explicarlo.
- [ ] Siempre hay un paso siguiente a la vista, y uno solo como el principal.
- [ ] El precio se ve o se dice sin que el cliente tenga que preguntarlo dos veces.
- [ ] Ninguna promesa sin el servicio que la cumple (se cruza con el auditor).
- [ ] Se vende con valor y con lo que hacemos bien: ni miedo, ni lo legal, ni competidores con nombre.

## La web

### CO-WEB-01 Llegar desde Google
**Dónde:** `W/layouts/Base.astro` (título, descripción, canónico y `application/ld+json`), el mapa del sitio (`@astrojs/sitemap` en `apps/web/astro.config.*`), `W/pages/robots.txt.ts`, los textos de `W/lib/arm.ts` y `W/lib/pages-data.ts`, y `W/pages/comparar/`.
- [ ] Cada página dice qué búsqueda quiere ganar, y su título y su H1 la contienen con las palabras del cliente.
- [ ] Un solo H1; la descripción vende en una frase y no se corta en el resultado de Google.
- [ ] El canónico apunta a sí misma y los datos estructurados describen lo que la página es.
- [ ] Está en el mapa del sitio y al menos otra página la enlaza.
**Caso:** la dueña de una clínica en Arequipa busca «software para clínica dental con WhatsApp» desde el celular: ¿qué página de odentIA debería salir, y qué ve al entrar?

### CO-WEB-02 Entender en cinco segundos
**Dónde:** la portada (`W/pages/index.astro`) y las páginas de cada función (`W/pages/*.astro`), con sus textos en `W/lib/arm.ts`, `W/lib/value.ts` y `W/lib/offer.ts`.
- [ ] A 390 px, sin desplazarse, se lee qué es, para quién y el paso siguiente.
- [ ] Le habla al dolor de la clínica antes que a la sigla ARM.
- [ ] Ninguna palabra de adentro (nombres de pantallas, de agentes sin explicar, siglas) antes de decir qué hace.
**Caso:** el dueño de un consultorio pediátrico abre latidIA desde un anuncio: en cinco segundos, ¿podría decir con sus palabras qué le resuelve?

### CO-WEB-03 Cada promesa con su servicio
**Dónde:** `W/lib/arm.ts`, `W/lib/value.ts`, `W/lib/offer.ts`, `W/lib/faq.ts`, `W/lib/pricing.ts` y `W/pages/comparar/`.
- [ ] Cada frase que promete algo («recuerda», «cobra», «responde solo») tiene en el producto lo que la cumple, dicho igual.
- [ ] Lo que el producto hace a medias se dice a medias, con justicia («A medias» en las comparaciones).
- [ ] Los precios y lo incluido son los de los planes vigentes, con su moneda.
**Ya falló:** la revisión de la marca ARM tumbó cuatro promesas que el producto no cumplía así: «cambio en los cobros», «lo que no da resultado no se cobra», «tú decides qué hace cada agente» y «recuerda cada cita».

### CO-WEB-04 Del interés a la cuenta
**Dónde:** la llamada a la acción `ctaOf` en `W/lib/site.ts` (con invitación, a `W/pages/solicitar-invitacion.astro` y la lista de espera; con el alta abierta, al registro del panel), el registro y la primera vez en el panel (`apps/panel/src/routes/register.tsx`, `verify-email-sent.tsx`, `onboarding.tsx`) y el WhatsApp de ventas (`salesWhatsAppHref` en `W/lib/site.ts`).
**Medida:** pasos, campos y pantallas desde la portada hasta la primera pantalla de la clínica.
- [ ] La llamada a la acción dice lo mismo y lleva al mismo lugar en toda la web.
- [ ] Ningún campo que no haga falta para empezar.
- [ ] Al enviar, dice qué pasa ahora y cuándo («te escribimos hoy», «revisa tu correo»).
- [ ] El WhatsApp de ventas abre con el mensaje que nombra la app.
- [ ] En producción ningún formulario se envía desde la ronda: llegan de verdad. Se prueban en local.
**Caso:** la dueña de una clínica pide su invitación desde el celular a las 22:00 y al día siguiente quiere saber en qué va.

### CO-WEB-05 Las dudas antes de comprar
**Dónde:** `W/pages/precios.astro`, `W/lib/faq.ts`, `W/pages/comparar/whatsapp-y-cuaderno.astro` y la carga de sus pacientes (la carta de bienvenida, `packages/services/src/clinic-import-letter.ts`).
- [ ] «¿Cuánto cuesta?», «¿cómo paso mis pacientes?», «¿mi equipo va a aprender?», «ya uso WhatsApp y un cuaderno» y «¿y si no me sirve?» se contestan donde aparecen, con un ejemplo, sin ir a buscar.
- [ ] El precio se ve con su moneda y con lo que incluye, sin pedir una llamada.
**Caso:** un odontólogo con 600 pacientes en Excel quiere saber si tiene que escribirlos de nuevo.

### CO-WEB-06 Rápida en el celular
**Dónde:** Lighthouse móvil sobre cada página del área. Ver también `M-WEB-03` en `medidas.md` (lo largo de cada página).
- [ ] LCP hasta 2,5 s, INP hasta 200 ms y CLS hasta 0,1 (los umbrales de «bueno» de Core Web Vitals).
- [ ] Lo que se mueve o pesa (escenas, videos) no tapa ni retrasa el primer mensaje.

## gestorIA

### CO-GES-01 Subir lo que vende
**Dónde:** el catálogo (`G/web/src/catalogo.tsx`, `G/web/src/producto.tsx`), `G/api/src/catalogo.ts`, la hoja CSV (`G/api/src/hoja.ts`) y el stock por kardex (`G/api/src/stock.ts`).
**Medida:** toques en el celular para subir un producto con dos opciones (talla y color), su foto, su precio, su mínimo y su stock.
- [ ] Lo que verá el cliente (nombre, foto, precio y opciones) se entiende antes de guardar.
- [ ] El mínimo se explica con el margen de ese producto, y el aviso del costo no frena.
- [ ] Cincuenta productos entran por la hoja sin escribirlos uno por uno.
**Caso:** Rosa sube unas zapatillas blancas en tallas 36 a 40, a S/ 129 con mínimo S/ 100, con 3 pares por talla.

### CO-GES-02 Sofi vende
**Dónde:** «Probar a Sofi» (`G/web/src/sofi.tsx`), `G/api/src/sofi/` (`sofi.ts`, `herramientas.ts`, `revisar.ts`), el precio (`G/api/src/precio.ts`) y las operaciones de `G/api/src/pedidos.ts`. Su medición: `G/api/eval/sofi.json`.
- [ ] Siempre da un número cuando le piden el precio.
- [ ] Cede de a poco, nunca baja del mínimo y los descuentos no se suman entre sí.
- [ ] Sin la talla pedida, ofrece lo parecido o avisa cuando vuelva; ofrece sumar algo al mismo envío.
- [ ] Pide solo lo que hace falta para entregar y cobra en el orden de la tienda: link, captura, al recibir.
- [ ] Nunca da por pagado un pedido por una captura: eso lo confirma una persona.
**Caso:** «¿cuánto las blancas?», «¿me las dejas en 100?», «¿hay en 41?», «quiero dos pares», «¿llega hoy a Surco?» y «ya te yapeé» con una captura.

### CO-GES-03 Del chat al pedido
**Dónde:** Pedidos (`G/web/src/pedidos.tsx`, «Anotar un pedido» y la lista por estado) y `createOrderIn` en `G/api/src/pedidos.ts`.
**Medida:** toques a 390 px para anotar un pedido que llegó por chat, con envío y descuento.
- [ ] El total, el envío y lo cedido se ven antes de confirmar, y lo cedido queda escrito.
- [ ] Se sabe qué sale hoy y a quién, sin abrir cada pedido.

### CO-GES-04 Cobrar sin perder la venta
**Dónde:** medios de pago (`G/web/src/pagos.tsx`), el link de pago (`G/web/src/link-de-pago.tsx`, `G/api/src/link-de-pago.ts`) y la captura con «Confirmar pago» y «No coincide» (`G/web/src/pedidos.tsx`).
- [ ] El cliente recibe el link sin un paso de más.
- [ ] Confirmar un Yape toma dos toques y deja quién lo confirmó.
- [ ] «No coincide» pide el motivo y deja claro qué decirle al cliente.

### CO-GES-05 Que vuelva a comprar
**Dónde:** los seguimientos de Argos (`G/api/src/sofi/argos.ts`: recordar el pago, el gracias con «¿Te llegó bien?», avisar que volvió una talla e invitar a volver) y Reportes con «Te toca» (`G/web/src/reportes.tsx`).
- [ ] Cada seguimiento sale a tiempo, una vez por motivo y pedido, y suena a la tienda.
- [ ] El dueño puede apagar cada uno.
- [ ] «Te toca» dice qué hacer hoy para vender más, no solo lo que pasó.

## Lo que vende en las clínicas

### CO-CLI-01 El presupuesto que se acepta
**Dónde:** «Revisar y enviar» del Plan (`CA/patient/plan/budget-review.tsx`, `CA/patient/plan/plan-budgets.tsx`), lo que recibe el paciente y responde (`R/public/portal.tsx`, `R/public/pendientes.tsx`) y Oportunidades (`R/_org/pipeline.tsx`, `R/_org/opportunities.$opportunityId.tsx`).
- [ ] El paciente entiende el precio, las opciones y hasta cuándo vale, y puede decir que sí desde su celular.
- [ ] Presentar y responder el presupuesto mueve la oportunidad sola, sin escribir nada.
- [ ] El presupuesto que nadie envió o nadie respondió aparece como tarea, con quién la tiene.
**Caso:** a Marta le presentan dos caminos para la 36 (endodoncia y corona por S/ 1 450, o extracción e implante por S/ 3 200). Lo piensa una semana y responde desde el enlace.

### CO-CLI-02 Quien preguntó y no reservó
**Dónde:** la Bandeja (`R/_org/inbox.tsx`), lo que Sofi dice para reservar y la columna «Interesado» de Oportunidades.
- [ ] Un interés concreto (un precio, un tratamiento) queda como oportunidad sin que nadie lo escriba.
- [ ] Sofi propone una hora y reserva, en vez de quedarse en la información.
- [ ] Quien preguntó el precio y se fue tiene a alguien que le vuelve a escribir, y se sabe cuándo.
**Caso:** el lunes alguien pregunta cuánto cuesta un blanqueamiento, recibe el precio y no contesta más.
