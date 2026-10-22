# 0015 · El Administrador: líneas prendidas o apagadas, y un modelo que solo entiende lo que se le pide

Fecha: 2026-10-12 · Estado: aceptada · Sustituye a [0011](0011-asesor-sin-modelo.md)

## Problema

La clínica tenía dos listas para lo mismo: las detecciones del «Asesor», que solo recomendaban, y las «Automatizaciones», que enviaban mensajes desde otra pantalla con un formulario de reglas. Casi nada llegaba: el permiso de cada persona se daba a mano por canal, WhatsApp rechazaba el texto fuera de las 24 horas, la plantilla salía sin sus datos y cada envío fallido era un aviso suelto. Y en ninguna de las dos se veía con claridad quién hacía cada cosa: el agente o una persona del equipo.

El objetivo es una sola superficie, simple para una clínica mediana, donde quede claro qué pasa, quién actúa y qué ocurre cuando el agente no puede.

## Decisión y motivo

- **Un agente, una lista.** El «Asesor» pasa a llamarse **Administrador** y su página es la de las automatizaciones. Hay un catálogo fijo de líneas (`ADMIN_LINES`): cada una está **prendida o apagada**, con un interruptor. Una recomendación es una línea apagada que hoy tiene casos; una automatización es una línea prendida. No hay niveles intermedios ni un constructor de reglas.
- **Quién actúa se ve siempre.** Cada línea dice «Lo hace el agente» o «Le toca a una persona» y, abierta, dibuja su flujo con **solo lo que se ejecuta**. Tiene hasta dos partes con su interruptor: «el agente le escribe» y «tarea para el equipo».
- **Nunca termina en blanco.** Si el agente no puede escribirle a alguien, el caso se cierra con su motivo y el equipo recibe un aviso por causa, con cómo habilitarlo. Ese aviso no es una parte: no se apaga.
- **Nada cambia sin una persona.** Prender, ajustar, apagar y eliminar lo hace quien administra el agente. Prender solo actúa sobre lo que ocurra desde ese momento; lo de hoy se atiende con «Solo esta vez».
- **El sistema decide a quién, cuándo y por dónde; nunca un modelo.** El permiso es de la persona y sale del consentimiento de datos del registro. La vía es fija: WhatsApp como respuesta dentro de las 24 horas, el mensaje aprobado fuera, el correo de la clínica como respaldo. Lo que se escribe está declarado una vez (`AUTOMATION_MESSAGES`) y odentIA pide a WhatsApp su aprobación; los datos los pone el sistema al enviar. Cada clínica puede cambiar esos textos y todos se piden al conectar: [0019](0019-mensajes-de-whatsapp-de-cada-clinica.md).
- **Las cifras siguen saliendo de consultas** (lo que 0011 decidió y se conserva): los casos de hoy, lo que pasó con cada persona y los totales se abren con su lista, y respetan los permisos de quien lee.
- **El Administrador tiene modelo, con un papel acotado**: entender lo que se le pide con palabras y traducirlo a piezas que el sistema ya conoce (una línea del catálogo, sus partes, su plazo). Decide un modelo de decisión, con opciones cerradas, y recibe solo el texto del pedido; los números y las horas los extrae código. Lo que el modelo no reconoce se dice como «no se puede», no se inventa. El resultado es un borrador que una persona prende, guarda o descarta, con su flujo, una prueba con los últimos 30 días y una revisión que salen de consultas, no del modelo. Si el modelo no responde, lo prendido y los interruptores siguen igual.
- **«Crear» es prender una pieza que ya existe.** Además de las nueve líneas armadas hay piezas que el sistema sabe hacer y que una clínica solo tiene si las pide (`CUSTOM_LINES`; hoy, ofrecer otra fecha a quien cancela su cita). Son las únicas que se eliminan; las armadas se apagan.
- **Antes de un seguimiento se mira si la persona ya avisó algo.** Es la otra pregunta que responde el modelo de decisión (sí o no, sobre los últimos mensajes de esa persona). Con un «sí» no se le escribe; sin modelo, o si falla, se escribe como siempre. No aplica a recordatorios ni a lo que una persona aprobó o pidió «solo esta vez».
- **«Confirmar» no pasa por un modelo.** Los botones de un mensaje automático que el sistema puede resolver («Confirmar», «No enviar más») se resuelven con una operación y un texto fijo.

## Alternativas descartadas

- *Mantener dos pantallas (recomendar y automatizar)*: obliga a entender dos catálogos unidos a medias y esconde quién actúa.
- *Un constructor de flujos por arrastre*: la clínica mediana no arma reglas; lo que necesita es decidir si algo se hace y quién lo hace.
- *Una librería de diagramas*: los flujos son una línea con una rama; se dibujan desde datos con un componente propio.
- *Que un modelo redacte la explicación del borrador, su revisión o el resumen de cómo va cada línea*: son hechos de la clínica (el flujo, el estado de la plantilla, las cifras de 30 días) y se dicen mejor con textos del catálogo y consultas; así no cuestan por uso ni pueden contradecir a la pantalla.
- *Que el modelo redacte mensajes o elija destinatarios*: WhatsApp solo deja texto aprobado fuera de las 24 horas y un error de destinatario o de cifra no se puede comprobar.
- *Permisos por canal y finalidad, a mano*: doce botones por persona que nadie llenaba.

## Consecuencias

- Beneficio: una sola lista, un interruptor por línea y un flujo que dice quién actúa; cada mensaje que no sale deja su motivo y su corrección.
- Sacrificio: una línea nueva es código (catálogo, casos y, si escribe, su mensaje declarado y aprobado por WhatsApp). Pedir con palabras solo combina lo que ya existe.
- El coste del modelo se mide con una prueba real antes de abrirlo a una clínica: el mayor gasto no es entender pedidos sino las conversaciones que siguen cuando la persona responde con texto.
- Se revisa si las clínicas piden líneas que el catálogo no puede expresar, o si los flujos dejan de ser una línea con una rama.
- Desde [0023](0023-el-administrador-detecta-y-recepcion-habla.md) las nueve líneas siguen la misma regla: «Retomar una oportunidad» dejó su camino propio (corrida de coordinación y propuestas que aprobaba el equipo) y escribe con su mensaje del catálogo.

## Referencias

- `packages/services/src/admin-lines.ts`, `agent-admin.ts`, `admin-request.ts`, `admin-drafts.ts`, `automation.ts`, `automation-routing.ts`, `automation-messages.ts`, `channel-templates.ts`; `packages/agent/src/admin.ts`.
- `packages/ui-patterns/src/flow-diagram.tsx`; `apps/dental-clinic/src/routes/_org/agent.administrador.tsx`.
- Migraciones `0064` a `0068`. Issue darvin2c/odentIA#61.
