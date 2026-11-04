# 0138 · La app de las clínicas también se arma en Cloudflare Workers

Fecha: 2026-11-03 · Estado: aceptada · Sigue a [0137](0137-panel-y-administracion-en-cloudflare-workers.md).

## Problema

Con las webs, el panel y la administración en Workers, la app de las clínicas (`<clínica>.odentia32.com`, `<clínica>.latidia72.com`, ADR 0086) era lo último del lado de las pantallas que se armaba en el VPS.

## Decisión y motivo

- **Dos Workers, uno por producto:** `odentia-clinicas` (`apps/dental-clinic`) y `latidia-clinicas` (`apps/medical-clinic`), con `@cloudflare/vite-plugin` sobre TanStack Start solo con `WEB_TARGET=cloudflare`, y los mismos dominios con que se arman en el VPS. `pnpm dev` sigue con Node.
- **Solo la cookie viaja a la API también aquí:** `ssrFetchOptions` de `@odentia/clinic-app` reenviaba todas las cabeceras de la visita (ADR 0137). `apiFetch` ya mandaba solo la cookie y el slug de la clínica, que sigue saliendo del `Host` de la visita.
- **Los códecs DICOM quedan fuera del servidor** (`clinicAppWorkerStubs`): se cargan solo en el navegador y ocupaban unos 390 KB del paquete. Sin ellos pesa 2,6 MB (odentIA) y 2,5 MB (latidIA) comprimidos; con ellos quedaba al 97 % de los 3 MB del plan gratuito.
- **Entrada con una ruta comodín y exclusiones:** `*.<dominio>/*` al Worker, Fail open. Las direcciones que no son clínicas tienen su propia ruta, que gana por ser más específica: `app.`, `admin.` y `www.` van a sus Workers, y `api.` (y `media.` en odentIA, los archivos de R2) a ninguno, para que sigan yendo al VPS y a R2.

## Alternativas descartadas

- **Esperar a medir el panel con más uso:** el dueño pidió moverla ya; el VPS sigue de respaldo y volver atrás es quitar la ruta.
- **Una ruta por clínica:** cada clínica nueva pediría tocar Cloudflare.

## Consecuencias

- La app de las clínicas sigue dependiendo de la API del VPS: mejora lo que no pide datos al servidor; las pantallas con sesión responden casi igual (ADR 0137).
- Es la app más usada y sus pantallas con sesión no se guardan en caché: es la que más arriesga pasar los 10 ms de CPU del plan gratuito, y un error ahí lo ve la clínica (Fail open solo cubre el límite diario). Se mira en Metrics; si aparecen cortes, la salida es el plan de USD 5 de Workers (CPU de sobra y 10 MB) o quitar la ruta.
- Queda poco margen de tamaño: si crece más allá de 3 MB comprimidos, el plan gratuito deja de alcanzar.
- Retirados del VPS el mismo 2026-11-03 (`platform` y `latidia` fuera del compose): sin respaldo, un error del Worker lo ve la clínica; volver es devolverlos al compose.
- `chat.js` deja de guardarse 4 horas en el navegador: el Worker lo revalida, así que un cambio del chat llega enseguida a las webs de las clínicas.

## Referencias

`apps/dental-clinic/vite.config.ts`, `apps/medical-clinic/vite.config.ts`, `packages/clinic-app/vite.ts` (`clinicAppWorkerStubs`), `packages/clinic-app/src/lib/guards.ts`, `.github/workflows/ci.yml` (`deploy-web`), `docs/deployment.md`.
