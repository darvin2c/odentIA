# odentIA

Plataforma odontológica inteligente, centrada en el cliente y omnicanal. Monorepo pnpm 9.15 + Turbo; Node >=24 y TypeScript strict. Comentarios, errores y commits en español (`feat(scope): descripción`).

## Visión del software

Ser una plataforma que conecte la relación con el cliente y el trabajo de la clínica, con un agente que orqueste sus capacidades y una experiencia que haga sencilla esa coordinación.

Superar el CRM pasivo donde el equipo registra, busca y conecta todo manualmente. No intentar hacerlo todo ni acumular funciones: ofrecer capacidades conectadas que aporten valor. Esta visión orienta el desarrollo; no afirma que toda la autonomía esté implementada.

## Objetivo del software

Ayudar a la clínica a ofrecer una atención continua, oportuna y personalizada, coordinando información, comunicaciones y acciones alrededor de cada cliente, con menos carga operativa y control humano.

- Cliente como eje, no módulos ni registros. La omnicanalidad conserva la relación y el contexto al cambiar de canal.
- El agente es un orquestador, no un chatbot añadido: coordina y ejecuta dentro de las facultades concedidas y solicita intervención cuando corresponde. El equipo conserva el control.
- Antes de añadir una capacidad: ¿qué valor aporta al cliente o al equipo, cómo se integra con lo existente y justifica la complejidad que introduce? No incorporarla solo porque otros CRM la tienen.

## Objetivo de la UX

Permitir que cada usuario complete su trabajo con facilidad mediante una experiencia intuitiva, simple, minimalista y profesional, con el contexto y las ayudas necesarias en cada momento.

- «Menos es más»: menos esfuerzo, ruido y decisiones innecesarias; no menos capacidad ni menos ayuda. Presentar complejidad progresivamente, sin esconder lo necesario.
- Elegir interacciones por su utilidad, no por novedad. Arrastrar y soltar solo cuando facilite la tarea y con alternativa accesible; las ayudas son oportunas y contextuales.
- El usuario entiende qué ocurre, cómo avanzar y qué consecuencias tienen sus acciones. La conversación con el agente es una vía, no una obligación para realizar cualquier tarea.
- Conservar contexto y borradores, distinguir pendiente de confirmado y permitir recuperación ante errores. Accesibilidad WCAG, teclado y móvil forman parte de la facilidad de uso.
- Componentes, patrones y tecnologías son medios de implementación, no objetivos del producto o de la UX.

## Invariantes globales

- La persona es el centro: paciente ≠ interlocutor ≠ responsable. Estar centrado en el cliente no confunde esas identidades. Todos los canales convergen en la misma persona y su única historia clínica; nunca crear fichas paralelas ni verificar identidad por coincidencia de teléfono.
- Persona única: el contacto es la persona y el paciente su historia clínica; todo paciente es exactamente una persona y comparten identidad (`docs/decisions/0001-persona-unica.md`).
- Recepción coordina atención; clínicos atienden con contexto autorizado; caja gestiona cobros. Facilitar la tarea de cada rol sin exponer información ajena a sus permisos.
- Usar estándares internacionales y, cuando corresponda, nacionales. Justificar en el código cualquier desviación; no inventar formatos equivalentes.
- El núcleo conoce contactos, conversaciones y mensajes; los proveedores son adaptadores intercambiables.
- La organización es la frontera de aislamiento. Autorización en servidor y RLS; ocultar controles no concede ni restringe permisos por sí solo. Matriz canónica: `packages/auth/src/permissions.ts`.
- Una misma operación de negocio para recepción, portal y agente. No duplicar reglas en rutas, UI o herramientas del modelo.
- No reintentar efectos externos ambiguos como si fuera seguro duplicarlos. Aprobación humana, confirmación del interlocutor y ejecución son estados distintos.
- No presentar simulaciones, proveedores controlados o ausencia de errores como evidencia de éxito real ni de cumplimiento jurídico.

## Contexto bajo demanda

Leer el `AGENTS.md` del área antes de modificarla; sus reglas complementan este núcleo, no lo contradicen.

- `apps/AGENTS.md`: responsabilidades de panel, platform, API y worker.
- `packages/AGENTS.md`: límites de paquetes compartidos.
- `packages/services/AGENTS.md`: contratos e invariantes de negocio.
- `packages/db/AGENTS.md`: esquema, migraciones y catálogos.
- `packages/agent/AGENTS.md`: contexto, herramientas y autonomía.
- `packages/ui/AGENTS.md` y `packages/ui-patterns/AGENTS.md`: primitivas y composición de interfaz.
- `e2e/AGENTS.md`: aislamiento y verificación de recorridos.
- `.agents/skills/odentia-ux/SKILL.md`: usar al diseñar o cambiar interfaces y recorridos.
- `.agents/skills/odentia-arch/SKILL.md`: usar para stack, topología, tenancy, adaptadores y storage.
- `docs/development.md`: instalación, operación local y herramientas.
- `docs/decisions/README.md`: cuándo registrar una decisión y formato MADR breve.

## Trabajo y evidencia

- Consultar definiciones, referencias y tipos mediante LSP; código y contratos son la fuente de estructura, no inventarios manuales. LSP no sustituye ejecución ni autorización.
- Reutilizar patrones existentes. Nueva pantalla o entidad → extender `packages/services/src/seed-dev.ts` en el mismo cambio; nunca importar esa semilla manual en tests o CI.
- Verificar el recorrido afectado en runtime; para UI, observar la superficie real y sus estados. Informar exactamente lo ejecutado y sus límites.
- Comandos raíz: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm typecheck`; por paquete: `pnpm --filter @odentia/<paquete> test|typecheck`.
- Mantener contexto breve y sin duplicación: objetivos/reglas en AGENTS, procedimientos especializados en skills, motivos duraderos en ADR, ejemplos en código/stories. No crear `design.md`.
- Resultados de ejecuciones, tiempos, IDs y fallos transitorios van en el reporte o PR, no en instrucciones permanentes. Conservar aquí solo restricciones vigentes y referencias necesarias.
