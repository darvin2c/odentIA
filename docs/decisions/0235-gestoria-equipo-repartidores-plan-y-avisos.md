# 0235 · En gestorIA, la invitación por WhatsApp, el pago del repartidor y «Plan y pagos» con lo que manda el acuerdo

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA · Configuración, de nuevo», tableros 9, 10
y 11 (sobre el repartidor del ADR 0228 y los avisos del ADR 0229)

## Problema

La invitación al equipo era un correo y un enlace para copiar: no decía a quién ni si ya se le
mandó. Los repartidores de fuera eran solo un nombre escrito en Despachos, sin celular ni lo que se
les paga, y no había cómo dejar de usarlos. «Plan y pagos» mostraba tres cifras sueltas («incluye
USD 5 de uso», «Gasto USD 24.60») y media página de formulario de ayuda, que ya está arriba, en
la Ayuda. La tarjeta para instalar la app estaba en Pedidos, que dejó de ser la entrada.

## Decisión y motivo

- **La invitación lleva nombre y celular** (`store_invitation.name`, `phone`, en E.164) y sale por
  el WhatsApp del celular de quien invita, con el mensaje escrito. Lo envía la persona: gestorIA
  anota solo que se abrió ese WhatsApp (`shared_at`, `shared_by`, `invitacion.enviada`) y lo dice
  «Enviada por ti por WhatsApp», nunca que llegó. Se sigue aceptando solo con la cuenta del correo
  invitado; la invitación no cambia lo que dice: se anula y se hace otra.
- **El repartidor de fuera lleva celular y pago por entrega** (`store_courier.phone`, `pay_cents` en
  la unidad menor de la moneda de la tienda, `failed_trip_paid`). Es un dato que anota la tienda
  para saber cuánto le debe: gestorIA no le paga, no lo descuenta ni lo suma a ninguna cifra. Lo
  ven y cambian el Dueño y el Administrador (`equipo.gestionar`); Ventas y soporte no ven lo que se
  le paga. «Sacar» lo deja de ofrecer y deja «sin repartidor» lo que todavía no salió con él (cada
  pedido con su línea en la historia); lo que va en camino sigue con él.
- **Sin link de repartidor todavía.** El link de un solo uso, aceptar con su cuenta y el aviso «Kevin
  se unió» son de gestorIA Reparto (tablero 23 del lienzo principal), que no existe: el mensaje de
  WhatsApp al repartidor no lleva link, y no se guarda «qué puede cobrar en la puerta» hasta que
  haya quien lo aplique.
- **«Plan y pagos» dice arriba, en una frase, lo que manda el acuerdo**: la cuota del plan, el saldo
  usado y lo que queda, si lo usado pasó el saldo y en cuánto (`budget.spentCents`, sin impuestos),
  cuándo cierra el mes, con qué se paga y el tope. gestorIA no suma ni calcula impuestos o precios:
  el total de cada cobro es el de la administración, en «Por pagar». Los movimientos por pedido (el
  1 % del tablero 18) no los manda el acuerdo hoy: la pantalla dice qué se verá, sin inventar
  filas. Cambiar el tope sigue siendo pedirlo a gestorIA: «Pedir otro tope» abre la Ayuda con
  el mensaje a soporte ya escrito, que la persona completa y envía.
- **La tarjeta para instalar y activar los avisos va en Inicio**, la entrada de la tienda.

## Alternativas descartadas

- Mandar la invitación por la API de WhatsApp de la tienda: cuesta mensajes de Meta y la tienda
  puede no tener WhatsApp conectado; desde su celular es gratis y lo ve salir.
- Una invitación para el repartidor con un link que todavía no lleva a nada.
- Escribir «el 1 % de cada pedido» en la pantalla: hoy la administración cobra lo que diga el plan
  cargado, y la app no lo sabe; lo dirá cuando el acuerdo mande la comisión y sus movimientos.

## Consecuencias

- Migraciones `0041_equipo_y_repartidores` y `0042_reglas_equipo_y_repartidores` (solo columnas y
  permisos de columnas nuevas en tablas que ya tienen sus reglas).
- Cuando exista gestorIA Reparto, su invitación enlaza el mismo `store_courier` a la cuenta del
  repartidor, con el pago ya anotado.
