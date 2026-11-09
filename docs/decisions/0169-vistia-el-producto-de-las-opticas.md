# 0169 · vistIA, el producto de las ópticas

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0079](0079-un-nucleo-para-varios-productos.md), [0087](0087-dos-dominios-y-el-producto-de-la-clinica.md), [0093](0093-una-lista-de-precios-por-producto.md) y [0168](0168-lo-comun-decide-con-mapas-por-producto.md). Entrega 2 del plan «vistIA: plan para ópticas».

## Problema

Una óptica vende lentes y, casi siempre, examina la vista antes de venderlos. Sobre el mismo núcleo que odentIA y latidIA ya tiene agenda, conversaciones, fichas con su historia clínica única, caja, inventario y reportes. Lo que no le sirve tal cual: las palabras (clínica, odontólogo, unidad dental), la marca, el dominio, la biblioteca de servicios, el dictado de Clío y el presupuesto clínico como forma de cotizar.

## Decisión y motivo

- **Un tercer producto, `optical`, con marca `vistia`** y su dominio, `vistia20.com` («20/20»; `OPTICAL_DOMAIN`, `VITE_OPTICAL_DOMAIN`, `OPTICAL_SMTP_FROM`), como latidIA en el suyo. Su paquete puro es `@odentia/optical`, su app `apps/optical-clinic` y lo suyo de los servicios y de la base vive en sus carpetas `optical/`. Se conecta con lo común solo por los `products.ts` y `productUi()`, y su prueba de límites lo exige.
- **Sus palabras:** el lugar es «óptica», quien atiende «optómetra» (el rol `clinician`) y lo que se reserva una «sala de examen». En Perú el perfil profesional propone «Tecnólogo médico en optometría» y el CTMP.
- **Su biblioteca** (`seeds/biblioteca_optica*.csv`): el examen y el control de la vista, los lentes de contacto, la adaptación y la reparación de anteojos, las pruebas especiales y la terapia visual, con su código de la CPMS del Perú, la CUPS de Colombia y la CIE-9-MC de México. Las monturas, las lunas y los lentes no son servicios: son productos del inventario.
- **Lo que hace en la atención:** lo indicado queda aceptado al indicarlo, como en latidIA, porque la óptica cotiza con el pedido y no con el presupuesto clínico; invita a volver al año, al control anual de la vista, con su propia plantilla de WhatsApp; no pregunta la ASA; el buscador de diagnósticos pone primero los del ojo (CIE-10 H00–H59, CIE-11 9A–9E); sus imágenes son las pruebas del ojo, sin visor de cortes.
- **Clío no dicta en vistIA.** Un signo o un eje de la refracción mal oídos son lentes mal hechos; el examen se escribe.
- **Su alta, su lista y su demo:** una columna propia en `saas_signup_policy` (`optical_mode`), sus planes (empiezan con los precios de latidIA), sus tipos de demo y la vista de Argos que dice «optometría» y cuenta como pago lo que pagó, sin presupuesto.
- **Su color, verde `#147c3b`**, lejos del turquesa de odentIA y del morado de latidIA. Es el verde legible más cercano al `#15803d` de los sugeridos: el de fábrica tiene que quedar exacto como texto sobre las superficies grises.

## Alternativas descartadas

- **Una variante de latidIA.** Las palabras, la marca, la web y el recorrido de una venta de lentes son otros; mezclarlos obligaría a decidir dentro de latidIA lo que el núcleo ya separa por producto.
- **Cotizar con el presupuesto clínico.** Está atado al plan de tratamiento; la cotización de una óptica es el pedido en borrador (entrega 4).
- **Dictar la refracción a Clío.** El riesgo de un error que llega al lente es mayor que el tiempo que ahorra.

## Consecuencias

- El examen de la vista y la receta de lentes, la venta con pedido al taller, el aviso «tus lentes están listos» y la venta de mostrador llegan en sus propias entregas. Hasta entonces una óptica escribe el examen en la nota y cobra como cualquier clínica.
- Los textos que lee el modelo en vistIA (`optical/agent-texts.ts`) se miden antes de abrir ópticas reales.
- Revisar si una óptica real cobra el examen aparte o lo descuenta de los lentes, y cómo pone precio a las lunas.

## Referencias

`packages/clinical/src/products.ts`, `packages/optical/`, `packages/services/src/optical/`, `packages/db/src/optical/library.ts`, `packages/db/drizzle/0077_vistia_opticas.sql`, `apps/optical-clinic/`, `docs/deployment.md` («vistIA en su dominio»).
