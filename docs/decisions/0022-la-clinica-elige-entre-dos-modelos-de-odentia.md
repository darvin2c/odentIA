# 0022 · La clínica elige entre dos modelos de odentIA

Fecha: 2026-10-14 · Estado: aceptada · Sustituye a [0016](0016-proveedor-llm-por-organizacion.md)

## Problema

Con la 0016 cada clínica podía traer su propio proveedor: URL base, clave cifrada, nombre del modelo escrito a mano y «Probar conexión». Eso dejaba a odentIA sin poder validar la calidad del agente (cada clínica podía usar un modelo que nunca probamos, con herramientas que quizá no maneja) ni responder por la privacidad de los datos de pacientes, que viajaban a un tercero elegido por la clínica. Las clínicas medianas, que son el público, quieren todo simple: una URL y una clave son una barrera y un lugar más donde equivocarse. Además, la búsqueda por significado (0021) ya mandaba la frase de la persona al proveedor de vectores de odentIA aun en clínicas con modelo propio: una excepción a lo que la clínica creía haber elegido.

## Decisión y motivo

- **odentIA pone la cuenta y la clínica elige uno de dos modelos validados:** «ChatGPT 6» (OpenAI, el de toda clínica) y «Claude 5.5» (Anthropic). La clínica ve solo esas etiquetas; el modelo exacto y sus opciones (como `reasoning_effort: "none"`, sin el cual `gpt-6-luna` rechaza herramientas) viven en el catálogo del agente (`LLM_CATALOG`) y odentIA los cambia sin que la clínica haga nada.
- **La base guarda solo la elección** (`agent_config.llm`, con un CHECK de los dos valores). No hay URL, clave ni nombre de modelo por clínica.
- **Dos proveedores con su SDK nativo** (`ChatOpenAI`, `ChatAnthropic`), con las claves de la plataforma por proveedor (`LLM_OPENAI_API_KEY`, `LLM_ANTHROPIC_API_KEY`). Sin la clave del proveedor elegido, el caso pasa a una persona con un motivo fijo y quien administra recibe el aviso que nombra la variable que falta; lo mismo que ya pasaba con credencial rechazada, cuota agotada o modelo inexistente, que ahora se reconocen en los errores de ambos SDK.
- **Con modelos que elige odentIA, que la búsqueda por significado use el proveedor de odentIA deja de ser una excepción.**

## Alternativas descartadas

- *Conservar el proveedor propio como opción avanzada*: mantiene el control de egreso (DNS, direcciones públicas, redirecciones), una clave cifrada por clínica y la imposibilidad de responder por la calidad, para un caso que ninguna clínica mediana pidió.
- *Un solo modelo, sin elección*: deja a la clínica sin alternativa si un proveedor falla o cambia sus condiciones.
- *Mostrar el nombre exacto del modelo*: obliga a la clínica a decidir cada vez que el proveedor publica otra versión.

## Consecuencias

- Beneficio: odentIA prueba y mide exactamente lo que usan las clínicas; elegir es un clic; desaparece el código de egreso controlado y de claves por clínica.
- Sacrificio: una clínica que quiera su propio acuerdo de datos con un proveedor no puede traerlo; odentIA asume el costo de los tokens y debe mantener las dos cuentas.
- Revisar si una clínica necesita un proveedor por exigencia legal o contractual, o si el costo de un modelo obliga a cambiar el catálogo.

## Referencias

- `packages/agent/src/llm.ts` (`LLM_CATALOG`, `resolveLlmSpec`), `packages/services/src/agentConfig.ts` (`AGENT_LLMS`).
- Migración `0076_modelo_elegido_de_dos`.
