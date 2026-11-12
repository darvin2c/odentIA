# 0184 · El ARM de la administración

Fecha: 2026-11-12 · Estado: aceptada · Extiende la [0062](0062-fundadores-alta-por-invitacion-y-precios-de-la-administracion.md) (la solicitud y la invitación) y la [0104](0104-cargar-los-datos-de-una-clinica-nueva.md) (la carga de una clínica nueva); muestra lo que hace la carga de la [0183](0183-la-carga-corre-en-el-servidor.md); sigue la [0063](0063-una-tabla-nueva-nace-cerrada-al-rol-de-la-app.md) y la [0064](0064-cada-tabla-en-el-esquema-de-su-dueno.md)

## Problema

Sallca vende odentIA, latidIA y vistIA, y en la administración cada momento de una clínica estaba en otra parte. La lista de espera tenía la solicitud de la web. Organizaciones tenía la cuenta. El seguimiento eran notas sueltas, y las llamadas y los mensajes de WhatsApp no quedaban en ningún lado. Una clínica que llegaba por una referencia o una feria no existía hasta que pedía su invitación. El equipo es chico: necesita que alguien ordene lo que sigue sin que ese alguien decida por él («Inteligencia que ordena, personas que deciden»). Y la carga de una clínica nueva la hace la skill en el servidor (ADR 0183), fuera de la pantalla: el equipo tiene que ver lo que hizo y lo que falta sin ir a buscarlo.

## Decisión y motivo

- **El cliente existe desde el primer contacto, en su propia tabla** (`admin.saas_client`), con sus contactos, tareas, oportunidades, propuestas, envíos, documentos y su historial. La solicitud de la web y la cuenta de la clínica pasan a ser del cliente (`client_id`): la solicitud crea o reutiliza su cliente, y la invitación aceptada o el alta asistida le ponen la organización. Las demos nunca son clientes. La bitácora (`saas_follow_up`) sigue siendo de solo agregar y ahora es del cliente. A una persona solo se la liga por su correo exacto y con el sí de alguien; nunca por su teléfono.
- **La etapa se calcula de los hechos y nunca se guarda**: venta abierta con propuesta enviada o invitación → propuesta; con presentación anotada → presentación hecha; con presentación agendada → presentación agendada; si no, contacto. Sin venta abierta, la decisión de la última; con cuenta, entró. Hay una sola regla en dos lugares que se prueban juntos: `clientStage` en TypeScript y `clientStageSql` en SQL. Así la etapa no se contradice con lo que pasó, y nadie la mueve a mano para que el embudo se vea mejor.
- **Kairós, el agente de la administración, solo prepara.** Pone tareas y señales, y deja en espera mensajes, datos, vínculos, resúmenes y guiones (`kairos_item`). Su estado es aparte del de lo que propone: en espera, ejecutado, incierto, fallido, descartado o vencido. Lo que espera vence a las 48 h. Además guarda el estado del cliente que vio al prepararlo: si el cliente cambió antes del sí, queda vencido y se prepara otra vez. Nunca envía ni decide: aprobar ejecuta la misma operación que la pantalla, y un correo aprobado lo envía la ruta como cualquier envío, sin reintentar si queda incierto. Lo que hace solo queda en `admin_audit` con `kairos.*` y sin actor. Al modelo le llega solo lo de la venta (clínica, ciudad, producto, nombres de contacto, lo hablado), nunca pacientes, importes ni adjuntos.
- **La carga la hace la skill en el servidor (ADR 0183); el ARM solo la muestra y avisa.** La ficha › Alta tiene los pasos calculados, el registro de la carga tal como lo deja la skill (`OrgLoadRecord`: cada carga con sus cifras y quién la hizo, y cada informe con su PDF) y lo que propone Kairós. No tiene botones de cargar ni de enviar, y los pasos salen del mismo registro (`listClinicLoads`, `listProgressReports`), nunca de una copia. Kairós avisa: cada carga queda en «Lo que hizo» con sus cifras y a nombre de quien cargó, y cada informe que salió también; si hay carga y no hay informe después, pone «Enviar el informe» al responsable; si un informe quedó «no se sabe si salió», pone la tarea urgente «Revisar en Zoho si salió el informe N.º n» en Hoy, que se cierra sola cuando queda enviado. Todo, una vez por clave.
- **Un informe que no se sabe si salió lo resuelve una persona, nunca un reintento.** Después de mirar en Zoho, Administración lo cierra como enviado («Revisé en Zoho: salió», la misma operación que `informe-salio` de la skill) o lo reenvía igual («No salió: reenviar»): el mismo número, el mismo destinatario, el mismo PDF guardado y el mismo correo, que van con la reserva desde el primer intento. Se reserva como el primer envío, una vez por pulsación; si vuelve a cortarse, queda otra vez sin saberse y vuelve la tarea.
- **El correo entrante llega por un Email Worker de Cloudflare.** Lo reciben `soporte@` y `contacto@` de los tres dominios (`infra/cloudflare/email-inbound`). Primero lo reenvía al buzón de siempre y después lo manda a `/api/inbound/email`, firmado con HMAC-SHA256 del instante y el cuerpo (`INBOUND_EMAIL_SECRET`, ventana de 5 minutos). Entra una sola vez por su Message-ID. Se liga al cliente por el correo exacto y, si hay dudas, queda sin cliente para que lo asigne una persona. Los adjuntos permitidos se guardan solo para Administración y se borran a los 30 días. Nadie ni nada los abre ni los manda al modelo.
- **El gasto de modelo de Kairós es gasto de Sallca**, en su propia tabla (`admin.kairos_ai_usage`), con el mismo medidor (`withAiMeter`). No va al `ai_usage` de las clínicas, que exige una organización y se cobra.
- **La propuesta con un descuento mayor al que puede dar el vendedor se aprueba en la misma propuesta**: queda «por aprobar» (`por_aprobar`) hasta que Administración la aprueba, y sus condiciones se aplican al entrar con las mismas operaciones de «Precio y prueba».

## Alternativas descartadas

- *Usar la solicitud o la organización como cliente.* La solicitud solo existe si la clínica la pide en la web, y la organización recién cuando entra. Lo de antes (referencias, ferias, llamadas) quedaría fuera, o la solicitud se volvería una ficha paralela.
- *Guardar la etapa y moverla a mano o arrastrando tarjetas.* Se desalinea de los hechos, y el embudo y los reportes medirían lo que alguien marcó y no lo que pasó.
- *Que Kairós envíe solo los mensajes de rutina.* Un mensaje a una clínica compromete a Sallca y no se puede deshacer. Mientras no se mida cuánto se aprueba sin cambios, cada envío pasa por una persona.
- *Que la skill deje borradores en la ficha para que una persona los apruebe y cargue en la pantalla.* Duplica el trabajo (la skill arma, la persona sube) y pide una llave más que guardar; la aprobación ya la da quien acompaña en el chat, y la carga corre en el servidor (ADR 0183).
- *Reintentar solo el informe que no se sabe si salió.* Si salió, la clínica lo recibe dos veces; lo dudoso lo mira una persona en Zoho.
- *Leer el buzón por IMAP desde el worker.* Necesita la contraseña del buzón en el servidor, lee tarde y no cubre `vistia20.com`, que hoy recibe en Namecheap. Email Routing ya recibe los otros dos dominios.
- *La negociación de siempre (`saas_negotiation`) para el descuento de una propuesta.* Exige una organización, y la propuesta es de antes de que la clínica exista.

## Consecuencias

- Una sola ficha por clínica, desde que se habla con ella hasta que paga y pide soporte. A cambio, todo lo que antes vivía en la solicitud o en la organización tiene que pasar por su cliente.
- Hay que mantener las dos versiones de la etapa iguales. La prueba de los servicios lo vigila.
- Lo que prepara Kairós a veces vence sin que nadie lo mire. Es el costo de no actuar sobre un estado viejo.
- El correo entrante depende de pasos a mano en Cloudflare y en Namecheap. Si el Worker falla, el correo sigue llegando al buzón de siempre.
- Revisar que Kairós envíe solo si, con el tiempo, casi todo lo que prepara se aprueba sin cambios. Revisar el WhatsApp de Sallca como bandeja cuando tenga su número en Meta.

## Referencias

- Servicios: `packages/services/src/admin-clients.ts`, `admin-sales.ts`, `admin-kairos.ts`, `admin-inbound-email.ts`, `admin-onboarding.ts`, `admin-client-files.ts`, `admin-reports.ts`.
- Esquema: `packages/db/src/schema/admin-arm.ts`; migraciones `0106_arm.sql` y `0107_arm_reglas.sql`.
- Agente: `packages/agent/src/kairos.ts`; pasada en `apps/worker/src/kairos.ts`.
- La carga y su registro: `apps/api/src/lib/clinic-load.ts`, `apps/api/src/routes/admin-imports.ts`, `packages/services/src/clinic-progress-report.ts` y `apps/admin/src/components/org-load-record.tsx` (ADR 0183).
- Correo entrante: `apps/api/src/routes/inbound-email.ts` e `infra/cloudflare/email-inbound/README.md`.
