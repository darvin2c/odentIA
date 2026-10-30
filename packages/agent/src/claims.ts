/**
 * Lo que una respuesta dice que se hizo: que el equipo lo verá o ya lo tiene, que
 * quedó anotado, o que ya tiene dónde avisarle. En las rondas de la auditoría del
 * ADR 0104 Sofi decía «recepción lo revisará» sin haberlo pasado, «ya lo anoté» sin
 * anotar nada y, en el chat web, «ya guardé tu WhatsApp» sin guardarlo, y el juez
 * lo daba por falso. Solo reconoce las frases: si es cierto lo decide quien llama,
 * con lo que consta (`send_reply`).
 */

/** Sin tildes ni mayúsculas, con la puntuación: una frase termina en «.», «?» o «!». */
const plain = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")

/** «Recepción revisará…», «el equipo te escribirá», «lo paso al equipo», «the team will check». */
const TEAM_WILL =
  /\b(recepcion|el equipo|nuestro equipo|una persona del equipo|un profesional|reception|the team|our team|someone from (the|our) team)\b[^.?!\n]{0,60}?\b(revisa|revisara|revisaran|vera|veran|te escribira|te escribiran|te contactara|te contactaran|te avisara|te avisaran|te confirmara|te confirmaran|te respondera|te responderan|continuara|will (check|review|look|get back|contact|reach out|let you know|confirm|follow up|be in touch|reply)|is (checking|reviewing|looking))\b/
const PASSED_ON =
  /\b(lo paso|te paso|se lo paso|lo pase|se lo pase|lo hice llegar|se lo hice llegar|lo deje con|i'll pass|i will pass|i've passed|i have passed)\b/
/** «Ya lo anoté», «tomé nota», «quedó anotado», «I've noted». */
const NOTED = /\b(anote|anotado|anotada|tome nota|i've noted|i have noted|i noted|i've made a note|i made a note)\b/

/** Dónde avisarle. «Tu número de documento» no lo es. */
const WHERE = String.raw`(?:whatsapp|wsp|correo|e-?mail|celular|telefono|(?:datos de )?contacto|numero(?! de (?!whatsapp|celular|telefono)))`
/** «Tu WhatsApp», «su correo», «tu nombre y WhatsApp», «tu consulta y tu WhatsApp». */
const YOURS = String.raw`(?:[a-z]+ (?:y|e) (?:tu |su )?)?${WHERE}`
const YOUR = String.raw`(?:tu|tus|su|sus) ${YOURS}`
/** Lo negado o lo que depende de algo no afirma nada: «no guardé», «si ya dejaste», «aún no tenemos». */
const NOT_AFTER = String.raw`(?<!\b(?:no|ni|si|sin)(?: (?:ya|lo|la|se|te|le|nos|me))* )`
/**
 * Lo que va en medio, sin pasar a otra frase, a pedírselo («anoté que…; déjame tu WhatsApp»)
 * ni a otro verbo que lo rija («anoté que necesitas que retiren tu número»).
 */
const GAP = String.raw`(?:(?!\b(?:deja|dejame|dejanos|comparte|compartes|compartirnos|escribe|escribeme|indicame|enviame|pasame|dame|retiren|retirar|borren|quiten|cambien|cambiar|actualicen|actualizar|revisen|revisar|verifiquen|verificar|confirmen|confirmar|please|share|send|leave|update|check)\b)[^.?!;:\n]){0,40}?`
const KEPT_PARTICIPLE = String.raw`(?:registrad|guardad|anotad)[oa]s?`
/** Lo guardó, lo tiene, quedó, se lo dejaron o se le avisará ahí (español). */
const KEPT_ES = new RegExp(
  [
    // «Guardé tu WhatsApp», «anoté el correo», «dejé guardado ese número».
    String.raw`${NOT_AFTER}\b(?:guarde|guardamos|registre|registramos|anote|anotamos|recibi|recibimos|(?:deje|dejamos) ${KEPT_PARTICIPLE})\b${GAP}\b(?:${YOUR}|(?:el|la|los|ese|este) ${WHERE})`,
    // «Ya tenemos tu WhatsApp», «el equipo tiene tu consulta y tu correo», «tenemos cómo avisarte por WhatsApp».
    // «Ya tenemos cómo avisarte», a secas, es lo que responde guardar_contacto a quien la clínica ya conoce.
    String.raw`${NOT_AFTER}\b(?:tengo|tenemos|tiene|tienen)\b(?:${GAP}\b${YOUR}| (?:como|donde|por donde) avisar(?:te|le) (?:por|al|a) (?:tu |su )?${WHERE})`,
    // «Tu WhatsApp quedó registrado», «quedó registrado tu correo», «ya quedó tu WhatsApp», «dejamos tu WhatsApp registrado», «ya dejé tu WhatsApp».
    String.raw`${NOT_AFTER}\b${YOUR}(?: ya)? (?:quedo|queda|quedaron|esta|ha quedado)(?: ya)? ${KEPT_PARTICIPLE}`,
    String.raw`${NOT_AFTER}\b(?:(?:quedo|quedaron|queda|esta)(?: ya)? ${KEPT_PARTICIPLE}|quedo) ${YOUR}`,
    // Sin tildes, «deje su WhatsApp» es también pedírselo de usted: «dejé su…» cuenta solo tras «ya».
    String.raw`${NOT_AFTER}\b(?:(?:ya )?deje (?:tu|tus)|ya deje (?:su|sus)|dejamos (?:tu|tus|su|sus)) ${YOURS}`,
    // «Ya nos dejaste tu WhatsApp», «compartiste tu correo».
    String.raw`${NOT_AFTER}\b(?:ya )?(?:nos |me )?(?:dejaste|compartiste|diste|enviaste|indicaste|pasaste|escribiste) ${YOUR}`,
    // «Te avisarán a tu WhatsApp», «que te contacte al número que dejaste», «te avisará al WhatsApp».
    String.raw`${NOT_AFTER}\b(?:te|le|les) (?:avis|contact|escrib)[a-z]* (?:(?:a|por|en) ${YOUR}|al ${WHERE})`,
  ].join("|"),
)
/** Lo mismo en inglés: «I've saved your WhatsApp», «the team has your email», «you already shared your number». */
const WHERE_EN = String.raw`(?:whatsapp|phone|mobile|cell|e-?mail|contact (?:details|info)|number)`
const YOUR_EN = String.raw`your (?:[\w-]+ (?:[\w-]+ )?and (?:your )?)?${WHERE_EN}`
const KEPT_EN = new RegExp(
  String.raw`\b(?:i've|i have|i|we've|we have|we)(?: already| just)? (?:saved|noted|recorded|registered|stored|added|got|received)\b${GAP}\b${YOUR_EN}` +
    String.raw`|\b(?:the team|our team|reception|they|we|i)(?: now| already)? (?:has|have) ${YOUR_EN}` +
    String.raw`|\b${YOUR_EN}(?: number)? (?:is|was|has been)(?: already| now)? (?:saved|noted|registered|recorded|on file)` +
    String.raw`|\byou(?:'ve| have)?(?: already)? (?:shared|left|gave|sent|given)(?: us| me)? ${YOUR_EN}`,
)
/** «El WhatsApp que compartiste» o «al correo que nos dejaste» es el suyo: se lee como «tu WhatsApp». */
const LEFT_ONE = /\b(?:(a)l|el|la) (whatsapp|correo|celular|numero) que (?:nos |me )?(?:dejaste|compartiste|diste|indicaste|escribiste|enviaste|pasaste)\b/g

export function claimsOf(text: string): { team: boolean; note: boolean; contact: boolean } {
  const said = plain(text)
  const yours = said.replace(LEFT_ONE, (_match, to: string | undefined, what: string) => `${to ? "a " : ""}tu ${what}`)
  return {
    team: TEAM_WILL.test(said) || PASSED_ON.test(said),
    note: NOTED.test(said),
    contact: KEPT_ES.test(yours) || KEPT_EN.test(yours),
  }
}
