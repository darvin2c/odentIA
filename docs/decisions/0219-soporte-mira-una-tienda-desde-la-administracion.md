# 0219 · Soporte mira una tienda de gestorIA desde la administración, con su código

Fecha: 2026-11-25 · Estado: aceptada · Paso 6 del lienzo «Una cuenta, todas las apps» (sobre ADR
0214 y 0215)

## Problema

Desde el ADR 0214, soporte del Grupo Sallca entra a una tienda de gestorIA solo si la tienda lo
acepta, solo a mirar y por un rato. Pero entraba con su cuenta como cualquier persona: correo y
contraseña, sin el código de dos pasos que el personal pone para abrir la administración. Una
contraseña filtrada bastaba para mirar la tienda y su equipo. Además, al terminar le decían «Puede
que te hayan quitado del equipo», su único «Salir» era «Cerrar sesión» (que cierra también la
administración, porque es la misma sesión, ADR 0215), la tienda no sabía si soporte entró ni cómo
terminó, y la administración daba por «Hecho» un pedido que la tienda todavía no respondía.

En las clínicas, en cambio, la mirada nace en la administración, ya con el código, y al terminar lo
dice (ADR 0184).

## Decisión y motivo

- **La cuenta dice en el token firmado si esa sesión pasó el código del personal**
  (`staffVerified`, `tokenClaims` de `createAuth`, `staffVerifiedSession` de `admin-core.ts`), con
  la regla de la administración: la marca viva de esa misma sesión, del mismo país que la petición
  que pide el token, de una persona activa del personal, con su factor vigente y sin bloqueo. Better
  Auth arma el token sin ver la petición: el país viaja de la ruta al token solo durante esa
  petición (`lib/visit.ts`). Fuera de ella, o si el servidor no recibe el país que guardó la marca,
  no hay marca: nadie mira (lado seguro). El equipo reconocido no cuenta aquí: su cookie es de la
  API de la administración; al abrir la administración con él, la sesión ya queda marcada.
- **gestorIA exige la marca en los dos lugares**: la lista de tiendas (`/api/yo`) y cada pedido a la
  tienda (`seatIn`). Sin ella, ni la tienda sale en su lista ni se abre.
- **Se mira desde la administración**: «Mirar la tienda (solo mirar)», en el pedido de entrar de
  quien lo pidió (rol Administración), abre la tienda con el pase entre dominios, que lleva la misma
  sesión que ya pasó el código. El botón sale solo a quien lo pidió; el servidor de gestorIA lo
  protege igual, porque la entrada es de esa persona.
- **El servidor dice cómo está la entrada de esa persona** (`GET /api/tiendas/:id/soporte/mio` y
  el código de cada rechazo): la tienda todavía no responde, hay que abrirla desde la
  administración, o el acceso terminó con su motivo (se terminó el tiempo, la sacó tal persona,
  salió ella, la tienda dijo que no, nadie respondió). A cualquier otra persona, la tienda no existe.
- **«Salir» de la franja termina solo la mirada** (`soporte.salio`, migración
  `0013_la_mirada_de_soporte`), nunca la sesión; «Cerrar sesión» avisa antes que también cierra la
  administración.
- **La tienda ve quién miró, desde cuándo, quién lo dejó entrar y cómo terminó**; Ventas ve solo
  quién mira y hasta cuándo; soporte no ve esa lista. Un pedido por vez: un segundo pedido sin
  responder falla con su motivo.
- **La administración no se entera de cuándo acepta la tienda**: el pedido dice «Pedido a la
  tienda» y, al pulsar el botón, gestorIA dice si ya se puede mirar.

## Alternativas descartadas

- **Una sesión aparte de soporte, como en las clínicas**: mucho más trabajo y no protege más; en
  gestorIA lo que soporte puede hacer ya lo limita su lugar en la tienda (mirar tienda, equipo y
  catálogo).
- **Que gestorIA pregunte a la cuenta por la marca en cada pedido**: ata cada pedido de la tienda a
  que la cuenta responda; el token ya viaja en cada uno.
- **Comprobar la marca sin el país**: el código de la administración solo vale desde el país donde
  se puso; sin él, un código puesto en otro país bastaría.
- **Avisar a la administración cuando la tienda acepta**: otro mensaje entre los dos sistemas; queda
  para después.

## Consecuencias

- **Beneficio:** una contraseña sola ya no deja mirar ninguna tienda; soporte y la tienda saben qué
  pasó con cada entrada, con las mismas palabras.
- **Sacrificio:** la marca vive en el token hasta 15 minutos: si la persona deja el personal, la
  tienda lo sabe en ese tiempo (la tienda que la saca, al momento). Que `api.gestoria24.com` reciba
  el país de la visita está por comprobar en producción: si no, nadie mira hasta arreglarlo.
- **Cuándo revisarlo:** si el rol Soporte de la administración debe pedir y mirar desde su cola, si
  los minutos deben correr desde la primera entrada o si la administración debe saber cuándo acepta
  la tienda.

## Referencias

`packages/auth/src/index.ts` (`tokenClaims`, `signedTokenPayload`), `apps/api/src/lib/visit.ts`,
`packages/services/src/admin-core.ts` (`staffVerifiedSession`), `gestoria/apps/api/src/soporte.ts`,
`gestoria/apps/api/src/tiendas.ts` (`seatIn`), `gestoria/apps/web/src/lib/soporte.ts`,
`admin/apps/web/src/lib/support-look.ts`; migración `0013_la_mirada_de_soporte.sql` de gestorIA.
ADR 0184, 0214 y 0215.
