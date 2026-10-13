# 0016 · Proveedor LLM por organización sobre un único protocolo

Fecha: 2026-10-08 · Estado: aceptada

## Problema

El agente debía «aceptar cualquier API de LLM», pero solo funcionaba el protocolo de OpenAI con una credencial única del servidor: la organización podía cambiar el nombre del modelo sin validarlo, un proveedor no instalado fallaba con un error opaco y acababa derivando conversación por conversación, y no había tiempos límite, reintentos acotados ni tope de gasto. Queremos que odentIA ofrezca un proveedor por defecto, que cada clínica pueda traer el suyo, y que el agente nunca pueda apuntar a la red interna ni mezclar credenciales.

## Decisión y motivo

- **Un solo protocolo: endpoint compatible con OpenAI.** Cubre OpenAI, OpenRouter, DeepSeek, Groq, Mistral, Ollama, vLLM y pasarelas propias con el adaptador ya instalado. Otros prefijos de `initChatModel` (`anthropic:`, `google-genai:`…) se rechazan con un error explícito en vez de instalar SDK por previsión; se añadirán solo cuando se vayan a usar y verificar.
- **Proveedor propio como par atómico.** La organización guarda URL base y clave juntas (CHECK en base de datos, clave cifrada con AES-256-GCM como las conexiones de canal). Nunca se combina una URL de la organización con la clave de la plataforma ni al revés. Un resolvedor único (`resolveLlmSpec`) sirve a corrida, simulación y prueba de conexión.
- **Egreso controlado para la URL de la organización.** Solo https y hosts públicos: validación sintáctica y DNS al guardar y al probar; en cada llamada el cliente resuelve el nombre al conectar y rechaza direcciones privadas (sin ventana entre comprobar y conectar), sin seguir redirecciones, y no envía cabeceras de organización o proyecto tomadas del entorno. La URL de la plataforma (`LLM_BASE_URL`) la fija el operador y no pasa por este control. `LLM_ALLOW_INSECURE_BASE_URL=true` relaja esto solo en dev/e2e.
- **Fallo de configuración como estado de la organización.** Credencial rechazada, modelo inexistente, petición inválida, cuota agotada o protocolo no instalado no reintentan: el caso pasa a una persona con un motivo fijo (el texto del proveedor nunca llega a recepción) y quien administra el agente recibe un aviso por problema y día. El tope diario de corridas por organización sigue la misma vía; se comprueba contando corridas ya registradas, sin bloqueo: con un solo worker en serie es exacto y con varias réplicas puede excederse por unas pocas corridas.
- **Cambios auditados** (quién, cuándo, qué campo) sin el valor de la clave; la lectura pública solo indica si hay clave.

## Alternativas descartadas

- Instalar los paquetes nativos de varios proveedores desde ya: exige subir versiones de LangChain, multiplica la matriz de pruebas y contradice «no introducir proveedores por previsión».
- Una pasarela (OpenRouter, LiteLLM) como única vía: añade un tercero en la ruta de datos de pacientes y reduce las garantías al mínimo común; puede usarse, pero como un endpoint compatible más.
- Credenciales solo de plataforma: impide a una clínica contratar su proveedor y asumir su propio acuerdo de datos.

## Consecuencias

- Beneficio: cualquier endpoint compatible con OpenAI funciona hoy, por plataforma o por clínica, con errores que se entienden y gasto acotado.
- Sacrificio: funciones nativas de otros proveedores (caché de prompt de Anthropic, modo estricto de Gemini) quedan fuera hasta instalar su protocolo.
- Revisar si una clínica necesita un proveedor sin API compatible con OpenAI, o si el modelo de decisión (ADR siguiente) exige credenciales distintas de las del chat.

## Referencias

- `packages/agent/src/llm.ts`, `packages/agent/src/llm-endpoint.ts`, `packages/services/src/agentConfig.ts`.
- Migración `0035`: `agent_config.llm_base_url`, `llm_api_key_encrypted`, `daily_run_limit`.
- Reglas vigentes en `packages/agent/AGENTS.md`.
