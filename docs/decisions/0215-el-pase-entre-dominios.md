# 0215 · El pase entre dominios: la sesión viaja al pasar de una app a otra

Fecha: 2026-11-25 · Estado: aceptada · Reemplaza, para quien pasa desde la app, «entra una vez
en cada dominio» del ADR 0087 · Paso 5 del lienzo «Una cuenta, todas las apps» (decisiones 1, 2
y 4)

## Problema

Cada app vive en su dominio (`odentia32.com`, `latidia72.com`, `vistia20.com`,
`gestoria24.com`) con su propia instancia de la cuenta (ADR 0087 y 0201): misma base, mismo
secreto, una cookie por dominio. Abrir desde el panel de odentIA una clínica de latidIA pedía
entrar otra vez y, en una compu compartida, podía dejar trabajando a la persona que había
quedado entrada en ese otro dominio: lo que se hiciera quedaba a su nombre.

El lienzo aprobado deja cada app con su entrada en su dominio, sin una puerta única ni un
dominio nuevo, y pide que la sesión se abra al pasar de un dominio a otro.

## Decisión y motivo

- **Un pase de un uso, en la API, atado al navegador que lo pidió** (`packages/auth/src/pase.ts`,
  `/api/auth/pase/*` en cada dominio, también el de gestorIA). El enlace a otro dominio va a
  `ir` en la API de destino, que deja una marca de un uso en una cookie solo de esa API y manda
  a `emitir` en la del origen; esta, con la sesión de su dominio, guarda un pase de un minuto
  atado a la marca; `canjear`, en el destino, lo gasta al leerlo y solo sirve si la marca del
  navegador es la misma. Sin la marca, alguien podría mandar por WhatsApp un enlace con su pase
  y dejar a otra persona trabajando dentro de su cuenta.
- **El pase lleva la misma sesión.** Una sola fila de sesión por navegador: la marca de dos
  pasos de la clínica (`team-two-factor.ts`) y la verificación del personal viajan con ella, y
  «Cerrar sesión» en cualquier app la cierra en todas las que la recibieron.
- **Al llegar, reemplaza la sesión que hubiera en ese dominio** y la cierra: si era de otra
  persona, queda la que venía. «Entrar con otra cuenta» cierra antes la de quien estaba, y entrar
  con otro correo cierra la sesión anterior del navegador.
- **Lo arman las direcciones**: `tenantUrl` y `adminUrl` (panel y clínica) pasan por el pase
  solo cuando el destino es otro dominio del grupo (`crossDomainHref`). Mismo dominio, enlace
  normal. `next` solo puede ser del dominio de destino.
- **Los avisos del equipo quedan atados a la sesión** (`push_subscription.session_id`, en
  cascada): cerrar la sesión desde cualquier app apaga los avisos de ese equipo.

## Alternativas descartadas

- **`one-time-token` de Better Auth:** su canje es una ruta pública que no mira nada del
  navegador; cualquiera con el pase lo canjea. Montarlo dejaría esa ruta abierta aunque se
  envolviera.
- **Abrir la sesión en todos los dominios al entrar:** más saltos en cada entrada, para algo que
  usa sobre todo el equipo de odentIA (lienzo, decisión 2).
- **Una puerta única o un proveedor OIDC central:** cambia todas las entradas y suma
  infraestructura (lienzo, decisión 1).

## Consecuencias

- **Beneficio:** pasar de odentIA a latidIA, vistIA o la administración desde la app no pide la
  clave ni el código de dos pasos, y nadie llega a nombre de otra persona por haber pasado.
- **Sacrificio:** quien abre directo otro dominio (un favorito) entra una vez en ese navegador,
  y una cookie vieja de otra persona en ese dominio sigue hasta que alguien pase con el pase,
  salga o venza. Cerrar sesión en una app cierra todas las de ese navegador que la recibieron.
  Los avisos activados antes de esta decisión siguen hasta que se revisan en la campana (ahí
  quedan atados) o la persona se queda sin ninguna sesión abierta.
- **gestorIA:** su app guarda el token firmado 15 minutos en memoria; tras cerrar la sesión o
  cambiar la contraseña puede seguir abierta ese tiempo en otro navegador.
- **Cuándo revisarlo:** si la mayoría de quienes usan varias apps no son del equipo de odentIA,
  o si una app necesita entrar directo sin pasar por otra.

## Referencias

- `packages/auth/src/pase.ts` y `pase.test.ts`; `apps/api/src/index.ts` (`sisters`).
- `apps/panel/src/lib/host.ts` y `packages/clinic-app/src/lib/host.ts` (`crossDomainHref`).
- `packages/db/drizzle/0156_avisos_con_la_sesion.sql`; `packages/services/src/push.ts`.
- ADR 0087 (dos dominios), 0201 (la cuenta de las apps), 0107 (dos pasos de la clínica).
