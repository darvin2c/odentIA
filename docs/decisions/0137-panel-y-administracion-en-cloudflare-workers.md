# 0137 · El panel y la administración también se arman en Cloudflare Workers

Fecha: 2026-11-03 · Estado: aceptada · Sigue a [0136](0136-las-webs-de-marketing-en-cloudflare-workers.md).

## Problema

Con las webs en Workers, el panel (`app.` de odentIA y de latidIA) y la administración (`admin.`) seguían armándose en el VPS: cada pantalla iba de Cloudflare al VPS por el túnel (unos 160 ms antes de empezar a responder) y cada cambio esperaba el despliegue completo de OpenShip.

## Decisión y motivo

- **Tres Workers más, igual que las webs:** `odentia-admin`, `odentia-panel` y `latidia-panel` (`apps/admin/wrangler.jsonc`, `apps/panel/wrangler.jsonc`), con `@cloudflare/vite-plugin` sobre TanStack Start solo cuando se arma con `WEB_TARGET=cloudflare`. `pnpm dev` sigue con Node, que llega a la API de portless.
- **Siguen dependiendo de la API del VPS:** cada pantalla con sesión la pide a `api.` por su dirección pública, como ya hacía. Lo que se gana es el viaje del HTML y el despliegue aparte, no que funcionen sin el VPS.
- **Solo la cookie viaja a la API.** El panel reenviaba todas las cabeceras de la visita; en Node `fetch` descarta `Host`, pero en Workers se respeta y el túnel, que elige el servicio por `Host`, llevaría el pedido de la sesión a `app.` en vez de a la API. Ahora reenvía solo la cookie, como la administración.
- **Entrada con rutas y Fail open, como las webs:** `app.<dominio>/*` y `admin.odentia32.com/*` en el panel de Cloudflare. Si el Worker falla o pasa los límites del plan, la visita sigue al VPS, que conserva `panel`, `latidia-panel` y `admin`.

## Alternativas descartadas

- **Dejarlos en el VPS:** es lo que ADR 0136 dejaba como estudio; el dueño pidió moverlos y la prueba en un Worker local no mostró nada que lo impida.
- **Pasar también la app de las clínicas (`*.<dominio>`):** queda fuera de esta entrega; también reenvía todas las cabeceras y usa `Host` para saber de qué clínica es.

## Consecuencias

- Pesan 860 KB (administración) y 780 KB (cada panel) comprimidos, por debajo de los 3 MB del plan gratuito. La CPU por pantalla con sesión no se pudo medir sin entrar; se mira en las métricas de cada Worker después de poner la ruta, con el VPS de respaldo.
- Los registros de estas pantallas pasan a Workers (3 días en el plan gratuito).
- Retirar `panel`, `latidia-panel` y `admin` del VPS es una entrega aparte, cuando las métricas lo respalden.

## Referencias

`apps/panel/vite.config.ts`, `apps/admin/vite.config.ts`, `apps/panel/src/lib/guards.ts`, `.github/workflows/ci.yml` (`deploy-web`), `docs/deployment.md` («Las webs en Cloudflare Workers»).
