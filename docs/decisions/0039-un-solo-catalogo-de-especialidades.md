# 0039 · Un solo catálogo de especialidades y la agenda ofrece a quien atiende

Fecha: 2026-10-16 · Estado: aceptada · Precisa: [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md) · Actualizada por [0069](0069-biblioteca-de-servicios-por-pais.md): la clínica nace con las especialidades de su país (en el Perú, las del DS 023-2020-SA y Odontología general), no con las 14 de la biblioteca; las claves de la biblioteca pasan a ser tipos de tratamiento internos, y cada especialidad del país dice qué tipos recibe.

## Problema

Había dos listas de especialidades: la fija de la biblioteca (14 claves, copiada a mano en la pantalla de Servicios) y la que creaba cada clínica en Configuración › Especialidades. El servicio usaba la primera y el profesional la segunda. Además, un vínculo entre servicio y especialidad de la clínica solo lo leía su propia pantalla. Así, el agente tenía que adivinar que «Prótesis» y «Rehabilitación oral» eran lo mismo, y la agenda ofrecía a cualquiera para cualquier servicio. Si alguien pedía «el especialista en endodoncia», podían salir 20 horas del general y ninguna de la endodoncista.

## Decisión y motivo

- **Una lista, la de la clínica.** `org_specialty` nace con las 14 de la biblioteca (`LIBRARY_SPECIALTIES`, con la misma clave) al crear la clínica, y la clínica puede renombrarlas, archivarlas o agregar otras. Lo que se muestra es siempre el nombre de la clínica: en Servicios, en la biblioteca, en el índice del agente y en la agenda.
- **Cada servicio tiene una sola especialidad** (`service_catalog.specialty_id`, con clave compuesta por organización). Se elige en el formulario del servicio. Un servicio de la biblioteca se resuelve por la clave de su plantilla, y la clínica puede cambiarla. Las palabras de la calle del índice («matar el nervio») van con la clave, así que una especialidad renombrada no las pierde.
- **La agenda ofrece solo a quien atiende el servicio.** Es una sola regla (`attendingRule`) en `listAvailableSlots` y en la vista de la agenda, la misma para recepción, el enlace de reserva, el portal y el agente. Si el servicio tiene una especialidad activa y alguien adscrito a ella tiene horario en esa sede, solo se ofrecen sus huecos. Si no, se ofrece a cualquiera, como antes, y Especialidades lo avisa con «Elegir quién atiende».
- **Huecos por hora y repartidos.** Los huecos se ordenan por hora, mezclando a los profesionales. El agente recibe hasta tres por profesional y día, repartidos en su jornada: el primero, uno a media jornada y el último. También recibe un identificador del profesional que solo sirve para pedir sus horas: así funciona «quiero cita con la Dra. Rojas».
  - Actualización del 2026-10-29: antes recibía los dos primeros de cada uno. Una clínica reportó que Sofi ofrecía una o dos horas por doctor, siempre a primera hora y casi pegadas, y nunca la agenda para ver el resto. En las rondas de la auditoría del issue #328 pasaba en todas las conversaciones. El reparto lo hace la agenda (`perProfessionalPerDay`) antes de su tope de 200 huecos, para que el tope cuente lo que se ofrece y no corte días.
  - La agenda va con los horarios. La clínica pidió que, cada vez que Sofi ofrece horarios, vaya el enlace para que la persona vea toda la agenda y elija con quién, en odentIA y en latidIA. Lo agrega el código al enviar la respuesta, como una línea fija en el idioma de la persona y neutra en el trato. El enlace se emite solo entonces, con la sede y el servicio de la búsqueda, y el mensaje guarda su referencia, no el token (ADR 0037). No va cuando la página no serviría para reservar: con la cita que la corrida propone, mueve o confirma, con otra esperando el sí, al cambiar una cita o si el paciente ya tiene una por venir. Reservar por el enlace deja vencida la cita que esperaba el sí, para que su «sí» de después no reserve otra.

## Alternativas descartadas

- *Varias especialidades por servicio* («Corona sobre implante» en Prótesis y en Implantología): complica la regla de la agenda y la pantalla, y no aporta a una clínica mediana.
- *Sin nadie adscrito, no ofrecer horas y pasar el caso a una persona*: castiga a la clínica que todavía no terminó de configurar.
- *Mantener la lista fija para los servicios y mapearla a la de la clínica*: deja dos fuentes y una correspondencia que alguien tiene que mantener.
- *Darle al agente el usuario del profesional*: lo expone sin necesidad; el identificador opaco basta para pedir huecos.
- *Que `buscar_huecos` traiga el enlace y el modelo lo copie, con una reescritura si falta*: en la auditoría salió en 33 de 35 ofertas, pero cada olvido costaba otra llamada. Además, una herramienta de lectura emitía y reconfiguraba el enlace en cada búsqueda, el token pasaba por el modelo y quedaba guardado en la memoria del caso, y la frase había que pedirla en el trato y el idioma de la persona.

## Consecuencias

- Beneficio: recepción, el enlace y el agente ofrecen las mismas horas, de quien de verdad atiende; el agente nombra las especialidades como la clínica.
- Sacrificio: si la clínica marca a un especialista y olvida a los generales que también hacen ese servicio, la agenda deja de ofrecérselo a ellos. El aviso de Especialidades y el contador de servicios ayudan a verlo. Reservar a mano con otro profesional sigue permitido: la regla decide qué se ofrece, no qué se puede guardar.
- Revisar si las clínicas piden servicios compartidos por dos especialidades.

## Referencias

- `packages/services/src/specialties.ts` (`ensureClinicSpecialties`, `librarySpecialtyIds`, `attendingRule`; antes `ensureLibrarySpecialties`), `availability.ts` (`listAvailableSlots`, `getAgendaAvailability`), `agent-operations.ts` (`findFreeGaps`), `agent-clinic-info.ts` (`professionalRef`, `formatServiceIndex`), `service-catalog.ts`; migración `0099_una_lista_de_especialidades.sql`; lienzo de la fase 4, tablero 2, decisiones 1, 2, 3 y 16.
