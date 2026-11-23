# 0212 · gestorIA usa el acuerdo con la administración

Fecha: 2026-11-23 · Estado: aceptada · Paso B7 del lienzo B (sobre ADR 0211)

## Problema

Desde el paso 4 del lienzo A (ADR 0211) la administración puede abrir cuentas de otra app, contar
lo que usó y responder su estado, pero gestorIA no le decía nada: sus tiendas no tenían cuenta,
Sofi atendía sin que nadie lo cobrara y el Dueño no veía su plan ni sus cobros. Hacía falta que
gestorIA avise y pregunte sin contar nada dos veces, sin perder nada si la administración no
responde y sin detener la venta por ella.

## Decisión y motivo

- **Bandeja de salida en la base de gestorIA** (`contract_outbox`): cada aviso se guarda en la
  misma transacción que lo que lo causó (crear la tienda o cambiar su Dueño, la respuesta de Sofi,
  el pedido que tomó, la pregunta de ayuda) y un trabajo lo envía cada 30 segundos con su id como
  `webhook-id`. La clave no cambia al reintentar: la administración reconoce el repetido aunque se
  haya perdido su respuesta. Lo que falla se reintenta (30 s, el doble cada vez, hasta una hora);
  nada se descarta.
- **Una conversación se cuenta una vez por ventana de 24 horas** desde que Sofi la atendió con el
  modelo, como en las clínicas: la clave para la administración es la conversación y el inicio de
  su ventana. Si en esa ventana toma un pedido, se avisa «pedido» con la misma clave y sube de
  Informa a Gestiona. La conversación de «Probar a Sofi» y un turno que falló no se cuentan. La base
  solo deja anotar uso al agente, y el agente solo eso.
- **La app nunca se detiene por la administración:** gestorIA guarda lo último que supo de cada
  tienda (`contract_state`) y pregunta cada 10 minutos. Si no responde, sigue con eso; si nunca
  supo nada o la administración no conoce la tienda, deja trabajar y le avisa otra vez que se abrió.
  Solo Sofi se detiene, y solo en las conversaciones que se cobran, cuando la administración dijo
  que la cuenta no puede seguir, que se acabó el saldo de prueba o que llegó a su tope: la
  conversación espera a una persona, como con Sofi apagada.
- **«Plan y pagos» es solo del Dueño** (el permiso `plan` de la decisión 7 del lienzo B): plan,
  estado, gasto del periodo, cargos con sus líneas, pagos, avisos y pedir ayuda con sus respuestas.
  Los textos los escribe gestorIA a partir de los datos del acuerdo.
- **La tienda guarda su país** (ISO 3166-1, opcional al crearla): la administración cobra con su
  impuesto. El dueño que se avisa es el Dueño más antiguo de la tienda.
- La firma de gestorIA (`firma.ts`) pasa a ser la de `@odentia/contract`: una sola para la cuenta y
  la administración.

## Alternativas descartadas

- **Enviar en el momento, dentro del pedido:** si la administración tarda o cae, frena a Sofi o
  pierde el aviso; y un reintento sin clave guardada cuenta dos veces.
- **Preguntar el estado en cada turno de Sofi:** ata la venta a la administración; lo último
  guardado basta y nunca la frena.
- **Detener toda la app si la cuenta no puede seguir:** el lienzo pide no trabar la venta; el
  equipo sigue atendiendo a mano.

## Consecuencias

- Sin `GESTORIA_CONTRACT_SECRET` nada sale ni se pregunta: los avisos esperan y salen al
  configurarlo (también lo usado antes, como los avisos de la cuenta).
- Quedan para después, porque nadie en la administración los envía todavía: dejar entrar a soporte
  y quitar a una persona, abrir la cuenta de un cliente con su plan, el comprobante subido desde la
  tienda y elegir o cambiar el plan o el tope desde gestorIA (hoy se piden en «Pedir ayuda»).
- Actualización (ADR 0213): dejar entrar a soporte, quitar a una persona, abrir la cuenta de un
  cliente con su plan y el comprobante subido desde la tienda ya están; lo enviado se borra a la
  semana y la conversación que Sofi no atiende pasa a «Espera a una persona».
- Una tienda no cambia de nombre ni de país en B1: si llega a hacerlo, avisa `cuenta.abierta` en
  la misma transacción.

## Referencias

`gestoria/apps/api/src/acuerdo.ts`, `gestoria/apps/web/src/plan.tsx`,
migraciones `0008_el_acuerdo.sql` y `0009_reglas_acuerdo.sql` de `gestoria/packages/db`,
`gestoria/apps/api/src/acuerdo.test.ts`.
