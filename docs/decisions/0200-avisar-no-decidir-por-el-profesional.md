# 0200 · Avisar, no decidir por el profesional

Fecha: 2026-11-17 · Estado: aceptada · Revisa ADR 0199 (la ficha de una vez por plan y la colegiatura como falta del pie), ADR 0003 y 0041 (la colegiatura para cerrar la atención) y ADR 0036 y 0079 (la variante obligatoria con odontograma oficial)

## Problema

Algunas reglas fijas decidían por el profesional o lo frenaban sin que nadie lo eligiera:

- Sin colegiatura en su perfil, la atención no se podía cerrar.
- Las fichas se escondían o aparecían por la edad (odontopediatría a menores de 12), por «una vez por plan» o por una urgencia, que además se reconocía por la palabra con que empezaba el motivo.
- Con odontograma oficial, registrar un hallazgo exigía su variante.

Ninguna de esas reglas era un estándar ni lo configuraba la clínica. El criterio del producto es «nunca decidimos por el médico, solo informamos».

## Decisión y motivo

- **La colegiatura no frena el cierre.** El cierre la pide en el mismo diálogo. Si se escribe, queda en el perfil. Si no, se firma escribiendo por qué (`encounter.registration_skip_reason`), y el papel sale sin colegiatura. La receta, el consentimiento y el odontograma firmado a pedido siguen como estaban.
- **Sin el consentimiento firmado, también se cierra con el motivo escrito**, como ya pasaba, pero sin atajos de un toque como «Urgencia».
- **Los motivos siempre se escriben.**
- **Las fichas se ofrecen solo por lo que la clínica configuró:**
  - la especialidad del servicio de la cita o la de quien atiende;
  - la que el paciente ya tiene;
  - la que se empezó en la atención.

  Nunca por la edad, ni por «una vez por plan», ni por una urgencia. La que ya llenó se ofrece igual y dice la anterior, con su día: el profesional decide si la abre.
- **La variante es opcional en todos los países.** Con odontograma oficial se nombra por su sigla; fuera, por su nombre clínico.

## Alternativas descartadas

- *Volver configurables por clínica la edad o «una vez por plan»:* suma opciones para reglas que no salen de un estándar. Se quitan.
- *Cerrar sin colegiatura y sin motivo:* en este caso y en el del consentimiento, la clínica necesita la constancia escrita de por qué se firmó así.

## Consecuencias

- Ningún dato del perfil traba la atención; queda la constancia en la atención.
- La odontoestomatológica sale en cada atención de quien tiene su especialidad; se ignora sin tocarla y dice la anterior.
- Lo que el producto ya no decide se responde en la Ayuda con las mismas palabras.
