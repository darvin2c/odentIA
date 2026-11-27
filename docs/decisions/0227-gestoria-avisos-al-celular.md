# 0227 · gestorIA avisa al celular con la app instalable, a cada rol lo suyo

Fecha: 2026-11-27 · Estado: aceptada · Entrega 5 del lienzo «gestorIA como odentIA» (tablero 15 y
decisión 9; sobre ADR 0177 y 0203)

## Problema

gestorIA era una pestaña del navegador: si nadie la tenía abierta, el Yape de una clienta esperaba
hasta que alguien entrara, y lo que no se entregó, hasta el día siguiente. Avisar por WhatsApp al
dueño necesitaría un mensaje aprobado por cada pago, que Meta cobra. odentIA ya avisa con su app
instalable y push web (ADR 0177), pero ese código vivía en las clínicas, que gestorIA no importa.

## Decisión y motivo

- **Lo del navegador pasa a lo común**: instalar, la compatibilidad, el permiso, la clave VAPID y
  suscribirse o apagar (`device-push` de `@odentia/ui-patterns`, con `createDevicePush`, al que
  cada app le pasa su servidor). Las clínicas lo usan igual que antes desde `pwa.ts`. El service
  worker es un archivo de cada app (`public/sw.js`): sin `fetch`, como el de las clínicas.
- **El celular es de la persona, no de la tienda**: la app es un solo origen
  (`app.gestoria24.com`), así que cada celular se activa una vez (`push_device`) y le llega lo de
  todas sus tiendas, con el nombre de la tienda si tiene más de una. Lo que elige vale en todos
  sus celulares y se guarda por tienda (`push_choice`), unido a su lugar en el equipo.
- **A cada rol lo suyo, desde `permisos.ts`**: `avisos.recibir` para todo el equipo (no soporte).
  Cada tipo pide el permiso de quien lo resuelve: pagos por confirmar (`pagos.confirmar`), chats
  que esperan (`ventas.atender`), lo que no se entregó (`entregas`), pedidos que armó Sofi
  (`ventas.atender`; a Ventas solo si lo elige) y lo de dinero (`reportes.ver`, Dueño y
  Administrador). Se mira al enviar: quien cambia de rol o deja la tienda deja de recibirlo.
- **No es otra bandeja**: avisa que llegó algo nuevo y abre el pedido que lo resuelve. Las
  fuentes son los pasos de los pedidos (`order_event`, con su `seq` como cursor) y los chats que
  Sofi pasa a una persona. El siguiente del mismo tipo reemplaza al anterior (`tag` y `Topic`).
- **Dice quién y cuánto** («Carla Mendoza envió su Yape de S/ 85»), a diferencia de las
  clínicas: en una tienda es lo que hace falta para saber si se abre ya.
- **Se anota antes de enviar**, en el servidor de gestorIA cada 20 segundos y en uno solo
  (candado de la base): lo que falla no se repite y el celular que el servicio ya no conoce se
  olvida. Claves VAPID propias (`GESTORIA_VAPID_*`): sin ellas no se ofrece.

## Alternativas descartadas

- WhatsApp al dueño por cada pago: mensaje aprobado y cobro de Meta por cada aviso.
- Copiar `pwa.ts` en gestorIA: dos versiones de lo mismo que se separan con el tiempo.
- Un celular por tienda: el navegador da una sola suscripción por origen.
- Una campana dentro de la app: lo pendiente ya está en Pedidos (y en «Te toca» cuando llegue).
- Avisos sin nombre ni monto, como en las clínicas: obligarían a abrir cada uno para decidir.

## Consecuencias

- Un cambio en `device-push` toca a las clínicas y a gestorIA: corre las pruebas de ambas.
- En iPhone llegan solo con gestorIA agregada a la pantalla de inicio (iOS 16.4 o posterior).
- Cerrar sesión los apaga en ese celular; cerrar la cuenta deja de enviarlos.
- Los chats todavía no tienen Bandeja: su aviso abre la tienda. Caja, Inicio y «WhatsApp no
  envía» suman su aviso cuando lleguen sus pantallas.

## Referencias

- `shared/packages/ui-patterns/src/device-push.ts`, `packages/clinic-app/src/lib/pwa.ts`.
- `gestoria/apps/api/src/avisos.ts`, `gestoria/apps/web/src/avisos.tsx`,
  `gestoria/apps/web/src/lib/avisos.ts`, `gestoria/apps/web/public/sw.js`.
- `gestoria/packages/db/drizzle/0024_avisos_al_celular.sql` y `0025_reglas_avisos_al_celular.sql`.
