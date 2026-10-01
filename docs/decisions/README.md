# Decisiones duraderas

Usar MADR breve cuando existan alternativas reales y consecuencias transversales o costosas de revertir: identidad, autorización, límites de dominios, contexto del agente o interacción compartida. No crear ADR por componente, corrección rutinaria o cada pantalla; no reconstruir motivos históricos sin evidencia.

Archivo: `NNNN-descripcion.md`, siguiente número libre. Objetivo: una página corta. Cada regla tiene una fuente principal: el ADR explica el porqué; AGENTS conserva la instrucción vigente y puede enlazarlo; código/stories muestran el contrato concreto.

## Formato

- **Título y fecha.**
- **Estado:** propuesta, aceptada o sustituida (enlace a sucesora).
- **Problema:** objetivo, restricciones y tensión que debemos resolver.
- **Decisión y motivo:** qué elegimos y por qué satisface mejor el objetivo.
- **Alternativas descartadas:** solo las relevantes y su coste.
- **Consecuencias:** beneficio, sacrificio y condición que justificaría revisar.
- **Referencias:** contratos, implementación o evidencia necesaria; no copiar informes completos.

Una propuesta no es una regla vigente. Al sustituir una decisión, enlazar ambas y actualizar las instrucciones afectadas; no dejar dos mandatos incompatibles. Los resultados de pruebas van en PR/reportes, no en ADR salvo evidencia imprescindible para la decisión.
