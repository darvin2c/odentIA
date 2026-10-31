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
6. **Los formularios propios quedan a un enlace.** No se borran: alguna clínica puede usarlos y sus respuestas son parte de la historia.

## Alternativas descartadas

- *Editar el PDF.* El PDF se genera con los datos de cada paciente: permitiría borrar secciones obligatorias y descuadrar la hoja, y en un teléfono no se puede usar.
- *Formulario a un lado y PDF al otro.* Dos hojas casi iguales a la vista, que no caben en un teléfono y obligan a regenerar el PDF mientras se escribe.
- *Publicar solo tras revisar.* Es lo que había: en la práctica las clínicas seguían en papel.
- *Unir por el nombre del servicio.* Adivina: uniría un consentimiento a lo que no corresponde sin que nadie lo note.

## Consecuencias

- Una clínica firma por la web desde el primer día y sus presupuestos explican riesgos y alternativas.
- Un paciente puede firmar un texto sugerido que nadie de la clínica leyó. Revisar esta decisión si la asesoría legal o una clínica lo objeta.
- Atenciones con esos servicios ahora proponen «Necesita consentimiento»; avisa sin bloquear, como antes.

## Referencias

`packages/services/src/clinical-forms.ts` (`ensureClinicConsents`, `saveConsentTemplate`, `setConsentTemplateActive`), `packages/clinical/src/consent.ts`, `packages/clinic-app/src/components/settings/consent-templates.tsx`, migraciones `0027` y `0028`.
