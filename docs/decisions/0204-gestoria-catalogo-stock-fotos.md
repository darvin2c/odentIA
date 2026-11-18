# 0204 · gestorIA: el stock solo cambia con el kardex, las fotos en su base y la hoja en CSV

Fecha: 2026-11-18 · Estado: aceptada · Paso B3 del lienzo B (gestorIA)

## Problema

B3 arma la tienda: medios de pago, formas de entrega y el catálogo con variantes, stock y kardex
(decisiones 1, 3 y 10 del lienzo B). Tres cosas tienen alternativas reales y son caras de cambiar
después: cómo se garantiza que el stock y su kardex nunca se separen, dónde viven las fotos del
catálogo y en qué formato se sube una hoja.

## Decisión y motivo

- **El stock lo escribe la base, nunca la aplicación.** Cada variante tiene su stock, pero
  `gestoria_app` no puede escribirlo: nace en 0 (regla de RLS) y no tiene permiso de cambiarlo.
  Solo cambia al agregar un movimiento al kardex (`stock_movement`), con un disparador del dueño
  de la base que suma la cantidad, anota el saldo y rechaza que quede bajo cero. El kardex solo
  se agrega, a nombre de quien pide y con la hora de la base. Así el saldo siempre es la suma del
  kardex, también cuando B4 descuente ventas o Sofi venda en B5. Como el disparador corre antes de
  insertar, nunca se usa `on conflict do nothing` con un movimiento: lo repetido se mira antes y,
  si dos llegan a la vez, el índice único de cada pedido deshace uno.
- **Las fotos del catálogo van en la base de gestorIA** (`product_photo`, hasta 8 por producto y
  1,5 MB cada una, ya achicadas en la pantalla). Se sirven con la sesión, como cualquier dato de
  la tienda, y su tipo se lee de sus primeros bytes (JPEG, PNG o WebP; nunca SVG). gestorIA no
  tiene almacenamiento de archivos propio todavía y el catálogo de una tienda chica pesa poco: una
  base más simple de respaldar y de aislar por tienda que un bucket compartido con las clínicas.
- **La hoja se sube como CSV**, con la hoja de ejemplo de la API (punto y coma y BOM, para que
  Excel en español la abra en columnas). Excel, Google Sheets y LibreOffice la guardan así; leer
  XLSX pediría otra biblioteca que abre archivos binarios ajenos en el servidor. Se lee en el
  servidor, primero se muestra lo que se va a crear y cada error con su fila, y con un error no se
  guarda nada. Solo crea productos nuevos.

## Alternativas descartadas

- El stock como columna que escribe la aplicación junto al movimiento: un error de código o una
  ruta nueva puede cambiar uno sin el otro.
- Calcular el stock sumando el kardex en cada lectura: más lento y sin un saldo por movimiento.
- Las fotos en el S3 de las clínicas: rompe la separación de ADR 0203. Un S3 propio de gestorIA:
  más piezas que configurar antes de tener tiendas.
- XLSX directo: más cómodo para quien no sabe guardar como CSV, a cambio de otra dependencia y más
  superficie de ataque.

## Consecuencias

- Mover stock exige un movimiento con su tipo; un ajuste a mano pide motivo escrito.
- La base crece con las fotos. Revisar cuando Sofi tenga que enviar fotos por WhatsApp (B2 y B5:
  Meta las pide por una dirección pública) o cuando el respaldo de `gestoria` pese demasiado:
  entonces, un almacenamiento propio de gestorIA.
- Si las tiendas piden subir XLSX, se suma como otra entrada que termina en el mismo plan.

## Referencias

- `gestoria/packages/db/drizzle/0003_reglas_catalogo.sql` (disparador y reglas),
  `gestoria/packages/db/src/catalogo.test.ts`.
- `gestoria/apps/api/src/stock.ts`, `catalogo.ts`, `hoja.ts` y sus pruebas.
- ADR 0203 (gestorIA aparte).
