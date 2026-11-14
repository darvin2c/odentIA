# 0187 · Lo escrito a medias queda en el celular, un día

- **Fecha:** 2026-11-14
- **Estado:** aceptada (mesa de formularios del 13 nov, decisión 11, entrega 9).

## Problema

El paciente llena su registro, «Tus datos» o «Antes de tu cita» en su celular, y lo interrumpen: una llamada, «Tus pendientes», cerrar el navegador. Hasta ahora lo escrito vivía en la página (o en la pestaña, en el registro) y se perdía: unos 20 toques que rehacer (C8). Guardar lo que escribe, salud incluida, deja datos sensibles en algún lugar antes de que decida enviarlos.

## Decisión y motivo

Se guarda solo en ese celular (`localStorage`), con el paso en que iba, hasta enviarlo o 24 horas desde que empezó a escribir, lo que pase primero; la pantalla lo dice («Lo que escribas se guarda en este celular hasta que lo envíes, por un día») y al volver ofrece «Seguir donde ibas». Desde otro celular empieza en blanco.

- Solo lo que llega con un enlace personal (C8). El registro sin enlace (QR o web) no sabe de quién es y puede llenarse en la tablet que presta la clínica: queda en la pestaña (`sessionStorage`), se va al cerrarla, no se ofrece «Seguir donde ibas» a otra visita y no se promete el día.
- La clave es de la clínica, del enlace (la huella del token, nunca el token) y de la cita: otro enlace en el mismo navegador no ve lo de otra persona.
- Lo vencido se borra al leerlo y al abrir cualquiera de esas páginas; lo de un enlace que ya no sirve, también, y el enlace vencido lo dice en vez de «No perdiste nada».
- Solo lo escrito del formulario: ni archivos, ni el aviso de privacidad, ni lo de novedades (son decisiones de quien envía).
- Sin almacenamiento funciona igual y no promete guardar.

## Alternativas descartadas

- **En el servidor:** retomaría desde otro celular, pero lo vería cualquiera con el enlace, que se abre sin código y se reenvía (decisión 9); y sería un dato que la clínica guarda sin que el paciente lo haya enviado.
- **En la pestaña (`sessionStorage`), como antes:** se pierde al cerrar el navegador, que es justo el caso.
- **Sin vencimiento o renovándolo con cada tecla:** lo de salud se quedaría en un celular compartido mientras se siga tocando.

## Consecuencias

Quien vuelve en el mismo celular con su enlace sigue con un toque. A cambio, lo escrito queda hasta un día en un celular que puede ser compartido (la familia, la tablet de casa). Quien se registra sin enlace pierde lo escrito si cierra la pestaña: es el precio de que, en un equipo prestado, nadie vea lo de la persona anterior. Revisar si lo legal (datos de salud guardados en el dispositivo) pide otra cosa: está pendiente y nadie dio el visto bueno.

## Referencias

`packages/clinic-app/src/lib/device-draft.ts` y sus pruebas; `RegistrationQuestionnaire` (`draftKey`, `resume`); `personal-link-page.tsx` (`pendingItems` con `DraftOnDevice`, `?sigue=1`).
