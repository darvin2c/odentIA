# 0031 · Cobro por acción, con un solo plan que vuelve en crédito

Fecha: 2026-10-15 · Estado: aceptada e implementada en cuatro fases (medir, contar, plan y avisos, cobrar); las cifras se validan con clínicas piloto (#80)

## Problema

La suscripción de hoy (`saas_plan`) cobra una cuota fija por plan con topes de sedes y personas, y no mide lo que hacen los agentes: `cost_micros` nunca se escribe. Cada llamada a un modelo le cuesta dinero a odentIA, y una clínica que usa mucho a los agentes cuesta más que una que no los usa. El software dental común se vende por una cuota baja (Dentalink parte de unos USD 29 en su versión más básica). Las clínicas medianas quieren algo simple y una factura que puedan comprobar.

## Decisión y motivo

- **Un solo plan, sin tamaños:** USD 29 al mes, que vuelven íntegros como crédito para las acciones de los agentes. Todo el sistema, sin límite de odontólogos, sedes ni cuentas: el tamaño de la clínica se refleja en el uso.
- **Se cobra por acción, cuando hay un resultado que la clínica reconoce:**
  - Conversación de Recepción, una por persona cada 24 horas (la atención de la ADR 0024): USD 0,50. Es la parte baja de los agentes de atención internacionales, que cobran entre USD 0,50 y 2 por conversación o resolución.
  - Consulta dictada y confirmada por el odontólogo (ADR 0012): USD 0,40. El borrador descartado no se cobra.
  - Cita recuperada: reservada dentro de los 7 días siguientes a un mensaje del Administrador, en su conversación o desde su enlace (ADR 0014 y 0023), y atendida: USD 4. Si salió de una conversación, la conversación queda dentro: se cobra en su tramo como cualquiera y, cuando la persona asiste, el cargo que cobra la cita la devuelve con una línea «Devolución», una sola vez (si el crédito la había cubierto, vuelve como crédito: la cita gasta su precio menos la conversación). Si aún no se había cobrado (el mismo tramo), no se cobra. Lo cobrado no se reescribe: si la cita no se da, no hay devolución.
  - Recordatorios, avisos al equipo y el sistema no se cobran aparte.
- **Descuentos solo en las acciones, nunca en la cuota,** y siempre junto al precio base. El vendedor da hasta 10 %; la administración de odentIA, hasta el precio mínimo (60 % menos: USD 0,20 por conversación). Ningún precio queda por debajo del doble de su peor costo, y el servidor lo comprueba.
- **Las cifras se configuran en la administración** (cuota, crédito, precio base, precio mínimo y cuánto descuenta el vendedor), sin tocar código y sin reescribir cargos ya emitidos.
- **Precios en dólares y sin impuestos;** la factura muestra el total con el impuesto del país (IGV en Perú).
- **El mes de cada clínica empieza el día que activa el plan.** Lo variable se factura cada mes o cada 15 días, según se configure por clínica.
- **Prueba:** 30 días del sistema y USD 100 de crédito de regalo, sin tarjeta, configurables por clínica hasta USD 130 y 60 días con aprobación. Si el crédito se acaba, los agentes se pausan. El crédito subió de USD 50 a USD 100 el 17 de octubre de 2026 para que la web lo ofrezca como llamada principal («Obtén USD 100 de crédito»); con las reglas de esta decisión (precio mínimo = 40 % del base y peor costo ≤ la mitad del mínimo), una prueba gastada entera en el peor caso le cuesta a odentIA como mucho USD 20.
- **Tope de gasto por clínica,** con aviso y alarma antes de llegar. Al tope, los casos nuevos pasan al equipo y el paciente siempre recibe respuesta (ADR 0021).
- **WhatsApp lo paga la clínica directo a Meta.** odentIA muestra una estimación y dice que depende por completo de Meta.

Así la clínica paga por lo que le da valor, entra por lo mismo que el software más básico y el ingreso crece con el uso. Con los costos medidos en #63, el margen queda por encima de 64 % en el peor caso: negociado al mínimo, con todo el crédito gastado en conversaciones y después de una comisión de vendedor del 10 %. Con Jev en toda clínica ([0047](0047-jev-decide-en-toda-clinica.md)) baja a 63 % solo si la clínica tiene unas 250 respuestas oficiales; los mensajes claramente ajenos a la clínica salen con un texto fijo y no se cobran.

## Alternativas descartadas

- *Planes por tamaño con cantidades incluidas:* cobran lo que no se usa, castigan al que más usa y obligan a elegir un tamaño.
- *Solo bajo demanda, sin cuota:* el sistema, que se usa todos los días, quedaría gratis y el ingreso dependería solo de los agentes.
- *Créditos abstractos o «neuronas»:* la clínica no sabe cuánto gasta cada cosa y raciona a los agentes.
- *Cobrar cada mensaje o cada acción del Administrador:* cobra lo que no dio resultado y frena los recordatorios.
- *Cobrar solo las conversaciones «resueltas»:* quien marca la conversación como resuelta es el propio agente, que sería el que cobra.

## Consecuencias

- Hay que medir el costo real de cada llamada, contar las acciones en una tabla propia y mostrar cada fila a la clínica: la factura suma esas filas.
- `saas_plan` deja de usar los topes de sedes y personas, y el cargo del mes necesita líneas por acción.
- Sacrificio: la factura varía cada mes y es más difícil de cobrar a mano. Una clínica con mucho uso paga bastante más que con un software básico, y hay que venderlo por resultados.
- Se revisa si el costo real supera un tercio del precio, si las clínicas piloto no reconocen las filas (#80) o si un proveedor cambia sus precios (#79).

## Referencias

- `packages/services/src/saas-billing.ts`, `packages/db/src/schema/saas-billing.ts`, `packages/agent/src/llm.ts`.
- Issues #63, #76 (Recepción directa a la cita), #77 (spam y reclamos), #78 (comisión), #79 (ajuste de precios), #80 (clínicas piloto) y #81 (competencia).
