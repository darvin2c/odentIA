# 0232 · En gestorIA, cada forma de cobro con sus datos y Mercado Pago conectado entrando a la cuenta o con las claves de la tienda

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA · Configuración, de nuevo» (tableros 6, 12,
13 y 14; sobre el link de pago de B4 y la regla del tablero 24 del lienzo principal: sin pago
confirmado no se entrega)

## Problema

Cobros era una lista donde todo parecía igual (el link, Yape y el efectivo, con un interruptor) y
cada medio era un texto libre: Yape sin QR, la transferencia sin banco ni CCI. La pasarela pedía
pegar un «Access token» copiado del panel de Mercado Pago sin decir dónde estaba ni revisarlo, no
decía cuánto cobra y no dejaba probar antes de cobrar de verdad.

Actualización (28 nov): entrar a la cuenta necesita la aplicación de gestorIA en Mercado Pago, que
todavía no existe en producción; mientras tanto ninguna tienda podía conectarse. El dueño pidió que
cada tienda pueda conectar su propia integración sin depender de esa aplicación.

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
- **Mercado Pago tiene dos puertas.** La primera, **entrar a la cuenta** (OAuth 2.0 con PKCE, RFC 7636): gestorIA guarda
  el intento (el resumen SHA-256 de su `state`, quién lo empezó, el modo y el verificador), que vale
  10 minutos y una vez, solo para quien lo empezó; la vuelta (`/mercadopago/vuelta`) la completa la
  persona con su sesión. El token (180 días) y el `refresh_token` van cifrados con `secretos.ts` y
  nunca vuelven al navegador; cada hora se renuevan los que vencen en menos de 30 días.
- **La segunda, las claves de la tienda** (`connected_with = 'claves'`): el Access Token de su
  propia aplicación en Mercado Pago Developers, copiado de «Credenciales» con pasos numerados y los
  nombres de su panel. Sin la aplicación de gestorIA es la vía principal; con ella, un enlace
  discreto debajo del botón. Antes de guardarlo se revisa: la Public Key, el Client ID o el Client
  Secret se reconocen por su forma y se dice en el campo; «Probar» pregunta a Mercado Pago
  (`/users/me`) de qué cuenta es, sin guardar. Mercado Pago no dice en el token si es de prueba (hoy
  los dos empiezan con `APP_USR-`): para «Cobrar de verdad» se rechaza lo que sí se sabe de prueba
  (un `TEST-` o una cuenta marcada `test_user` o `@testuser.com`). El mismo token con el que ya
  prueba no se rechaza: si pegó el de producción para probar, no tendría salida. Va cifrado como el otro, no vence ni se renueva, y se pregunta una vez al día
  si Mercado Pago lo sigue reconociendo (`checked_at`). No se pide la clave secreta de los avisos:
  la dirección del aviso va en cada link y el pago se lee siempre de Mercado Pago.
- **Si Mercado Pago deja de reconocer el token** al usarlo (crear un link, el link de prueba, leer
  un pago) y lo confirma `/users/me` (un aviso con el pago de otra cuenta también da 401), o al
  revisarlo, la pasarela queda «sin permiso» (lo anota el sistema, solo si el token sigue siendo
  ese) y la pantalla dice cómo volver a conectar. Un 403 no cuenta: puede ser un bloqueo pasajero.
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

- Solo entrar a la cuenta: deja a todas las tiendas sin link de pago mientras no exista la
  aplicación de gestorIA, y ata cada tienda a ella.
- Solo pegar el token, como antes (sin pasos, sin revisarlo y con la clave de los avisos): la
  persona no sabía qué copiar ni si servía.
- Probar con el token real y un pago real de S/ 1: cobra comisión y dinero de verdad para una
  prueba; y si un link real se pagara en modo prueba, un pedido quedaría pagado sin dinero.
- Una tabla de formas aparte de `store_payment_method`: los pedidos copian el medio de ahí; con
  columnas nuevas y su regla en la base basta.
- Comprobar el CCI solo por su largo: un número cambiado pasaría y la clienta transferiría a otra
  cuenta.

## Consecuencias

- Variables nuevas: `GESTORIA_MERCADOPAGO_CLIENT_ID` y `GESTORIA_MERCADOPAGO_CLIENT_SECRET` (la
  aplicación de gestorIA en Mercado Pago, con la dirección de regreso de la app y el aviso de
  «Vinculación de aplicaciones» en `/avisos/mercadopago`). Sin ellas no se ofrece entrar a la
  cuenta; las claves sí.
- Con las claves, la tienda pega un token con todos los permisos de su aplicación: gestorIA lo usa
  solo para crear links y leer pagos, y lo dice. Un token de producción pegado como prueba no se
  puede reconocer: el link de S/ 1 no se podrá pagar con la tarjeta de prueba, y en prueba nada se
  cobra de verdad.
- Las conexiones de antes (token pegado) quedan como «claves» y siguen cobrando de verdad hasta que
  se desconecten.
- Lo de antes guardado como texto (un Yape escrito a mano) queda como «otro» hasta que la tienda
  lo complete.
- La comisión que se muestra es la publicada por Mercado Pago Perú en noviembre de 2026; cambia por
  rubro y contrato. El ida y vuelta con una cuenta real de Mercado Pago (por la cuenta o con las
  claves) no se probó: las pruebas usan un proveedor controlado.
- Fuera de esta decisión: el tope de Yape por link (S/ 2 000) en lo que ofrece Sofi, Culqi y la
  página de Integraciones (tablero 5), y mandar el QR por el chat (los chats llegan con B2).
