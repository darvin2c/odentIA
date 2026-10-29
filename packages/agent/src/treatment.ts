/**
 * Si quien escribe trata de usted, por sus formas más claras y sin modelo
 * (auditoría del ADR 0104): a quien escribía «¿podría indicarme…?» Sofi le
 * respondía «aceptas», «completa tus datos», sobre todo en las frases que copia
 * de las herramientas, aunque el prompt le pedía su trato. Solo reconoce el
 * usted en español; lo demás sigue la regla del trato del prompt.
 */

const plain = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")

/** Formas que usa quien trata de usted: «¿podría indicarme?», «le agradezco», «disculpe». «Ustedes» no cuenta: es la clínica. */
const USTED =
  /\b(usted|podria (indicarme|decirme|ayudarme|confirmarme|enviarme|explicarme|informarme|darme|atenderme|reservarme)|me podria|le agradezco|le agradeceria|disculpe|indiqueme|digame|permitame|confirmeme|aviseme)\b/
/** Formas de tú de quien escribe: con una sola, no es usted. */
const TU_PERSON = /\b(puedes|podrias|quieres|tienes|sabes|me dices|me ayudas|disculpa|oye|porfa|avisame|dime|confirmame)\b/
/** Pedir que lo traten de usted manda aunque se le escape un «porfa». */
const ASKS_USTED = /\b(trateme|tratame|hableme|hablame|dirijase a mi) de usted\b/
/**
 * Formas de tú en lo que va a salir: «te», «tu», «tus», «aceptas», «cuéntame» y las que
 * llevan el «te» pegado («evaluarte», «reservarte»), que la auditoría encontró al reescribir.
 */
const TU_REPLY =
  /\b(tu|tus|te|ti|contigo|quieres|puedes|tienes|prefieres|aceptas|deseas|necesitas|cuentame|dime|escribeme|avisame|enviame|confirmame|(ayudar|atender|evaluar|reservar|registrar|escribir|avisar|confirmar|enviar|llamar|contactar|orientar|indicar|ofrecer|dar|decir|pedir|preguntar|recordar|agendar|ver|buscar|pasar|cambiar)te)\b/

/** «usted» si pidió que lo traten así, o si sus mensajes tratan de usted y ninguno tutea; nulo si no se distingue. */
export function treatmentOf(said: string[]): "usted" | null {
  const text = plain(said.join("\n"))
  return ASKS_USTED.test(text) || (USTED.test(text) && !TU_PERSON.test(text)) ? "usted" : null
}

/** Si lo que va a salir tutea. */
export function tutea(text: string): boolean {
  return TU_REPLY.test(plain(text))
}
