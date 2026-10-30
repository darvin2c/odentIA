/**
 * Señales de alarma en lo que escribe una persona (ADR 0084): frases de una
 * emergencia que puede poner en riesgo la vida. Ante una, Sofi responde aunque
 * una persona del equipo esté conversando, el caso pasa con prioridad alta y el
 * aviso empieza por a dónde llamar.
 *
 * Es una red por palabras, a propósito sin modelo: funciona aunque el modelo
 * falle o se haya llegado a un tope. Una falsa alarma cuesta un aviso de más;
 * una alarma perdida, mucho más. Por eso solo entran frases fuertes: «me sangra
 * la encía» no es una alarma, «no para de sangrar» sí. Y una frase negada justo
 * antes no cuenta («pero no me falta el aire»): `ALARM_NOT`, que usan también las
 * frases de cada producto.
 */
import { ALARM_NOT } from "@odentia/services"

/**
 * Posible rabia: un animal que muerde a una persona o un murciélago que pudo
 * tocarla. La OMS cuenta el contacto directo con un murciélago como exposición
 * grave, y su mordida puede no notarse; el MINSA atiende toda mordedura de un
 * animal como una urgencia (NTS 131). La vacuna sirve si llega a tiempo. Los
 * roedores no transmiten la rabia, y lo que un perro muerde sin morder a nadie
 * («mi gato mordió el protector bucal») no es una alarma.
 */
const ANIMAL =
  "(?:perr(?:o|a|ito|ita)s?|cachorr(?:o|a|ito|ita)s?|gat(?:o|a|ito|ita)s?|murcielag(?:o|a)s?|vampir(?:o|a)s?|mon(?:o|a|ito|ita)s?|zorr(?:o|a|illo|illa)s?|animal(?:es|ito|itos)?|can(?:es)?)"
const WHOSE =
  "(?:un|una|unos|unas|el|la|los|las|mi|mis|tu|tus|su|sus|nuestr[oa]s?|algun|alguno|alguna|ese|esa|este|esta)"
const BIT = "(?:ha |han |habia |habian )?(?:mordio|mordieron|mordido)"
const NOT_BIT = String.raw`${ALARM_NOT}(?<!\bcasi )`
// «Mi perro me mordió la placa»: en una clínica dental, lo mordido suele ser un aparato.
const THING =
  "(?! (?:el|la|los|las|mis?|tus?|sus?) (?:placa|retenedor|alineador|ferula|protector|bracket|fren|aparato|dentadura|protesis|zapat|juguete|cable|celular|lente|ropa))"
const PERSON =
  "(?:hij|nin|beb|espos|mama|papa|abuel|herman|sobrin|niet|tio|tia|prim|pareja|novi|amig|vecin|senor|chiqu|menor|muchach|joven|persona)"
// Con un murciélago basta el contacto, el sueño o el cuarto; «hay murciélagos en la selva» no.
// Sin negación: su mordida puede no notarse, y «no me mordió» no lo descarta.
// Las raíces que también son otra cosa van con sus formas: «tocó», no «toca el tema»; «picó»,
// no «picante»; «una marca», no «marcar la cita».
const BAT_CONTACT = String.raw`(?:mord\w*|aran\w*|rasgun\w*|toc(?:o|ado|ada|aron)\b|lami\w*|pic(?:o|ado|ada|adura|aron)\b|chup\w*|encima|dorm\w*|despert\w*|cuarto|habitacion|dormitorio|cama|cuna|herid\w*|marc(?:a|as|ita|itas)\b|puntito|sangr\w*|emergencia\w*)`

const SIGNALS: readonly RegExp[] = [
  // Dolor u opresión en el pecho; «no me duele el pecho» o «el pecho no me duele», no.
  new RegExp(
    String.raw`${ALARM_NOT}\b(dolor|duele|opresion|presion|aprieta)\b[^.!?]{0,20}\bpecho\b`,
  ),
  new RegExp(String.raw`\bpecho\b[^.!?]{0,15}${ALARM_NOT}\b(dolor|duele|aprieta)\b`),
  // No poder respirar; «no me falta el aire» o «no tiene dificultad para respirar», no.
  /\b(no|ni siquiera) (puedo|puede|podia|podemos) respirar\b/,
  // «No respira»; «no respira bien por la nariz», de un resfrío, no.
  /\bno respira\b(?! (bien )?por la nariz)/,
  new RegExp(String.raw`${ALARM_NOT}\b(me|le|nos) falta (el )?aire\b`),
  new RegExp(String.raw`${ALARM_NOT}\bfalta de aire\b`),
  new RegExp(String.raw`${ALARM_NOT}\bdificultad para respirar\b`),
  new RegExp(String.raw`${ALARM_NOT}\b(me|se) (estoy |esta )?ahog(o|a|ando)\b`),
  // Desmayo o pérdida de conocimiento. Desmayarse va con «se», que en «no se desmayó»
  // no puede ser «no sé».
  new RegExp(String.raw`${ALARM_NOT}(?<!\b(?:no|ni|tampoco) se (?:ha |han )?)\b(desmay|desvanec)`),
  new RegExp(String.raw`${ALARM_NOT}\bperdi(o|do|da de)? (el )?conocimiento\b`),
  new RegExp(String.raw`${ALARM_NOT}\binconsciente\b`),
  // Convulsiones.
  new RegExp(String.raw`${ALARM_NOT}\bconvulsi`),
  // Sangrado que no para.
  /\bno (para|paro|deja|dejo|ha parado|ha dejado) de sangrar\b/,
  new RegExp(String.raw`${ALARM_NOT}\bsangrado (abundante|que no para)\b`),
  new RegExp(String.raw`${ALARM_NOT}\bhemorragia\b`),
  // Una reacción que cierra la garganta o hincha la cara.
  new RegExp(String.raw`${ALARM_NOT}\bse me (cierra|esta cerrando) la garganta\b`),
  new RegExp(
    String.raw`${ALARM_NOT}\bse (me|le) (hincho|esta hinchando|hincha) (la cara|la lengua|los labios|la garganta)\b`,
  ),
  // Señales de un derrame.
  new RegExp(
    String.raw`${ALARM_NOT}\bse (me|le) (cayo|durmio|paralizo) (la )?(mitad de la )?cara\b`,
  ),
  /\bno (puedo|puede) mover (el brazo|la pierna|un lado|la mitad)\b/,
  // Quien piensa en hacerse daño, aunque lo niegue: «no pienso en suicidarme» ya lo nombra.
  /\bsuicid/,
  /\bquitarme la vida\b/,
  /\bhacerme dano\b/,
  /\bme quiero morir\b(?! de)/,
  // Posible rabia: «me mordió un perro», «a mi hijo lo mordió un perro», «un perro
  // mordió a mi hija», «una mordedura de gato», «desperté con un murciélago en el cuarto».
  new RegExp(
    String.raw`${NOT_BIT}\b(?:me|le|les|nos) ${BIT}\b${THING}(?: \w+){0,3}? ${WHOSE} (?:\w+ ){0,2}?${ANIMAL}\b`,
  ),
  // Con «lo» o «la», solo un animal cualquiera: «el retenedor lo mordió mi perro» no.
  new RegExp(
    String.raw`${NOT_BIT}\b(?:lo|la|los|las) ${BIT}\b(?: \w+){0,3}? (?:un|una|unos|unas|algun|alguno|alguna) (?:\w+ ){0,2}?${ANIMAL}\b`,
  ),
  new RegExp(
    String.raw`\b${ANIMAL}\b[^.!?]{0,40}?${NOT_BIT}\b(?:(?:me|le|les|nos) ${BIT}\b${THING}|${BIT} a ${WHOSE} (?:\w+ )?${PERSON})`,
  ),
  new RegExp(
    String.raw`\b(?:mordid[oa]s? por|(?:mordedura|mordida|mordisco)s? de) (?:${WHOSE} )?(?:\w+ ){0,2}?${ANIMAL}\b`,
  ),
  new RegExp(
    String.raw`\bmurcielag[oa]s?\b[^.!?]{0,60}\b${BAT_CONTACT}|\b${BAT_CONTACT}\b[^.!?]{0,60}\bmurcielag`,
  ),
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
