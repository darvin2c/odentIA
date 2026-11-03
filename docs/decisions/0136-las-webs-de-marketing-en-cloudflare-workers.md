# 0136 · Las webs de marketing se publican en Cloudflare Workers

Fecha: 2026-11-03 · Estado: aceptada · Actualiza [0046](0046-web-de-marketing-en-astro.md) (la web se despliega detrás del mismo borde) y [0062](0062-fundadores-alta-por-invitacion-y-precios-de-la-administracion.md) (el servidor de Node lee los precios por la red del stack).

## Problema

Las dos webs de marketing (odentia32.com y latidia72.com, la misma `apps/web`) se arman en el VPS con el servidor de Node de Astro. Cambiar un texto obliga a pasar por el despliegue de OpenShip, que reconstruye admin, panel, platform, API y worker y tarda más de 20 minutos, y las dos webs ocupan memoria en un servidor compartido. Todas las visitas ya entran por Cloudflare (el túnel); solo falta que la página se arme ahí.

## Decisión y motivo

- **Workers, no Pages.** Cloudflare recomienda Workers para lo nuevo y la web arma cada página al pedirla (ADR 0062): en Pages esa parte también corre en un Worker, con una capa más. Un Worker por web (`odentia-web` y `latidia-web`, `apps/web/wrangler.jsonc`), cada uno con su build de siempre (`VITE_BASE_DOMAIN`, `VITE_PRODUCT`).
- **En el plan gratuito.** El tráfico es bajo y la web es simple: 100 000 peticiones al día y 10 ms de CPU por petición. Los archivos de la página (`/_astro/…`, fuentes, imágenes) no cuentan. Armar una página tarda de 3 a 10 ms en local, al límite; por eso el middleware guarda 30 segundos cada página armada (200 o 404) con la API de caché del centro de datos (`caches.default`, `src/lib/edge-cache.ts`): la visita que la encuentra no la vuelve a armar. La clave no lleva los parámetros de campañas (`utm_*`, `fbclid`…), que no cambian la página. El 503 no se guarda: seguiría diciendo «vuelve» con la API de vuelta.
- **Los precios, como antes.** El Worker los lee de la ruta pública (`https://api.<dominio>`, ya no por la red del stack) y los guarda 30 segundos; con la caché de la página, un cambio en la administración se ve en un minuto como mucho. Cada isolate de Workers empieza sin nada en memoria, así que lo último leído también queda un día en la caché del centro de datos: si la API no responde (un reinicio al desplegar), se muestran esos precios. Solo si nunca se leyeron, 503.
- **Despliegue propio.** El job `deploy-web` del CI publica las dos webs al pasar las pruebas de main, aparte de OpenShip, en un par de minutos. En un PR solo comprueba que se arman (`wrangler deploy --dry-run`).
- **El cambio de entrada es a mano y reversible.** El Worker toma el dominio con una ruta (`<dominio>/*` y `www.<dominio>/*`, Fail open) delante del túnel, sin tocar el DNS: si falla o pasa los límites, la visita sigue al VPS, que conserva su servidor de Node (el adaptador de Cloudflare se elige con `WEB_TARGET=cloudflare`). Volver atrás es quitar la ruta (`docs/deployment.md`).

## Alternativas descartadas

- **Seguir en el VPS y guardar el HTML en el borde con una regla de caché:** daría la misma rapidez, pero cada texto seguiría esperando el despliegue completo.
- **Generar la web por adelantado (HTML estático en Workers o Pages):** ya descartado en la ADR 0062: un precio cambiado obligaría a volver a publicar.
- **La caché delante del Worker (`cache` en wrangler, con `cacheCloudflare()` de Astro):** es la que Astro trae armada, pero con ella cada archivo de la página también cuenta como petición, unas 25 por visita nueva: el plan gratuito alcanzaría para unas 4000 visitas al día y, pasado el tope, la web no responde hasta el día siguiente.
- **Plan pago desde el principio (USD 5 al mes):** solo si la CPU medida en Cloudflare pasa los 10 ms con la caché puesta.

## Consecuencias

- Beneficio: un texto llega en minutos sin tocar lo demás, y el VPS deja de servir las dos webs.
- Sacrificio: cada página que se abre, también desde la caché, cuenta como una petición del plan gratuito (100 000 al día), y también cada enlace que se baja al pasar el puntero (`prefetch`). La caché vale solo en los dominios propios, no en `*.workers.dev`, que sigue abierto (con la dirección canónica del dominio) hasta declarar los dominios. Los registros de visitas son los de Workers (3 días en el plan gratuito), no los del servidor.
- Las webs se publican antes que la API, que espera el despliegue de OpenShip: un cambio que haga a la web pedir algo nuevo de `/api/public/founders/pricing` debe tolerar unos minutos la API anterior.
- Hecho el cambio (2026-11-03): `workers_dev` apagado, y `web` y `latidia-web` fuera del compose y del `Dockerfile`, con lo que el VPS deja de servir las webs y Fail open ya no tiene respaldo. Las rutas siguen en el panel de Cloudflare, no en `wrangler.jsonc`: wrangler no sabe ponerles Fail open. El adaptador de Node queda solo para `pnpm dev`, que llega a la API de portless.
- Revisar si la CPU de una página pasa los 10 ms, si las visitas superan el plan o si la web necesita la red interna del stack.

## Referencias

`apps/web/astro.config.mjs`, `apps/web/wrangler.jsonc`, `apps/web/src/middleware.ts`, `.github/workflows/ci.yml` (`deploy-web`), `docs/deployment.md` («Las webs en Cloudflare Workers»).
