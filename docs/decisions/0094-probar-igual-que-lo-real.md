# 0094 · «Probar» es una conversación real, marcada como prueba

**Fecha:** 2026-10-27 · **Estado:** aceptada

## Problema

«Probar», en la página de Sofi, era un camino aparte (`simulateAgentSandbox`): el mismo grafo con un hilo que no existía, el estado traído por la pantalla y unos 45 desvíos `ctx.sandbox`/`dryRun` en herramientas, grafo y corrida. Lo probado se alejaba de lo real. Por ejemplo, reservaba para una persona ficticia que en real no estaría registrada, dejaba proponer varias citas a la vez y no mostraba el aviso al pasar el caso a una persona. Tampoco dejaba ver si la cita se creaba de verdad. La clínica quiere probar exactamente lo que verá el paciente, en odentIA y en latidIA.

## Decisión y motivo

- «Probar» va por el recorrido real del chat web: ingesta, cola, worker y `processAgentRun`. Usa una conversación `is_test` con una persona de prueba ya registrada como paciente («Paciente de prueba») y `conversation.test_by_user_id` (quién la abrió).
- Lo que Sofi hace con el «sí» se ejecuta con las mismas operaciones. La marca es una sola: `contact.is_test`, que nace con la persona y no cambia (`contact_is_test_fixed`).
  - La base copia la marca a la cita (`appointment.is_test`, disparador `appointment_is_test`).
  - Su ficha usa un número de historia negativo de otro contador: no gasta números reales.
- Una cita de prueba no ocupa el horario de pacientes reales, pero sí choca con otra prueba. Por eso hay dos pares de exclusiones (`appointment_no_overlap_*` y `appointment_test_no_overlap_*`). `forTest` en la disponibilidad hace que una prueba vea la agenda real ocupada, como la vería un paciente.
- Nada sale hacia afuera y nada cuenta:
  - `enqueueJob` descarta los trabajos de una persona de prueba: recordatorios, avisos y seguimientos.
  - Las pruebas quedan fuera del calendario del profesional, la campana, Reportes, Inicio, Argos, Pacientes, Oportunidades, Tareas y el buscador.
  - La conversación de «Probar» queda fuera de la Bandeja y de «Te espera». La del chat web sí sale en la Bandeja, como antes.
- `delete_webchat_test` borra la prueba entera: conversación, citas, ficha y persona. Lo hacen «Borrar esta prueba», «Empezar de nuevo» o el paso de 7 días.
- Una prueba responde aunque Sofi esté apagada: se prueba antes de encenderla. Se cobra como `probar` y no cuenta como uso de una lección.
- «Probar una lección» responde cada caso en una conversación de prueba recién abierta, con la corrida real y la lección como `lessonOverrides`, y la borra al terminar.
- La interfaz es el chat del sitio (cabecera de color, burbujas, caja al pie):
  - En ventana ancha, en la columna lateral; donde no cabe, en el cajón estándar.
  - «Ver en la Agenda» abre la cita de prueba. En la Agenda va rayada y su cajón no ofrece «Llegó» ni «Atender»; el servidor también lo impide (`TEST_APPOINTMENT`).

## Alternativas descartadas

- **Conversación real sin ejecutar los actos:** Sofi decidía igual, pero la clínica no veía la cita creada y seguía diciendo «en la prueba no queda nada».
- **Una columna `is_test` en cada tabla:** multiplicaba los filtros y dejaba a cada vía la responsabilidad de marcar. La persona marca una vez y lo demás se deriva.

## Consecuencias

- Lo probado es lo real, incluidos sus límites. Por ejemplo, alguien sin ficha no recibe el enlace si la clínica no tiene el registro en línea.
- Cada consulta nueva que cuente citas, oportunidades, tareas o personas debe dejar fuera a las de prueba (`testContactSql`, `not a.is_test`).
- «Probar» pasa por el canal del chat web, con su formato, y no por WhatsApp. Si un canal llegara a responder distinto, habrá que probarlo también.

## Referencias

`packages/services/src/agent-probar.ts`, `packages/db/drizzle/0008_probar_igual_que_lo_real.sql`, `0009_probar_reglas.sql`, `packages/clinic-app/src/components/agent/test-chat.tsx`. Lienzo «Probar igual que lo real».
