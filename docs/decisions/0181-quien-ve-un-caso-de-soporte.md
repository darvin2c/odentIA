# 0181 · Quién ve un caso de soporte

Fecha: 2026-11-11 · Estado: aceptada · Precisa la [0094](0094-la-ficha-de-la-clinica-con-sus-gastos-accion-por-accion.md) en lo que ve el rol Soporte

## Problema

Un caso de soporte lo sigue quien lo abrió; si esa persona deja la clínica, lo siguen la propietaria y los administradores. El acceso de diagnóstico solo lo autorizan ellos. Cuando recepción abre un caso y soporte necesita ver la configuración, el pedido le llega a quien no puede autorizarlo, y quien puede no ve el caso. El equipo tenía que redactar el pedido a mano en cada respuesta.

En la administración, el rol Soporte no recibe importes ni cobros (0094), pero los casos «Revisión de cobro» (0054), que llevan el importe en la pregunta, salían en su cola, en Conocimiento y en los conteos de Inicio.

Además, cuando un caso resuelto mostraba que su respuesta faltaba en la Ayuda, no quedaba dicho en ningún lado.

## Decisión y motivo

- **Desde que soporte pide el acceso, la propietaria y los administradores leen el caso y reciben el aviso.** «Pedir acceso de diagnóstico…» guarda `support_case.access_requested_at`, deja un mensaje fijo (dice quién lo autoriza si quien abrió no puede) y pasa el caso a «Esperando a la clínica». Desde ahí, `requireCaseReader` y `listMySupportCases` dejan entrar a la propietaria y a los administradores de hoy, y el aviso «necesita algo» les llega a cada uno (uno por persona y por hora). Son los únicos que pueden autorizar, así que el pedido les llega a ellos. El caso no se les abre antes: lo que pregunta recepción sigue siendo suyo mientras soporte no necesite nada de la clínica. Pedirlo dos veces sin que la clínica haga nada deja un solo pedido. Autorizar el acceso cuenta como respuesta de la clínica: el caso vuelve a «En atención».
- **Soporte no ve los casos de cobro.** Para ese rol no existen: ni en la cola, ni en la ficha y sus acciones (el mismo 404 que un caso que no está), ni en Conocimiento, métricas, Inicio o el número del menú. Los decide la administración con su respuesta (0054), y el rol Soporte no recibe lo que se cobra (0094).
- **«Falta en la guía» vive en `admin`.** Es una marca del equipo de odentIA sobre un caso (`admin.support_guide_gap`, una fila por caso) y no una columna de `support_case`, porque la clínica escribe en esa tabla. Se ve en «Para llevar a la guía» con la pregunta, el tema según la pantalla y la fecha, sin clínica ni conversación, como el resto de Conocimiento. «Ya está en la guía» la quita.

## Alternativas descartadas

- **Que la propietaria vea todos los casos de su clínica:** más simple, pero le abre lo que el equipo pregunta aunque soporte no necesite nada de ella.
- **Que el pedido solo diga «pídeselo a la propietaria»:** quien abrió tendría que reenviarlo a mano, y la propietaria no podría leer el caso que autoriza.
- **Mostrarle a soporte los casos de cobro sin el importe:** la pregunta y la conversación lo llevan; habría que tapar cada texto y cada correo, y el caso igual lo decide la administración.

## Consecuencias

- La propietaria y los administradores leen la conversación entera del caso pedido, también lo que escribió recepción antes del pedido. El mensaje fijo lo dice en la Ayuda de quien no puede autorizar.
- Si la propietaria cambia, el permiso de lectura sigue a la membresía de hoy, no a quien estaba al pedir.
- Revisar si las clínicas piden que el equipo vea un caso sin pedir acceso, o si el rol Soporte necesita atender casos de cobro.

## Referencias

- **Servicios:** `packages/services/src/admin-support.ts` (`requestSupportAccess`, `requireCaseReader`, `listMySupportCases`, `requireStaffCaseFor`, `markGuideGap`, `listGuideGaps`), `support-notices.ts` (`tickSupportNotices`).
- **Esquema:** `packages/db/src/schema/admin-support.ts` (`accessRequestedAt`, `supportGuideGap`).
- **Pruebas:** `packages/services/src/admin-support.test.ts`, `support-notices.test.ts`.
