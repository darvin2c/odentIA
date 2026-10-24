/**
 * Señales de alarma en lo que escribe una persona (ADR 0084): frases de una
 * emergencia que puede poner en riesgo la vida. Ante una, Sofi responde aunque
 * una persona del equipo esté conversando, el caso pasa con prioridad alta y el
 * aviso empieza por a dónde llamar.
 *
 * Es una red por palabras, a propósito sin modelo: funciona aunque el modelo
 * falle o se haya llegado a un tope. Una falsa alarma cuesta un aviso de más;
 * una alarma perdida, mucho más. Por eso solo entran frases fuertes: «me sangra
 * la encía» no es una alarma, «no para de sangrar» sí.
 */
const SIGNALS: readonly RegExp[] = [
  // Dolor u opresión en el pecho.
  /\b(dolor|duele|opresion|presion|aprieta)\b[^.!?]{0,20}\bpecho\b/,
  /\bpecho\b[^.!?]{0,15}\b(dolor|duele|aprieta)\b/,
  // No poder respirar.
  /\bno (puedo|puede|podia|podemos) respirar\b/,
  /\b(me|le|nos) falta (el )?aire\b/,
  /\bfalta de aire\b/,
  /\bdificultad para respirar\b/,
  /\b(me|se) (estoy |esta )?ahog(o|a|ando)\b/,
  // Desmayo o pérdida de conocimiento.
  /\b(desmay|desvanec)/,
  /\bperdi(o|da de)? (el )?conocimiento\b/,
  /\binconsciente\b/,
  // Convulsiones.
  /\bconvulsi/,
  // Sangrado que no para.
  /\bno (para|deja) de sangrar\b/,
  /\bsangrado (abundante|que no para)\b/,
  /\bhemorragia\b/,
  // Una reacción que cierra la garganta o hincha la cara.
  /\bse me (cierra|esta cerrando) la garganta\b/,
  /\bse (me|le) (hincho|esta hinchando|hincha) (la cara|la lengua|los labios|la garganta)\b/,
  // Señales de un derrame.
  /\bse (me|le) (cayo|durmio|paralizo) (la )?(mitad de la )?cara\b/,
  /\bno (puedo|puede) mover (el brazo|la pierna|un lado|la mitad)\b/,
  // Quien piensa en hacerse daño.
  /\bsuicid/,
  /\bquitarme la vida\b/,
  /\bhacerme dano\b/,
  /\bme quiero morir\b(?! de)/,
]

/** Sin tildes, en minúsculas y con un solo espacio: «Me DUELE el pecho» → «me duele el pecho». */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
}

/** Lo que escribió trae una señal de alarma, de las comunes o de las del producto (`ProductAgentTexts.alarmSignals`). */
export function hasAlarmSignal(text: string | null | undefined, productSignals: readonly RegExp[] = []): boolean {
  if (!text) return false
  const folded = fold(text)
  return SIGNALS.some((signal) => signal.test(folded)) || productSignals.some((signal) => signal.test(folded))
}
