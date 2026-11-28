# 0236. gestorIA: las fotos y los videos del producto, fuera de la base

- **Fecha:** 2026-11-27
- **Estado:** aceptada

## Problema

La ficha del producto (lienzo «La ficha del producto», decisiones 3, 4 y 9) pide una foto por
color, quitar el fondo como propuesta guardando la original, un video corto por producto o por
color («Puesta, caminando · 0:12») y «Cargar muchos» con cientos de fotos. Hoy cada foto va en la
base (`product_photo.content`, `bytea`, hasta 1,5 MB): un video no cabe, la propuesta y las copias
para cada uso multiplican el peso, y el respaldo de la base crece con cada foto.

Restricciones: gestorIA es otro sistema (ADR 0203) y no importa nada de las clínicas
(`gestoria-boundaries.test.ts`); los archivos van en buckets privados, con el permiso mirado antes
de un enlace firmado de corta duración, sin el SDK del proveedor en el dominio y con tipo y tamaño
validados (skill de arquitectura). Lo que Sofi manda por WhatsApp tiene que entrar en lo que acepta
la Cloud API: imagen JPEG o PNG (o WebP estática, que Meta pasa a JPEG) de 8 bits, hasta 5 MB;
video MP4 o 3GPP hasta 16 MB, H.264 y AAC, una pista de audio o ninguna; Meta advierte que el
perfil «High» y los cuadros B no se ven en Android y recomienda Main o Baseline sin cuadros B con
el índice (`moov`) antes de los datos
([Supported media types](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#supported-media-types)).
Lo subido a Meta dura 30 días y un enlace (`link`) también vale, aunque Meta recomienda el id
([Image messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages)).

## Decisión y motivo

1. **Un bucket propio de gestorIA**, privado, con la API de S3: RustFS en local (el de
   `infra/dev/compose.yaml`, bucket `gestoria-medios`) y R2 en producción (bucket `gestoria-medios`,
   aparte de los de las clínicas, sin acceso público ni dominio). Variables `GESTORIA_S3_ENDPOINT`,
   `GESTORIA_S3_REGION`, `GESTORIA_S3_ACCESS_KEY`, `GESTORIA_S3_SECRET_KEY`, `GESTORIA_S3_BUCKET`.
   Sin ellas no se sube nada (503) y la app lo dice.
2. **Un adaptador propio de gestorIA** (`gestoria/apps/api/src/archivos.ts`: guardar, leer, firmar,
   borrar una carpeta), no el de las clínicas movido a `shared/`. El de las clínicas
   (`packages/services/src/storage.ts`) está hecho de casos clínicos (avatares, adjuntos de
   conversaciones, documentos del paciente, el proxy de soporte); lo común con gestorIA es solo el
   SDK de S3. Moverlo tocaría decenas de usos de las clínicas para compartir unas 40 líneas.
3. **Subir pasa por el servidor**, no por un enlace firmado de subida: mira el permiso
   (`configuracion`), el tipo por sus primeros bytes y el tamaño (foto hasta 8 MB; video hasta
   16 MB y 30 segundos, con su póster), y recién entonces guarda. Así no hace falta CORS en el
   bucket ni quedan archivos sin revisar.
4. **Se comprime en los dos lados.** La pantalla achica antes de subir (la foto en un lienzo; el
   video con Mediabunny sobre WebCodecs, MPL-2.0, a H.264 Main sin cuadros B, AAC, hasta 720 px y `moov` al principio). El servidor guarda la
   original tal cual y arma con sharp (libvips) la miniatura (WebP, 400 px), la de la ficha y la
   vitrina (WebP, 1600 px) y la de WhatsApp (JPEG, 1600 px, sobre blanco, bajo 5 MB), sin los datos
   de la cámara. El video no se vuelve a armar en el servidor (no hay ffmpeg en la imagen ni CPU
   para eso): se leen sus cajas MP4 (`video.ts`) y se rechaza con su motivo lo que WhatsApp no
   mostraría.
5. **Ver es un enlace firmado**: 10 minutos para la app (`catalogo.ver`), una hora para la vitrina
   pública (`/vitrina/<link>/<producto>/medios`, solo de un producto que se ve en la web, sin la
   original ni la propuesta) y para Sofi (la copia de WhatsApp, que el canal sube a Meta por su id
   cuando exista o manda por `link`).
6. **Las fotos de antes se mudan solas**: `content` pasa a opcional y una foto nueva no lo lleva
   (regla de la base); el servidor, al arrancar y cada minuto, pasa las de la base al bucket
   (`moveStoredPhotos`) y deja `content` vacío. La columna se borra en otra entrega, cuando ninguna
   imagen del servidor la lea: `migrate` corre antes de levantar la API y la anterior todavía la lee.
7. **Borrar lo anota la base**: al borrar una foto, un video o una foto de carga (también en
   cascada, al borrar el producto o la tienda) un disparador anota la carpeta en `media_trash`,
   salvo que otra fila la use; el servidor la borra después (`emptyMediaTrash`). Una foto de «Cargar
   muchos» pasa al producto con su misma carpeta, sin copiarla.

## Alternativas descartadas

- **Seguir en la base.** Sin video; la base y su respaldo cargan cada copia.
- **Mover el adaptador de las clínicas a `shared/`.** Un PR que corre todas las pruebas de las
  clínicas para compartir poco; se reconsidera si un tercer sistema necesita lo mismo.
- **Subida directa con enlace firmado.** Pide CORS en el bucket y una segunda vuelta para revisar lo
  subido; con 8 y 16 MB el servidor lo recibe sin problema.
- **Bucket público para la vitrina.** Expone todo lo subido, también la original y lo de una
  tienda que lo sacó de la web.
- **Comprimir el video en el servidor con ffmpeg.** Agranda la imagen y usa CPU que el contenedor
  (1 CPU, 512 MB) no tiene.

## Consecuencias

- Las fotos y los videos no pesan en la base; cada foto ocupa unas cuatro veces en el bucket
  (original y tres copias), y la propuesta sin fondo otro tanto.
- Un navegador sin WebCodecs no podrá achicar el video: el servidor lo rechaza con su motivo.
- Los enlaces cambian cada vez: la vitrina no puede guardarlos más de lo que valen.
- Quién quita el fondo queda abierto: el servidor recibe la propuesta ya hecha.
- Revisar si el tamaño del bucket o los pedidos a R2 pasan de lo que cuesta el plan, o si un tercer
  sistema pide el mismo adaptador.

## Referencias

- `gestoria/apps/api/src/archivos.ts`, `medios.ts`, `imagenes.ts`, `video.ts`, `cargas.ts`,
  `leer-hoja.ts`.
- `gestoria/packages/db/drizzle/0038_las_fotos_y_videos_del_producto.sql` y
  `0039_reglas_fotos_y_videos.sql`.
- ADR 0203 (gestorIA es otro sistema), ADR 0206 (el stock solo con el kardex).
