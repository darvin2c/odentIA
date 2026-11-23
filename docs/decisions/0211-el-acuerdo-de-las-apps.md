# 0211 · El acuerdo de las apps con la administración

Fecha: 2026-11-23 · Estado: aceptada · Paso 4 del lienzo A («una sola administración para todas las apps»)

## Problema

Desde el paso 3 (ADR 0210) la administración puede guardar una cuenta de cliente sin clínica, pero
gestorIA es otro sistema, con su base y su servidor: no puede escribir en las tablas del cobro ni
leer si su tienda puede seguir. Hacía falta el acuerdo del tablero 3: lo que la app avisa, lo que
pregunta y lo que la administración responde, sin que nadie lea la base del otro, sin contar nada
dos veces y sin que la app se detenga si la administración no responde. Y antes de la primera
cuenta de otra app, separar lo que el cobro daba por hecho de una clínica.

## Decisión y motivo

- **El acuerdo es un paquete de uso general** (`shared/packages/contract`, `@odentia/contract`):
  los mensajes con su esquema (zod) y la firma. La firma es la de los avisos de la cuenta
  (Standard Webhooks, ADR 0201), que se mudó aquí y `@odentia/auth` reexporta: una sola para los
  dos sentidos.
- **La app avisa** a `POST /api/contract/events`, en su dominio, firmado con su propio secreto
  (`GESTORIA_CONTRACT_SECRET`, otro que el de los avisos de la cuenta: la administración y la
  cuenta se separan en los pasos 6 y 7): `cuenta.abierta` (abrió o cambió una cuenta: nombre,
  país ISO 3166-1 y dueño), `uso.contado` (una conversación atendida, que sube si tomó un pedido) y
  `soporte.pedido`. **Pregunta** a `POST /api/contract/state` el estado de una cuenta: si puede
  seguir, lo que detiene al agente por dinero (saldo de prueba o presupuesto), su gasto del tramo,
  su plan, cargos con líneas, pagos, los avisos que debe mostrar y las respuestas de soporte.
  Datos, no frases: los textos los escribe la app. Sin secreto (o sin `GESTORIA_DOMAIN`), esas
  rutas no existen.
- **Nada se cuenta dos veces:** la clave de cada aviso (`webhook-id`) queda en
  `admin.app_contract_message` en la misma transacción que su efecto. Repetido, se responde
  «repetido» sin tocar nada; si el efecto falla (una cuenta que no existe), no queda la clave y la
  app reintenta con la misma. Una conversación es una sola acción por su clave en la app.
- **La app cuenta y la administración cobra:** lo usado se guarda en `saas_action` y se valora con
  el plan de la cuenta. «Atendida» es el precio de Informa y «tomó un pedido» el de Gestiona (las
  mismas columnas del plan); en la línea del cargo se dicen con esas palabras. El impuesto es el
  del país que dijo la app, como el de una clínica.
- **Los planes de una app llevan la app en su producto** (`saas_plan.product = 'gestoria'`): todo
  lo que busca planes de una clínica filtra por su producto y nunca los ve, y el código de antes
  sigue leyendo la tabla igual. Una cuenta de otra app solo tiene suscripción con un plan de su
  app: abre con el plan por defecto de su app o, si no hay, sin suscripción (no se le cobra) hasta
  que la administración le asigna uno. Así nunca cae en el plan de lista de una clínica.
- **El ciclo del cobro no cambia para las clínicas:** el de una cuenta de otra app corre en el mismo
  reloj; no tiene propietarios en `member`, así que sus avisos se guardan sin correo y los muestra
  la app. Solo al cerrar su mes se lee la cuenta (sin perfil de clínica) para su país y sus
  palabras.

## Alternativas descartadas

- **Una columna `app` en `saas_plan` con el producto nulo:** el código ya desplegado lee la fila
  entera del plan; con una columna nueva, la imagen anterior y las pruebas de migraciones viejas
  dejan de leerla. El producto ya dice «de quién es el plan».
- **El mismo secreto de los avisos de la cuenta:** ataría la administración a la cuenta justo antes
  de separarlas.
- **Que la app mande el precio o el importe:** rompe «la app cuenta, la administración cobra».

## Consecuencias

- gestorIA (entrega B7) consume el acuerdo: guarda lo último que supo de cada tienda y sigue con
  eso si la administración no responde.
- Quedan para después: lo que la administración pide a la app (abrir la cuenta de un cliente con
  su plan, demos, entrar como soporte, quitar a una persona, la guía), el avance del alta y el
  comprobante subido desde la app (hoy lo registra la administración).
- Las clínicas pasan a usar el acuerdo en el paso 5.
- Actualización (ADR 0213): la administración ya pide abrir la cuenta de un cliente con su plan,
  dejar entrar a soporte y quitar a una persona, y el comprobante llega desde la app.

## Referencias

`shared/packages/contract`, `packages/services/src/app-contract.ts`,
`apps/api/src/routes/app-contract.ts`, migración `0153_el_acuerdo_de_las_apps.sql`,
`packages/services/src/app-contract.test.ts` (el ciclo de las clínicas igual que en `main`).
