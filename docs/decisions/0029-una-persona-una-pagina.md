# 0029 · Una persona, una página

Fecha: 2026-10-15 · **Estado:** aceptada (tablero 2, versión 2, y decisión 6 de la fase 2)

## Problema

La misma persona tenía dos páginas: la de contacto (`/contacts/:id`, a la que llevaban la Bandeja y Tareas) y la ficha del paciente (`/patients/:patientId`, a la que llevaban la Agenda, Caja y Reportes), con dos listas, dos formularios con reglas distintas (el del contacto saltaba la regla del menor y fallaba con pasaporte), dos indicadores de archivado y unas trece formas de elegir a una persona. Al registrar a alguien sus enlaces cambiaban de página. El ADR 0001 ya dice que el contacto es la persona y el paciente su historia clínica; faltaba que la interfaz y sus direcciones lo respetaran.

## Decisión y motivo

- **Una página por persona en `/people/:personId`, con el id del contacto.** Es la única clave que existe desde el primer mensaje, la misma antes y después de registrarla (ADR 0001: no toda persona es paciente, todo paciente es exactamente una persona). La ficha clínica se añade a esa página al registrarla: Clínica, Plan y Cobros aparecen en la misma dirección. El número de historia sigue siendo el de la ficha (ADR 0004).
- **Las direcciones viejas solo redirigen, conservando la búsqueda:** `/contacts/:id` al mismo id; `/patients/:patientId` busca a su persona (`/api/people/by-patient/:patientId`) y conserva `?tab=`; las listas `/contacts` y `/patients`, a `/people` con su vista. La atención y las impresiones siguen colgando de `/patients/:patientId/...`: son documentos de la historia, cuya clave es la ficha.
- **Cada bloque se pide con su propio permiso; ninguna ruta lo trae todo.** La cabecera y la lista piden `patients.read`; las conversaciones, `conversations.read` (odontología las ve sin el CRM); las notas, el CRM; lo clínico, el plan y los cobros siguen en `/api/patients/:id/...` con los suyos. La base solo separa por organización (RLS), así que la separación por rol vive en estas rutas y tiene pruebas por rol.
- **Abrir la página no es una lectura clínica.** `GET /api/patients/:id` entrega la ficha administrativa y las alergias a quien las ve; condiciones, medicación y salud declarada viajan solo con `?clinical=1`, y solo esa lectura y las de Clínica y Plan dejan traza en la bitácora.
- **Un solo formulario de datos**, el de la ficha, y una sola regla (`updatePersonIdentity`, con `validateDemographics` y la regla del menor si es paciente), use quien use la vía: página, CRM o agente.
- **Un solo «Archivar»** (`setPersonArchived`): mueve los dos indicadores juntos. No hace falta una migración: son los dos únicos escritores y ahora pasan por esta operación; al leer, se da por archivada a la persona si cualquiera de los dos lo está, lo que cubre lo que quedó desalineado antes (no hay datos reales que conciliar).

## Alternativas descartadas

- **Mantener `/patients/:id` y mezclar en el mismo parámetro ids de ficha y de persona.** Una dirección con dos significados obliga a adivinar cuál es y se rompe en cuanto un id coincide; además deja a quien no es paciente sin dirección propia.
- **Usar el id de la ficha como clave.** Quien aún no es paciente no tiene ficha, y su dirección cambiaría al registrarla, que es justo lo que se quiere evitar.
- **Un endpoint que entregue la página entera.** Tendría que repetir las guardas de cada subdominio (filiación, clínica, caja) y bastaría un descuido para entregar a un rol lo que no le toca.
- **Un disparador que sincronice `is_active` en la base.** Es más robusto ante escritores futuros, pero añade una migración que hoy no hace falta; si aparece otro escritor, se reconsidera.

## Consecuencias

- Beneficio: un solo destino para todos los enlaces, una lista y un buscador (`PersonPicker` sobre `/api/people`), registrar sin salir de la página y con lo que ya se sabe, y odontología sin errores 403 en la página.
- Sacrificio: la identidad sigue duplicada físicamente (ADR 0001) y los dos indicadores de archivado siguen existiendo; las partes de la ficha que solo conocen al paciente llegan por una redirección (sin petición extra cuando la página ya está abierta).
- Revisar si se retiran las columnas de identidad y de archivado de `patient`, o si una norma exige otra clave para la historia.

## Referencias

`packages/services/src/people.ts`, `apps/api/src/routes/people.ts` (y sus pruebas por rol), `apps/platform/src/routes/_org/people.$personId.tsx`, `apps/platform/src/lib/patient-areas.ts`, ADR 0001 y 0004.
