# 0137 · El panel y la administración también se arman en Cloudflare Workers

Fecha: 2026-11-03 · Estado: aceptada · Sigue a [0136](0136-las-webs-de-marketing-en-cloudflare-workers.md).

## Problema

Con las webs en Workers, el panel (`app.` de odentIA y de latidIA) y la administración (`admin.`) seguían armándose en el VPS: cada pantalla iba de Cloudflare al VPS por el túnel (unos 160 ms antes de empezar a responder) y cada cambio esperaba el despliegue completo de OpenShip.

## Decisión y motivo

- **Tres Workers más, igual que las webs:** `odentia-admin`, `odentia-panel` y `latidia-panel` (`apps/admin/wrangler.jsonc`, `apps/panel/wrangler.jsonc`), con `@cloudflare/vite-plugin` sobre TanStack Start solo cuando se arma con `WEB_TARGET=cloudflare`. `pnpm dev` sigue con Node, que llega a la API de portless.
- **Siguen dependiendo de la API del VPS:** cada pantalla con sesión la pide a `api.` por su dirección pública, como ya hacía. Lo que se gana es el viaje del HTML y el despliegue aparte, no que funcionen sin el VPS.
- **Solo la cookie viaja a la API.** El panel reenviaba todas las cabeceras de la visita. En Node, `fetch` descarta `Host`; en Workers no hay esa garantía (en `wrangler dev` tampoco se respetó, pero no lo probamos en Cloudflare), y el túnel elige el servicio por `Host`. La API solo necesita la cookie (`get-session`, `/legal/status`), así que el panel reenvía solo esa, como la administración.
- **Entrada con rutas y Fail open, como las webs:** `app.<dominio>/*` y `admin.odentia32.com/*` en el panel de Cloudflare. Fail open solo cubre el límite diario de peticiones del plan: pasado ese tope la visita sigue al VPS, que conserva `panel`, `latidia-panel` y `admin`. Si el Worker falla o pasa los 10 ms de CPU, la visita ve un error de Cloudflare (1101 o 1102), no el VPS; volver atrás es quitar la ruta.
- **Los archivos con huella se guardan un año** (`public/_headers`), como hace `scripts/static-files.mjs` en el VPS.

## Alternativas descartadas

- **Dejarlos en el VPS:** es lo que ADR 0136 dejaba como estudio; el dueño pidió moverlos y la prueba en un Worker local no mostró nada que lo impida.
- **Pasar también la app de las clínicas (`*.<dominio>`):** queda fuera de esta entrega; también reenvía todas las cabeceras y usa `Host` para saber de qué clínica es.

## Consecuencias

- Pesan 860 KB (administración) y 780 KB (cada panel) comprimidos, por debajo de los 3 MB del plan gratuito. Las pantallas con sesión no se pueden guardar en caché, y en Node local tardan de 2 a 7 ms en la mediana y 26 ms en el p90 de `/onboarding` (tiempo total, no solo CPU): cerca del límite de 10 ms. Se mira en Metrics con la ruta puesta; si aparecen errores de CPU, se quita la ruta o se pasa al plan de USD 5.
- Los registros de estas pantallas pasan a Workers (3 días en el plan gratuito).
- Retirar `panel`, `latidia-panel` y `admin` del VPS es una entrega aparte, cuando las métricas lo respalden.

## Referencias

`apps/panel/vite.config.ts`, `apps/admin/vite.config.ts`, `apps/panel/src/lib/guards.ts`, `.github/workflows/ci.yml` (`deploy-web`), `docs/deployment.md` («Las webs en Cloudflare Workers»).
