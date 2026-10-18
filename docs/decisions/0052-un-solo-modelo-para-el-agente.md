# 0052 · Un solo modelo para el agente

Fecha: 2026-10-18 · Estado: aceptada · Sustituye a [0022](0022-la-clinica-elige-entre-dos-modelos-de-odentia.md)

## Problema

Con la 0022 la clínica elegía entre «ChatGPT 6» (`gpt-6-luna`) y «Claude 5.5» (`claude-haiku-5-5`), los dos con la cuenta de odentIA. El issue darvin2c/odentIA#131 revisó si Claude aportaba algo que justificara mantener dos modelos. Las mediciones del 2026-10-17 se hicieron con llamadas reales y con dictados y conversaciones inventados. Los dos modelos son el más barato de su proveedor y cuestan lo mismo por token (USD 0,10 de entrada y 0,50 de salida por millón). Aun así:

- **Dictado:** Claude dejaba sin ordenar o vacías las pausas largas (12 de 12) y las densas (5 de 5); ChatGPT 6 no perdió ninguna.
- **Recepción:** Claude dejaba sin enviar 9 de 39 respuestas y necesitó un arreglo propio. No se le puede obligar a usar la herramienta sin que deje de pensar, y Sonnet y Opus lo rechazan.
- **Costo:** una clínica mediana costaba más al mes con Claude (USD 8,00 frente a 7,19), porque Claude gasta más tokens para hacer lo mismo.
- **Pedido:** ninguna clínica lo pidió.

La razón de la 0022 para tener dos, «una alternativa si un proveedor falla», tampoco se cumplía. El cambio era manual y el dictado con Claude fallaba. Mientras tanto, cada arreglo y cada medición se hacían dos veces.

## Decisión y motivo

- **Un solo modelo para toda clínica, que elige odentIA:** «ChatGPT 6» (`AGENT_MODEL` en `packages/agent/src/llm.ts`). La clínica no lo elige ni lo ve en un ajuste; Integraciones y el encendido de Recepción solo dicen si responde.
- **La base no guarda ninguna elección:** se borra `agent_config.llm` (migración `0016_el_agente_usa_un_solo_modelo`), junto con la pantalla «Modelo del agente» y la acción «Usar el otro».
- **Fuera Anthropic:** se quitan su SDK, su cuenta (`LLM_ANTHROPIC_*`), su marca de caché y su precio. Anthropic deja de ser subencargado.
- **Si el modelo falla,** se aplica lo que ya estaba previsto: el caso pasa a una persona, la persona recibe el aviso fijo y Soporte recibe el caso automático «Modelo sin responder».

## Alternativas descartadas

- *Mantener Claude solo para Recepción y que el dictado use siempre ChatGPT 6*: se conservaba la mitad del mantenimiento sin una ventaja medida, y la clínica habría elegido un modelo que el dictado no usa.
- *Mantenerlo en todo y aprobar la variante del dictado sin pensar*: había que subir el peor costo declarado para quedar igual que ChatGPT 6.
- *Un modelo de nivel superior de cualquiera de los dos*: cuesta unas 20 veces más, y Sonnet además rechaza que se le obligue a usar la herramienta.

## Consecuencias

- Beneficio: una sola cuenta, un solo camino que medir y arreglar, y una decisión menos para la clínica.
- Sacrificio: si OpenAI falla, no hay otro modelo al que cambiar; los casos pasan al equipo hasta que vuelva.
- Revisar si una clínica necesita otro proveedor por exigencia legal o contractual, o si el costo o la calidad de OpenAI cambian. Volver a tener dos modelos exige antes medir con ellos el dictado y Recepción y mostrar que el segundo aporta algo.

## Referencias

- Issue darvin2c/odentIA#131 (mediciones y opciones).
- `packages/agent/src/llm.ts` (`AGENT_MODEL`, `resolveLlmSpec`), `packages/services/src/agentConfig.ts` (`AGENT_MODEL_LABEL`).
