# 0193 · Solo los subdominios de clínicas reales llegan al Worker de las clínicas

Fecha: 2026-11-15 · Estado: aceptada · Sigue a la [0138](0138-la-app-de-las-clinicas-en-cloudflare-workers.md) (la app de las clínicas en Workers)

## Problema

La app de las clínicas entra por una ruta comodín (`*.odentia32.com/*` a `odentia-clinicas`, `*.latidia72.com/*` a `latidia-clinicas`), así que cualquier subdominio inventado llega al Worker y gasta una de las 100 000 peticiones diarias que el plan gratuito da a toda la cuenta. El 15 nov un robot que probaba subdominios inventados (`graylog.latidia72.com/login`, `/admin`…) agotó el tope y se cayeron todas las pantallas: sin el VPS de respaldo, Fail open ya no salva. La regla de WAF que puso el dueño bloquea la IP del robot y las rutas de archivos secretos (`/.env`, `.php`, `/wp-`), pero un subdominio inventado con una ruta normal sigue llegando.

## Decisión y motivo

- **Una regla personalizada de WAF por zona con la lista de hosts permitidos**, aparte de la del robot: `ends_with(http.host, ".<dominio>") and not http.host in {…}` con Block. El WAF corre antes que el Worker: lo bloqueado no gasta peticiones ni CPU, y el dominio mismo no termina en `.<dominio>`, así que la web no se toca.
- **La lista la mantiene el sistema** (`syncClinicHosts`): los subdominios del sistema (`SYSTEM_SUBDOMAINS`: `www`, `app`, `admin`, `api`, `media`) y uno por cada clínica de la base, en cualquier estado de su plan, y por cada demo pedida, en el dominio de su producto; la que aún no tiene perfil va en todos. Se pone al día al abrir, renombrar o borrar una clínica (las rutas de Better Auth), con el alta asistida y al pedir o borrar una demo, antes de responder; el worker, al armar o vencer una demo, al arrancar y una vez al día.
- **Un adaptador de la API de Rulesets** (`cloudflareHostsFirewall`, fase `http_request_firewall_custom`) detrás del puerto `HostsFirewall`: reconoce la regla por su descripción, la crea al final si falta y, si está, cambia solo su expresión. Nunca reescribe la entrada de la fase ni toca otra regla; si alguien la apaga o le cambia la acción en el panel, queda así.
- **Sin cortes:** un fallo de Cloudflare queda en el registro y la operación sigue; la reconciliación lo repite (en una hora si falló). Si la lectura de las clínicas falla, o una zona no tiene ninguna, no se publica: una lista solo con los del sistema bloquearía a todas. Va una sincronización a la vez entre la API y el worker (un candado de la base mientras lee y publica), para que ninguna pise la lista de otra con una lectura anterior.
- **Apagado hasta tener el token** (`CLOUDFLARE_WAF_TOKEN`, `CLOUDFLARE_ZONE_ID`, `MEDICAL_CLOUDFLARE_ZONE_ID`; `OPTICAL_CLOUDFLARE_ZONE_ID` para cuando vistIA tenga su dominio en Cloudflare): sin ellos no se llama a Cloudflare y se registra al arrancar.

## Alternativas descartadas

- **Workers Paid (USD 5 al mes):** diez millones de peticiones, pero se siguen gastando en robots; se deja para cuando haya clínicas reales o la lista no quepa.
- **Una ruta de Worker por clínica, sin comodín:** cada clínica nueva pediría tocar las rutas y su DNS; la 0138 la descartó por eso.
- **Que el Worker rechace los subdominios que no son clínicas:** la petición ya se contó al llegar.
- **Bot Fight Mode:** frena los webhooks de Meta en `api.` y el plan gratuito no deja excluirlos.

## Consecuencias

- Un subdominio inventado responde 403 de Cloudflare sin gastar el tope. Un subdominio nuevo del sistema con proxy en estas zonas tiene que entrar en `SYSTEM_SUBDOMAINS`, o queda bloqueado. Los slugs reservados (`RESERVED_ORG_SLUGS`) salen de esa lista más `storage`: `media` deja de poder ser el subdominio de una clínica.
- Entre que se abre una clínica y la regla toma la lista pasan unos segundos. Si Cloudflare falla justo entonces, su subdominio queda bloqueado hasta la reconciliación del worker (al día siguiente, o antes si el worker se reinicia); si eso pasa a menudo, la reconciliación puede ser cada hora.
- La expresión tiene un tope de 4000 caracteres: alcanza para unas 130 clínicas por dominio, con subdominios de unas 12 letras. Desde 3200 se avisa en el registro y, pasado el tope, no se publica (nunca recortada): ahí hay que pasar a Workers Paid o a otra estrategia.

## Referencias

`packages/services/src/clinic-hosts.ts` (`syncClinicHosts`, `planHostsRule`, `clinicHostsFromEnv`), `packages/services/src/cloudflare-waf.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts` (`clinic_hosts`) y `apps/worker/src/demos.ts`; pruebas en `packages/services/src/clinic-hosts.test.ts`, `packages/services/src/cloudflare-waf.test.ts` y `apps/api/src/routes/clinic-hosts.test.ts`; operación en `docs/deployment.md`.
