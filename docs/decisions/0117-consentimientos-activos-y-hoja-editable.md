# 0117. Consentimientos activos desde el inicio y editados sobre su hoja

- **Fecha:** 2026-10-31
- **Estado:** aceptada.

## Problema

Para firmar un consentimiento por la web, cada clínica tenía que agregar los textos sugeridos, revisarlos, publicarlos y unirlos a sus servicios. Mientras no lo hacía, firmaba en papel y el presupuesto salía sin riesgos ni alternativas. La pantalla abría además en «Formularios clínicos», vacía, aunque lo que un formulario preguntaría sobre la salud ya se pregunta en «Registro de pacientes».

## Decisión y motivo

1. **Lo sugerido nace activo y unido a sus servicios.** Al crear la clínica, y una vez para las de hoy. La unión sale de la clave de la biblioteca (`servicePrefixes`); un servicio propio se elige a mano porque no hay de dónde saber qué es.
2. **Revisar avisa, no bloquea.** Cada texto dice «Sin revisar» hasta que alguien de la clínica lo marca o guarda un cambio, y la lista dice cuántos faltan. Es la decisión del dueño del producto: el sistema no traba el trabajo diario. Lo jurídico queda como pendiente aparte.
3. **Se edita sobre la hoja.** Son las mismas secciones de siempre, en recuadros punteados dentro de una hoja; lo que se completa solo va en gris. «Vista previa» da el PDF real del servidor, porque la hoja no enseña los cortes de página.
4. **Guardar es una sola acción.** Crea la versión y la deja en uso, sin borrador ni publicar aparte. Lo publicado sigue sin cambiar su texto: la base solo deja cambiar su estado y quién lo revisó.
5. **Apagar es una decisión.** Uno apagado deja de pedirse en la atención y de avisar en «Te espera».
6. **Los formularios propios quedan a un enlace.** No se borran: alguna clínica puede usarlos y sus respuestas son parte de la historia. *Reemplazado el 2026-11-13 por «Fichas de consulta», abajo.*

## Alternativas descartadas

- *Editar el PDF.* El PDF se genera con los datos de cada paciente: permitiría borrar secciones obligatorias y descuadrar la hoja, y en un teléfono no se puede usar.
- *Formulario a un lado y PDF al otro.* Dos hojas casi iguales a la vista, que no caben en un teléfono y obligan a regenerar el PDF mientras se escribe.
- *Publicar solo tras revisar.* Es lo que había: en la práctica las clínicas seguían en papel.
- *Unir por el nombre del servicio.* Adivina: uniría un consentimiento a lo que no corresponde sin que nadie lo note.

## Consecuencias

- Una clínica firma por la web desde el primer día y sus presupuestos explican riesgos y alternativas.
- Un paciente puede firmar un texto sugerido que nadie de la clínica leyó. Revisar esta decisión si la asesoría legal o una clínica lo objeta.
- Atenciones con esos servicios ahora proponen «Necesita consentimiento»; avisa sin bloquear, como antes.

## Cambio del 2026-11-13: fichas de consulta

La mesa del 13 nov (entrega 5) vio que nadie encontraba sus formularios del equipo detrás de un enlace al pie de Consentimientos, que la atención no los ofrecía y que en un control había que salir a Documentos para ver la ficha anterior.

1. **Un solo nombre, «Ficha», y su lugar en el menú.** «Fichas de consulta» en Configuración › Atención (`/settings/consultation-forms`); «Nuevo › Ficha» en Documentos y en la atención; el filtro de Documentos y la Historia dicen «Ficha». Lo que respondió el paciente en los cuestionarios de antes queda en el mismo filtro, dicho como lo que es. El enlace del pie de Consentimientos se quita; el de la pestaña antigua redirige.
2. **Aparecen solas en la atención, sin exigirse.** Por la especialidad del servicio de la cita; por la edad (el producto declara cuáles: odentIA, odontopediatría a menores de 12); y, si de la cita no sale una especialidad, por las de quien atiende. «Otra ficha…» ofrece las demás. Ofrecer por servicio queda fuera: dos fichas de la misma especialidad aparecen las dos. Nada de esto traba abrir, firmar o cobrar la atención.
3. **El producto trae las suyas (`ProductHooks.forms`).** odentIA: endodoncia, ortodoncia, odontopediatría y la odontoestomatológica de la norma de historia clínica. Cada clínica recibe su copia, en uso, sin autor; desde ahí es de la clínica y se cambia como cualquier otra (versión nueva; lo ya anotado conserva sus preguntas). Se copian por clave al crear la clínica y, para las que ya existen, el worker las agrega con la misma regla de los consentimientos sugeridos: la que falte por clave, nunca encima de una que la clínica ya tenga, dejó de usar o se llame igual. latidIA y vistIA no traen fichas por ahora.
4. **«Sin mirar» sin columna nueva.** Una ficha del producto dice «Viene con odentIA · Sin mirar» hasta que alguien de la clínica la abre («Ver y ajustar», que deja una constancia `form_template.look` en la auditoría) o guarda una versión con autor. La lista dice «Miraste N de 4». Así no hace falta migración.
5. **La anterior del mismo tipo, al lado.** La última ficha finalizada con la misma clave (cualquier versión), de otra atención no anulada: la atención la ofrece con «Empezar la de hoy» y la ficha abierta muestra bajo cada pregunta lo que se respondió entonces, por la clave de la pregunta.

Descartado: *una columna «revisada» en la plantilla* (pedía migración y repetía lo que ya dice la auditoría); *ofrecer por servicio* (más configuración para un caso que ninguna clínica pidió todavía); *calcular índices* (CPOD, IHO-S): se anotan ya sumados.

## Referencias

`packages/services/src/clinical-forms.ts` (`ensureClinicConsents`, `saveConsentTemplate`, `setConsentTemplateActive`), `packages/clinical/src/consent.ts`, `packages/clinic-app/src/components/settings/consent-templates.tsx`, migraciones `0027` y `0028`. Fichas de consulta: `packages/services/src/consultation-forms.ts`, `packages/services/src/dental/forms.ts`, `packages/clinic-app/src/components/settings/form-templates-panel.tsx`, `packages/clinic-app/src/components/patient/form-offers.tsx`.
