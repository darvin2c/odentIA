# 0213 · La administración le pide a las apps, y el comprobante viaja en el acuerdo

Fecha: 2026-11-23 · Estado: aceptada · Pendientes de A4 (ADR 0211) y B7 (ADR 0212); tablero 3 y
decisión 7 del lienzo A

## Problema

El acuerdo (ADR 0211) tenía un solo sentido: la app avisa y pregunta. Faltaba lo que la
administración pide (abrir la cuenta de un cliente con su plan, dejar entrar a soporte, quitar a
una persona) y el comprobante de pago que el Dueño sube desde la tienda. Lo de cada app se queda
en la app (decisión 7): la administración conserva el botón que lo pide, sin leer ni escribir la
base del otro, sin hacer nada dos veces y todo apagado hasta configurarlo.

## Decisión y motivo

- **Lo que se pide va por el mismo acuerdo, al revés:** `adminRequest` de `@odentia/contract`
  (`cuenta.abrir`, `soporte.entrar`, `equipo.quitar`), firmado con el mismo secreto del par
  (`GESTORIA_CONTRACT_SECRET`) y enviado a `GESTORIA_CONTRACT_URL` + `/acuerdo/pedidos`. Los tipos
  de cada sentido no se cruzan: un mensaje de un sentido no vale en el otro.
- **La misma maquinaria de los avisos de la cuenta (ADR 0201):** el pedido se anota en la
  transacción de quien lo pide (`admin.app_contract_request`, con quién lo pidió), la API lo manda
  en el momento y el trabajador lo reintenta con la misma clave (`webhook-id` = su id) y la misma
  espera; los de una cuenta salen en orden. La app guarda la clave con su efecto
  (`contract_request_receipt`): repetido, responde lo mismo. Responde «hecho» o «falló» con su
  motivo (es la app la que sabe por qué); sin firma, caída o sin respuesta, se reintenta.
- **Abrir la cuenta de un cliente:** la administración abre su cuenta con el plan (su prueba
  empieza hoy) y una referencia nueva, y le pide a la app la tienda con ese id a nombre de su
  dueño, que ya tiene cuenta. La app crea la copia de su cuenta con lo que manda la
  administración (la pone al día su primer token) y avisa `cuenta.abierta`, que solo la pone al día.
- **Soporte entra solo si la tienda lo acepta**, como en las clínicas, donde la clínica autoriza:
  el pedido queda «por aceptar» 24 horas; el Dueño o un Administrador lo acepta, lo rechaza o lo
  saca. Entra con su propia cuenta única, solo a mirar (la tienda, su equipo y su catálogo, sin
  costos) y hasta 60 minutos. Lo que se lee con permisos que también escriben (pedidos,
  conversaciones, el plan) queda fuera. Cada paso queda en `store_event`.
- **Quitar a una persona** sigue la regla de la tienda: nunca su único Dueño. El motivo queda en
  `store_event`, a nombre de la administración.
- **El comprobante viaja dentro de su aviso** (`pago.comprobante`, en base64, hasta 1,5 MB, foto
  o PDF): la administración lo guarda en su almacenamiento con `submitSaasReceipt`, las mismas
  reglas y el mismo «por confirmar» de una clínica, con la clave del aviso como la del pago. Los
  dos lados miran el contenido, nunca el nombre ni el tipo que dice. Lo que la administración
  rechaza por lo que dice (cargo pagado, más de lo que falta) no se reintenta: el Dueño ve por qué.
- **La bandeja de gestorIA se limpia:** lo enviado y lo rechazado se borra a la semana, salvo el
  último `cuenta.abierta` de cada tienda (con él se sabe si hay algo nuevo que avisar).
- **Sofi en pausa o apagada deja la conversación «Espera a una persona»** con su motivo: el
  equipo la ve y la toma, en vez de quedar sin nadie.

## Alternativas descartadas

- **Un enlace firmado de corta vida al archivo:** obliga a la administración a ir a buscarlo a la
  app (otra ruta abierta, otra credencial y un archivo que vence antes de que llegue el reintento).
  En el aviso, el archivo llega con su clave y su firma, una vez.
- **Reutilizar `auth.account_event`:** es de la cuenta de una persona, en orden por persona y con
  su propio secreto; un pedido es de una cuenta de cliente y lo pide alguien del equipo.
- **Que soporte entre sin el sí de la tienda:** la tienda guarda los datos de sus clientes; en las
  clínicas tampoco se entra sin que la clínica lo autorice.

## Consecuencias

- Con `GESTORIA_CONTRACT_URL` vacío los botones lo dicen y no se pide nada; gestorIA no acepta
  pedidos sin su secreto.
- Solo la administración (rol `admin`) pide desde «Cuentas de otras apps»; quien pide entrar como
  soporte es quien entra. Que alguien con rol `support` lo pida desde Soporte queda para después.
- El tope del aviso a `/api/contract/events` sube a lo que pesa un comprobante; las preguntas y
  los pedidos siguen en 64 KB.
- Quedan para después: demos y la guía (tablero 3), y elegir o cambiar el plan o el tope desde
  gestorIA.

## Referencias

`shared/packages/contract/src/messages.ts`, `packages/services/src/app-contract-requests.ts`,
`packages/services/src/app-contract.ts` (`pago.comprobante`), `gestoria/apps/api/src/acuerdo-pedidos.ts`,
`gestoria/apps/api/src/soporte.ts`; migraciones `0154_la_administracion_pide_a_las_apps.sql` y,
en gestorIA, `0010_soporte_y_pedidos.sql` y `0011_reglas_soporte_y_pedidos.sql`.
