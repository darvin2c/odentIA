# 0232 · En gestorIA, cada forma de cobro con sus datos y Mercado Pago conectado entrando a la cuenta

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA · Configuración, de nuevo» (tableros 6, 12,
13 y 14; sobre el link de pago de B4 y la regla del tablero 24 del lienzo principal: sin pago
confirmado no se entrega)

## Problema

Cobros era una lista donde todo parecía igual (el link, Yape y el efectivo, con un interruptor) y
cada medio era un texto libre: Yape sin QR, la transferencia sin banco ni CCI. La pasarela pedía
pegar un «Access token» copiado del panel de Mercado Pago, no decía cuánto cobra y no dejaba probar
antes de cobrar de verdad.

## Decisión y motivo

- **Cada forma con sus datos** (`kind` en `store_payment_method`): Yape y Plin con su celular en
  E.164 (+51 y 9 números que empiezan con 9: funcionan con celulares del Perú), su titular y su QR;
  la transferencia con su banco (el código de entidad de la CCE, de una lista), su cuenta y su CCI;
  el efectivo y el POS al recibir, con una nota; «otro», con su texto, como antes. Cada forma lleva
  fijo su tipo de UN/CEFACT 4461 y su manera de confirmarse (lo exige también la base); el orden de
  cobro de Sofi no cambia. Lo que Sofi envía (`details`) lo arma el servidor con esos datos: Sofi
  lee lo mismo de siempre.
- **El CCI se revisa con sus dígitos de control**: 20 números (entidad, oficina, cuenta y dos
  dígitos), cada dígito con los pesos 1-2 alternados sobre la entidad y la oficina y sobre la
  cuenta (`cci.ts`), probado con CCI publicados. Y tiene que ser del banco elegido.
- **El QR va en la base, por su contenido** (`store_payment_qr`, JPEG, PNG o WebP mirados por sus
  primeros bytes), uno por Yape o Plin, como las fotos del catálogo. No se encuadra con
  `ImageAdjust`: lo que baja la app ya es el QR, y sus textos («Arrastra el logo») son de un logo.
- **Mercado Pago se conecta entrando a la cuenta** (OAuth 2.0 con PKCE, RFC 7636): gestorIA guarda
  el intento (el resumen SHA-256 de su `state`, quién lo empezó, el modo y el verificador), que vale
  10 minutos y una vez, solo para quien lo empezó; la vuelta (`/mercadopago/vuelta`) la completa la
  persona con su sesión. El token (180 días) y el `refresh_token` van cifrados con `secretos.ts` y
  nunca vuelven al navegador; cada hora se renuevan los que vencen en menos de 30 días.
- **Modo prueba, guardado** (`store_payment_link.mode`): la conexión empieza en prueba, con las
  credenciales de prueba (`test_token`), y solo sirve para el link de S/ 1 de la tienda
  (`store_payment_link_trial`), que queda pagado solo cuando Mercado Pago avisa y se le pregunta.
  En prueba ningún pedido se cobra por link, Sofi no lo ofrece, el aviso de un pago de prueba nunca
  paga un pedido y cada pedido lo dice. «Cobrar de verdad» vuelve a pedir el permiso, sin
  `test_token`.
- **El aviso `mp-connect` no se cree por lo que dice**: si una cuenta desvinculó la aplicación, se
  pregunta a Mercado Pago con el token de cada tienda de esa cuenta; solo si ya no lo reconoce queda
  «sin permiso» (`revoked_at`) y los links abiertos se olvidan.
- **Desconectar se confirma en un cajón** que dice cuántos links enviados dejan de confirmarse
  solos.

## Alternativas descartadas

- Seguir pidiendo el «Access token» (y la clave de los avisos): es lo que el usuario rechazó y lo
  que la pasarela no exige.
- Probar con el token real y un pago real de S/ 1: cobra comisión y dinero de verdad para una
  prueba; y si un link real se pagara en modo prueba, un pedido quedaría pagado sin dinero.
- Una tabla de formas aparte de `store_payment_method`: los pedidos copian el medio de ahí; con
  columnas nuevas y su regla en la base basta.
- Comprobar el CCI solo por su largo: un número cambiado pasaría y la clienta transferiría a otra
  cuenta.

## Consecuencias

- Variables nuevas: `GESTORIA_MERCADOPAGO_CLIENT_ID` y `GESTORIA_MERCADOPAGO_CLIENT_SECRET` (la
  aplicación de gestorIA en Mercado Pago, con la dirección de regreso de la app y el aviso de
  «Vinculación de aplicaciones» en `/avisos/mercadopago`). Sin ellas no se ofrece conectar.
- Las conexiones de antes (token pegado) siguen cobrando de verdad hasta que se desconecten.
- Lo de antes guardado como texto (un Yape escrito a mano) queda como «otro» hasta que la tienda
  lo complete.
- La comisión que se muestra es la publicada por Mercado Pago Perú en noviembre de 2026; cambia por
  rubro y contrato. El ida y vuelta con una cuenta real de Mercado Pago no se probó: las pruebas
  usan un proveedor controlado.
- Fuera de esta decisión: el tope de Yape por link (S/ 2 000) en lo que ofrece Sofi, Culqi y la
  página de Integraciones (tablero 5), y mandar el QR por el chat (los chats llegan con B2).
