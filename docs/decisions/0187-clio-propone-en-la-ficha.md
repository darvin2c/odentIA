# 0187 · Clío propone las respuestas de la ficha de consulta empezada

Fecha: 2026-11-14 · Estado: aceptada · Extiende la [0012](0012-asistente-clinico-sugiere-y-el-odontologo-confirma.md) (Clío sugiere y el profesional confirma) y la [0117](0117-consentimientos-activos-y-hoja-editable.md) (su cambio del 13 nov: fichas de consulta)

## Problema

El profesional tiene la ficha de ortodoncia abierta al lado y dicta «overjet de seis milímetros, clase uno molar izquierda». Clío ordenaba la consulta, pero esos valores no llegaban a ningún lado: ni a la ficha ni a «No pude usar esto». Había que teclearlos después. La ficha es clínica: un valor que el profesional no dijo, o un «No» que nunca se negó, queda en la historia como si lo hubiera dicho.

## Decisión y motivo

- **Clío propone mientras se dicta; una persona acepta.** La respuesta de una ficha es una clase más de sugerencia (`ficha`, operación `ficha.respuesta`). Usa lo que Clío ya tiene: la frase dicha, por revisar, corregir por voz, quién decidió y descartar al firmar. Al aceptarse, se escribe en la ficha con su validación (`assertAnswers`) y solo en una pregunta vacía: lo que escribió la persona gana. Quién aceptó queda en la sugerencia, sin tabla nueva. La ficha lo muestra («Lo propuso Clío · lo aceptó…») mientras la respuesta siga siendo esa.
- **Solo fichas empezadas y solo lo que se comprueba con la frase.** Clío lee las preguntas vacías de las fichas del equipo en borrador de esa atención: como mucho 2 fichas, las tocadas más recientemente, y 40 preguntas. Lee solo preguntas de sí o no, de una opción, de varias, de número, de escala y de pieza. El servidor comprueba lo propuesto contra lo dicho (`prepareFormAnswer`):
  - sin frase no se guarda;
  - un número o una pieza tienen que estar en la frase, en cifras o en palabras;
  - un «No» exige una negación dicha;
  - otra unidad de la misma magnitud no se convierte;
  - una opción cuyo número la distingue de otra («Clase II división 1» frente a «división 2») queda por revisar si ese número no se dijo, y la elige el profesional.
  Texto y fecha quedan para después, medidos aparte. Firma, archivo y lo que pasa a alergias, nunca.
- **Las preguntas viajan en el mensaje de la pausa, no en las instrucciones fijas.** La parte fija se guarda en la caché del proveedor y es la misma en toda la atención. Sin ficha empezada, el modelo no lee nada nuevo salvo la lista `fichas` del esquema. Con ficha, lee sus preguntas y cómo responderlas.
- **Se acepta en la pregunta, dentro de la ficha (forma B del lienzo, aprobada el 14 nov).** Arriba de la ficha va «Aceptar las N». La fila de la ficha en la atención y la barra del dictado solo avisan y llevan a la ficha. Al firmar sin decidir, lo propuesto entra marcado, como las demás sugerencias. La ficha sigue a medias y se termina después. La pregunta que depende de otra acepta primero la propuesta de esa otra, o pide responderla. Se escribe así y no en silencio, porque `assertAnswers` dejaría vacía una pregunta oculta por su condición.

## Alternativas descartadas

- *Un botón «Llenar con lo dictado» al final, en la ficha.* Depende de un texto que vive en la pantalla y se pierde al recargar. Deja el dato en la nota y en la ficha, y no registra quién aceptó cada respuesta.
- *Aceptar en la fila de la ficha, en la atención (forma A).* Se acepta sin abrir la ficha, pero lejos de la pregunta y del valor de la vez anterior, que es lo que se compara en un control.
- *Mandar las preguntas en las instrucciones fijas.* Cambian con cada ficha y cada respuesta: cada pausa escribiría la caché y no la leería.
- *Ofrecer abrir una ficha si se dicta algo de ella.* Obliga a mandarle al modelo todas las fichas de la clínica, y la atención ya ofrece las fichas de cada especialidad (0117).

## Consecuencias

- El esquema de Clío cambia en odentIA y latidIA: se vuelven a medir sus bancos y el nuevo `eval/dictado-fichas.json`. vistIA no dicta.
- Una ficha solo ofrecida no recibe propuestas: lo dicho para ella sigue como hoy. Se revisa si en el uso real se dicta antes de empezarla.
- El micrófono no distingue quién habla: la frase siempre se ve junto a la propuesta, y la acepta el profesional.

## Referencias

`packages/services/src/dictation-forms.ts`, `packages/services/src/encounter-dictation.ts` (clase `ficha`), `packages/agent/src/dictation.ts` (`dictationFormsText`), `packages/clinic-app/src/components/patient/formularios-tab.tsx` y `clio-form-proposals.tsx`. Acta y lienzo de la mesa en el PR.
