# 0048. La contraseña olvidada se recupera con un enlace que deja adentro

- **Fecha:** 2026-10-17
- **Estado:** aceptada (lienzos «Acceso a odentIA» y «Recuperar el acceso», aprobados por el usuario).

## Problema

Recuperar la contraseña pedía seis pasos: pedir el enlace, abrir el correo, escribir la nueva en una página suelta, volver a entrar, escribir correo y contraseña otra vez y elegir la clínica. El enlace duraba una hora, servía varias veces dentro de esa hora, no cerraba las sesiones abiertas y no avisaba del cambio.

## Decisión y motivo

El correo trae un enlace de acceso: abre la sesión y, ya adentro, una ventana que no se cierra sin guardar pide la nueva contraseña (`packages/auth/src/access-link.ts`, `AccessLinkPasswordGate`). El enlace solo prueba que el correo es de la persona, lo mismo que probaba el de restablecer; lo que cambia es dónde termina.

- Dura 30 minutos, sirve una vez y pedir otro anula el anterior.
- Pedirlo responde igual exista o no la cuenta y solo escribe a cuentas que existen; como mucho tres pedidos cada 15 minutos por correo.
- Con segundo factor el enlace no basta: deja pendiente el código, como entrar con contraseña.
- Fijar la contraseña sin la anterior exige la marca del enlace, ligada a esa sesión y de 30 minutos. Al guardar se cierran las demás sesiones y llega un aviso por correo.
- Las contraseñas nuevas no pueden aparecer en filtraciones conocidas (Have I Been Pwned por k-anonimato, NIST SP 800-63B §3.1.1.2); si el servicio no responde, se aceptan.

## Alternativas descartadas

- **`magicLink` de Better Auth:** no anula enlaces anteriores, envía correo aunque la cuenta no exista y se salta el segundo factor.
- **`haveIBeenPwned` de Better Auth:** rechaza la contraseña cuando el servicio no responde; un tercero caído dejaría a alguien sin entrar.
- **Entrar siempre con enlace, sin contraseña:** es otra forma de entrar que hay que explicar; se deja para cuando se necesite (decisión 5 del lienzo).

## Consecuencias

Un correo comprometido da acceso a la cuenta durante 30 minutos, igual que antes daba la contraseña nueva; el segundo factor sigue siendo la defensa. Las rutas `/request-password-reset` y `/reset-password` quedan sin uso y `/reset-password` del panel lleva a «Este enlace ya no sirve». Revisar si se ofrece entrar con enlace sin contraseña o si el plazo de 30 minutos genera pedidos repetidos.

## Referencias

- `packages/auth/src/access-link.ts`, `packages/auth/src/password-breach.ts`, `packages/services/src/access-link.test.ts`.
- `apps/panel/src/routes/forgot-password.tsx`, `packages/ui-patterns/src/access-link-gate.tsx`.
