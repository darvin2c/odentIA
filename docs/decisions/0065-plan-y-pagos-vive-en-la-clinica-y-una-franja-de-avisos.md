# 0065 · Plan y pagos vive en la clínica, y una franja de avisos

Fecha: 2026-10-19 · Estado: aceptada

## Problema

Plan y pagos estaba en el panel de la cuenta (`app.<dominio>/billing/<org>`). El motivo era que quien no pagó tiene que poder pagar aunque la clínica esté restringida. Pero la página no decía de qué clínica era. Solo se llegaba a ella desde el menú «⋯» del selector, que no se ve cuando se entra directo con una sola clínica, o desde un enlace que abría otra pestaña. Además, el panel tenía dos caras: el selector sin barra lateral y el resto con ella.

Los avisos de la clínica eran cuatro barras hechas a mano: dos de cobro, «Soporte tiene acceso» y «Recepción está apagada». Se apilaban y mostraban un solo aviso de cobro a la vez. Algunos llegaban a quien no podía hacer nada: el acceso de soporte lo veía todo el equipo.

## Decisión y motivo

- **Plan y pagos vive dentro de la clínica**, en Configuración › «Tu cuenta odentIA» › Plan y pagos (`/settings/plan`, y `/settings/plan/acciones` para «Cada acción»). También se llega desde el menú con el nombre de la clínica. Arriba lleva el nombre, la dirección y las sedes de la clínica. Lo ven propietario y administrador (`seesBilling`).
  - No hace falta abrir nada en el servidor. `decideSaasAccess` ya permite leer, la facturación y soporte en cualquier estado: solo lectura, en pausa o cancelada. Lo que se bloquea es guardar y que el agente responda.
  - Las direcciones viejas del panel redirigen a la clínica, y los correos siguen enlazando al panel, que redirige. Así el correo no necesita conocer el subdominio.
- **El panel es solo de la persona**: entrar, «Elige tu clínica», invitaciones, Mi perfil, soporte sin clínica y conectar WhatsApp. Ninguna de sus páginas tiene barra lateral; todas llevan la cabecera simple.
- **Una sola franja de avisos** (`NoticeStrip`), pegada arriba de la ventana y por encima de la barra lateral. Se muestra el aviso más grave; los demás, con «y N avisos más». Hay tres niveles con color sólido e ícono:
  - turquesa informa, y su X lo cierra hasta que sube de nivel;
  - ámbar pide actuar, y su X lo cierra por hoy;
  - rojo dice que algo ya se detuvo, y no se cierra.
  - En el teléfono ocupa una sola línea de 44 px con el texto corto.
- **Qué va en la franja:** lo que afecta a toda la clínica, sigue siendo cierto hasta que alguien actúa y tiene una acción. Lo que importa en una sola pantalla va en `PageNotice` dentro de esa pantalla, como «Recepción está apagada» o el tope alcanzado en la Bandeja.
- **El servidor decide qué ve cada persona** (`getClinicNotices`), según los permisos:
  - los montos y las acciones de cobro, solo propietario y administrador;
  - el tope alcanzado, también quien atiende conversaciones;
  - el día antes de pasar a solo lectura y mientras dure, todo el equipo, sin montos y con a quién avisar;
  - el acceso de soporte, solo propietario y administrador.
  - El selector de clínicas usa la misma regla.

## Alternativas descartadas

- *Plan y pagos en el panel, con el nombre de la clínica:* resuelve la duda de qué clínica es, pero sigue escondido y con dos caras.
- *Plan y pagos en el menú personal:* una persona puede administrar varias clínicas y cada una paga su plan; en el menú personal no se sabría cuál.
- *La franja solo fija cuando es roja:* con la barra lateral fija, una franja que sube con el contenido deja un hueco o la tapa. Queda siempre fija y delgada, y se puede cerrar cuando no es roja.

## Consecuencias

- La franja expone su alto en `--notice-strip-h`. La barra lateral, la columna lateral, `PageShell` y `MasterDetail` lo restan del alto de la ventana. Toda pantalla nueva que ocupe la ventana tiene que hacer lo mismo.
- Un aviso nuevo de la franja se agrega en `getClinicNotices`, con su público, su texto corto y su forma de cerrarse, y no en una pantalla. Quedan como candidatos WhatsApp desconectado (issue 121), sin conexión y el mantenimiento programado.
- Correos de cobro: se envían el día que llega el cargo, el día que vence y el día antes de pasar a solo lectura. El crédito solo manda correo al acabarse, y el tope desde el 90 %.

## Referencias

`packages/services/src/clinic-notices.ts`, `packages/ui-patterns/src/notice-strip.tsx`, `apps/dental-clinic/src/components/clinic-notices.tsx`, `apps/dental-clinic/src/routes/_org/settings.plan.index.tsx`, `packages/services/src/saas-billing.ts` (`decideSaasAccess`, ciclo de avisos).
