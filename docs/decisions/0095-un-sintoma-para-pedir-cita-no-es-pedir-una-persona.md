# 0095 · Contar un síntoma para pedir cita no es pedir una persona

**Fecha:** 2026-10-27 · **Estado:** aceptada

## Problema

Antes de responder, el modelo de decisión contesta «¿debe tomarla una persona?». Hasta `triage.v4`, la pregunta decía que sí ante cualquier dolor, sangrado, hinchazón o «situación clínica». La intención `clinical_question` también incluía «describe síntomas», y el manual de Recepción pedía pasar «el caso clínico».

Así, quien escribía «llevo días con dolor de garganta, ¿puedo sacar cita?» pasaba al equipo en vez de recibir horarios. En latidIA casi todo paciente cuenta un síntoma. Las conversaciones reales de «Probar» (ADR 0094) lo mostraron: 16 pasadas en 10 conversaciones de latidIA y ninguna cita.

## Decisión y motivo

- La pregunta `handoff` (`triage.v5`, `route.v5`) dice que sí en estos casos:
  - la persona pide hablar con alguien, se queja o está molesta;
  - pide un consejo clínico (qué tomar, si es grave, qué hacer);
  - cuenta algo que necesita atención ya (dolor fuerte, sangrado que no para, dolor de pecho, falta de aire, fiebre alta en un bebé, un accidente).
- Dice que no si menciona un síntoma solo para pedir cita, precio u horario.
- `clinical_question` pasa a ser el consejo o la emergencia, no el síntoma de quien pide cita.
- El manual de Recepción dice lo mismo: ofrece la cita, sin diagnosticar ni opinar sobre lo que siente.
- Las urgencias no cambian: su camino (`URGENT_SCORE`, ADR 0084) sigue igual.

## Alternativas descartadas

- **Subir `ROUTE_HANDOFF`:** con la pregunta vieja, el modelo de decisión marcaba 0,86–0,91 justo en estos casos. Subir el umbral también dejaría pasar quejas y pedidos de una persona.
- **Solo cambiar el manual de Recepción:** el camino «derivar» se elige antes, sin el modelo que escribe.

## Consecuencias

- Con Jev, en `eval/sintomas-y-cita.json` (15 ejemplos de los dos productos), «¿necesita una persona?» pasó del 40 % al 100 % de acierto.
- En los 38 ejemplos de siempre, la única diferencia es «se me cayó la corona». Sigue yendo al equipo porque su intención es clínica.
- `eval:urgencia-medica` (11 de 11 urgentes y ninguno de más con 1,8), `eval:off-topic` y `eval:spam` cumplen igual que antes.
- En conversaciones reales al azar, las pasadas bajaron de 8 a 4 en odentIA y de 16 a 4 en latidIA. Las citas subieron de 1 a 4 y de 0 a 3.
- Revisar si aparecen consultas clínicas que se agendan sin que nadie las vea.

## Referencias

`packages/agent/src/decision/points.ts`, `route.ts`, `graph.ts` (manual de Recepción), `eval/sintomas-y-cita.json`.
