# 0165 · Lo común decide con mapas completos por producto

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0079](0079-un-nucleo-para-varios-productos.md), que pedía revisar al aparecer un tercer producto. Entrega 1 del plan «vistIA: plan para ópticas».

## Problema

Llega un tercer producto (vistIA, para ópticas). Lo común decidía entre odentIA y latidIA con comparaciones como `product === "medical" ? A : B`: 31 en el código que corre, más unos mapas parciales con odentIA de respaldo. Con un tercer producto todo eso compila y cae en silencio en la rama de otro: la marca, el dominio, los enlaces, los correos, las plantillas de WhatsApp, el alta. La base hace lo mismo con vistas y funciones que dicen `CASE … 'medical' … ELSE` y con restricciones `IN ('dental','medical')`.

## Decisión y motivo

- **Mapas completos.** Lo común decide con `Record<ClinicalProduct, …>` (o por marca, `Record<MailBrand, …>` y `Record<BrandId, …>`), nunca con el nombre escrito. Así, al agregar un producto, el compilador señala cada lugar que debe decir algo de él. `packages/clinical/src/product-choices.test.ts` impide volver a comparar a mano, en JavaScript, en drizzle o en SQL escrito en el código, y toma los nombres de la lista de productos: el nuevo queda vigilado solo.
- **El producto base tiene nombre.** `BASE_PRODUCT` (odentIA) es el de lo que no dice su producto y el de la plataforma, cuyo dominio es `COOKIE_DOMAIN`; `BASE_MAIL_BRAND`, el remitente de siempre. Lo que es del producto base se compara con ellos.
- **Los dominios de los demás, completos.** `ProductDomains` exige el dominio de cada producto con dominio propio (o `undefined`, que lo deja en el de la plataforma). Lo mismo los mapas de los `host.ts`; el pie de los correos sale del mismo mapa (`mailBrandDomains`).
- **La base nombra a todos.** `packages/db/src/product-sql.test.ts` revisa en una base migrada cada vista, función, restricción, política, disparador, índice, columna calculada y tarea programada: si nombra un producto, nombra a todos o declara por qué no (`UNNAMED_ON_PURPOSE`). Hoy declara cuatro, con su motivo.
- **La web se detiene.** La web de marketing se arma aparte por producto: uno que no conoce detiene el armado (`astro.config.mjs`) en vez de publicar la de odentIA. Dentro de la web, el booleano `MEDICAL` quedó en mapas por producto al sumar la de vistIA (ADR 0166).

## Alternativas descartadas

- **Pasar `saas_signup_policy` a una fila por producto.** Es más limpio, pero pide migrar datos y no se puede borrar la columna en el mismo despliegue. Un mapa de columnas por producto ya obliga a decidir la del nuevo; la tabla se revisa si los productos siguen creciendo.
- **Una variable de entorno con todos los dominios.** Cambiaría la configuración de producción sin ganancia: cada producto sigue con la suya (`MEDICAL_DOMAIN`) y se juntan en un mapa en un solo lugar.
- **Llevar cada diferencia a los ganchos del producto (`productHooks`).** Es lo ideal para lo grande, pero mover cada palabra suelta a las carpetas de producto agranda el cambio sin proteger más que un mapa completo.

## Consecuencias

- Agregar un producto marca, en el compilador y en las dos pruebas, la lista de lo que hay que decidir.
- Los mapas con respaldo (`{ dental: {}, medical: … }`) dicen a la vista qué producto usa lo de siempre.
- Las pruebas, las stories y las mediciones siguen nombrando productos: eligen la clínica de la semilla de cada uno.

## Referencias

`packages/clinical/src/products.ts`, `product-choices.test.ts`; `packages/db/src/product-sql.test.ts`; `packages/services/src/public-links.ts`; `packages/mail/src/layout.ts`; `apps/api/src/index.ts`; `apps/web/astro.config.mjs` y `src/lib/product.ts`.
