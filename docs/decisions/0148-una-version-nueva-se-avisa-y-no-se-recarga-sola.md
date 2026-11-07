# 0148. Una versión nueva se avisa y no se recarga sola

- **Fecha:** 2026-11-06
- **Estado:** aceptada

## Problema

Vite pone la huella de cada archivo en su nombre y cada despliegue deja en Cloudflare solo los nuevos. Una pestaña abierta antes del despliegue sigue con la versión vieja: lo que baja recién al abrirse no lo encuentra. Eso pasa con el selector de piezas, el 3D, los lectores de imágenes comprimidas y las secciones de la ficha. La persona veía «No se pudo abrir esta parte» o, en una radiografía comprimida, que el archivo no se podía descomprimir: el mensaje le echaba la culpa al archivo. Lo mismo ocurre si se corta la conexión justo al abrir esa parte.

## Decisión y motivo

- **Una sola escucha:** la raíz de cada app escucha `vite:preloadError` (`watchNewVersion`). Lo que atrapa el error de un `import()` (`lazyPart`, el 3D, los códecs) lo reconoce con `isChunkLoadError`.
- **Un aviso, una vez:** un toast fijo con «Recargar» (`markNewVersion`). Dice lo que se sabe: puede haber una versión nueva o se cortó la conexión, y lo ya guardado no se pierde.
- **No se recarga sola.** Recargar a ciegas corta la subida de un CD, que vive en la pestaña, y borra lo que alguien está escribiendo en un cajón. Recargar es decisión de la persona.
- **Dentro del visor**, el toast queda detrás del diálogo. Ahí la parte que falló da el mismo mensaje con su propio «Recargar».

## Alternativas descartadas

- **Recargar una vez sola, con una marca en `sessionStorage`:** pierde lo que no se guardó y corta subidas. No se puede saber en general si hay algo a medio escribir.
- **Conservar los archivos viejos tras desplegar:** Workers sirve solo los de la versión publicada. Guardarlos aparte complica el despliegue de cada app por un caso que se resuelve con recargar.

## Consecuencias

La persona entiende qué pasó y cómo seguir, y nada se pierde sin que lo decida. A cambio, después de cada despliegue alguien puede ver el aviso y tener que recargar. Se revisaría si los despliegues pasan a ser varios por hora, o si la app guarda los borradores de todos sus cajones.

## Referencias

- `packages/clinic-app/src/lib/new-version.ts`
- `apps/dental-clinic/src/product/dental/lazy-part.tsx`
- `packages/clinic-app/src/components/patient/tomography-3d.tsx`
- `packages/clinic-app/src/lib/dicom.ts`
