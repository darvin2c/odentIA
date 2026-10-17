# 0047 · Jev decide en toda clínica

Fecha: 2026-10-17 · Estado: aceptada · Precisa [0007](0007-modelo-de-decision-elige-el-conocimiento.md) y [0031](0031-cobro-por-accion-con-un-plan-que-vuelve-en-credito.md)

## Problema

Toda clínica nacía sin modelo de decisión (`agent_config.decision_provider = 'none'`). Ninguna pantalla lo cambia. Sin él, un mensaje ajeno («¿venden zapatillas?») lo responde el modelo que escribe y se cobra como conversación (USD 0,50), así que el que manda spam lo paga la clínica. El texto fijo de fuera de tema (ADR 0021) existía, pero ninguna clínica llegaba a él (darvin2c/odentIA#87). Tampoco se elegía el camino ni el conocimiento de cada turno. La web quiere decir «Los mensajes que claramente no son para la clínica no se cobran», y eso no era cierto.

## Decisión y motivo

- **Jev (`jev-1.13.0`) es el modelo de decisión de toda clínica:**
  - Lo es para las nuevas, con `DEFAULTS` del código y el valor por defecto de la columna, que también vale para la fila que crea otra operación sin decir el proveedor.
  - Lo es para las existentes con `none`: la migración `0008` las pasa a Jev. Todavía no hay clínicas reales.
  - Lo eligió el dueño del producto sin compararlo con OpenAI Decisions: es el proveedor medido (el umbral 0,9 de fuera de tema, ADR 0021) y cobra solo la entrada.
- **Cuesta centavos; lo que cambia es lo que se deja de cobrar.**
  - Jev cobra USD 0,042 por millón de tokens de entrada y no cobra la salida (docs.typesafe.ai, 2026-10-17).
  - Un mensaje lleva ~1 360 tokens (camino, conocimiento e interés): USD 0,000057.
  - Una clínica mediana gasta ~USD 0,05 al mes, y USD 0,77 en el peor caso (250 respuestas oficiales, ráfagas al tope).
  - Por cada persona que solo escribe algo ajeno, odentIA deja de cobrar USD 0,50. Ahorra USD 0,001 del modelo que escribe.
- **Los pisos de 0031 siguen en pie:**
  - El peor costo de una conversación pasa de USD 0,040 a 0,043, lejos de la mitad del mínimo (0,10).
  - En el peor caso del plan, el margen tras la comisión baja de 64 % a 63 %, solo con ~250 respuestas oficiales.
- **Sin la clave, o con la clave rechazada, odentIA se entera:**
  - La corrida sigue sin modelo de decisión: nunca se corta ni deriva.
  - Pero lo ajeno vuelve a cobrarse. Por eso la corrida abre o suma la clínica al caso automático «Modelo sin responder» de Soporte, con su motivo: `DECISION_KEY_MISSING` si falta la clave, `DECISION_REJECTED` si el proveedor la rechaza.
  - API y worker también lo dicen en el registro al arrancar.
  - La clínica no recibe aviso: no puede arreglarlo y su agente sigue respondiendo.
  - Con el modelo de demostración (`LLM_MODEL=fake`) no aplica.
- **odentIA puede apagarlo en una clínica concreta:** `decisionProvider` sigue en `PUT /agent`, como prevé 0007 si se equivoca estando seguro. Ninguna pantalla de la clínica lo muestra.

## Alternativas descartadas

- *Dejarlo apagado y quitar la frase de la web:* el mensaje ajeno se seguiría cobrando, también el spam, y se pierden el camino y la elección de conocimiento.
- *OpenAI Decisions:* cuesta 2,4 veces más y su umbral de 0,9 no está medido.
- *Que el modelo que escribe marque lo ajeno y no se cobre:* gasta igual ~9 000 tokens por mensaje, y decidiría qué se cobra el mismo agente que cobra.

## Consecuencias

- **Datos:** cada mensaje del paciente viaja a TypeSafe, solo lo que escribió y nada de la ficha. La revisión de tratamiento de datos que pedían 0017 y 0007 sigue pendiente antes de tener pacientes reales. TypeSafe tiene DPA y no entrena con lo que recibe; la retención cero solo la da a clientes empresa.
- **Desarrollo, e2e y pruebas sin clave:** cada corrida deja una fila «sin credenciales» en el libro de decisiones y se comporta como sin modelo de decisión.
- **Revisar si:**
  - Jev cambia su precio, o se fija otra versión. En ese caso, volver a medir con `eval:off-topic`.
  - Jev se equivoca estando seguro más de 1 de cada 20 veces.
  - El tráfico real muestra cuántos mensajes ajenos llegan: el supuesto del estudio fue 3 % típico y 10 % en el peor caso.

## Referencias

- `packages/services/src/agentConfig.ts` (`DEFAULTS`), `packages/db/src/schema/crm.ts`, migraciones `0007` y `0008`.
- `packages/agent/src/decision/outage.ts`, `packages/agent/src/run.ts`, `packages/agent/src/ai-usage.ts` (`AI_PRICES`).
- `apps/web/src/components/pricing/HowWeCharge.astro`, `apps/web/src/pages/precios.astro`.
