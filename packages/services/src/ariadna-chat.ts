/**
 * Ariadna responde por chat (ADR 0191, lienzo «Ariadna en los chats», A1–A5): a
 * la clínica que ya tiene su app y escribe a Sallca por WhatsApp, Instagram o
 * Messenger, con la misma guía y el mismo decisor que la Ayuda de la app
 * (`decideHelp`), sin pantalla y sin ningún dato de la clínica: no sabe quién
 * escribe ni con qué rol, así que no dice qué puede hacer cada uno ni qué falta
 * en su cuenta; para eso ofrece la Ayuda de la app o Soporte.
 *
 * Lo que sale es siempre un texto de la guía tal cual (o lo redactado con dos o
 * tres de ellos, comprobado con `helpWrittenProblem`) o uno de los textos fijos
 * de aquí: el modelo no escribe nada más. Antes de buscar en la guía se aparta
 * lo que no es de la guía, primero por palabras y, si hay decisor, con su
 * pregunta `ariadna_chat`: cobros, su plan, comprar algo más, otra sede u otro
 * producto pasan a Administración; quien escribe como paciente recibe la
 * explicación y queda para que una persona lo vea; «no me deja» recibe la
 * oferta de la Ayuda de la app o de Soporte, y un sí (o que insista) lo pasa a
 * Soporte.
 */
import {
  CLINICAL_PRODUCTS,
  type ClinicalProduct,
  productWords,
  withoutPersonData,
} from "@odentia/clinical"
import type { AdminAnswer, AdminQuestion } from "./admin-request.js"
import { AGENT_NAMES } from "./agent-names.js"
import { decideHelp, exactHelpOption, type HelpDecided } from "./help.js"
import {
  HELP_CONFIDENT,
  type HelpDecider,
  type HelpOption,
  type HelpPrevious,
  type HelpWriter,
  helpAnswerText,
} from "./help-decision.js"
import {
  type HelpTopic,
  helpSmallTalk,
  helpTopic,
  helpTopicLabel,
  matchHelpTopics,
} from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"
import { agentTextsFor, helpTopicsFor } from "./products.js"

/** Lo que Ariadna contesta en un turno del chat. */
export type AriadnaChatReply =
  /** La guía responde: su texto y, si es de una pantalla, el enlace a ella en la app de la clínica. */
  | {
      kind: "respuesta"
      text: string
      link: string | null
      topicId: string | null
      faqId: string | null
      written: boolean
    }
  /** No puede verlo por aquí (o no lo encuentra): ofrece la Ayuda de la app o pasarlo a Soporte. */
  | { kind: "oferta"; text: string; why: string; topicId?: string | null; faqId?: string | null }
  /** Pide un dato de su clínica: por aquí no se dan; le dice dónde verlo en la app. */
  | { kind: "datos"; text: string; link: string | null }
  /** Pasa a Soporte (dijo que sí a la oferta o insistió). */
  | { kind: "soporte"; text: string; why: string }
  /** Cobros, su plan, comprar algo más, otra sede u otro producto: pasa a Administración. */
  | { kind: "administracion"; text: string; why: string }
  /** Escribe un paciente de la clínica: la explicación, y una persona lo ve. */
  | { kind: "paciente"; text: string; why: string }

export interface AriadnaChatInput {
  product: ClinicalProduct
  /** Lo que escribió la persona desde la última respuesta (sus mensajes seguidos). */
  question: string
  /** Lo anterior de la conversación: la pregunta y la pantalla que se le respondió. */
  previous?: HelpPrevious | null
  /** La última respuesta de Ariadna fue una oferta de pasarlo a Soporte: un sí lo pasa. */
  offered?: boolean
  /** Ariadna todavía no escribió en esta conversación: se presenta. */
  firstReply?: boolean
  /** El origen de la app de la clínica (`https://<clínica>.<dominio>`), para el enlace; nulo si no hay. */
  appOrigin?: string | null
}

/** La pregunta del decisor que aparta lo que no es de la guía (se mide con `eval:ariadna-chat`). */
export const ARIADNA_CHAT_QUESTION = "ariadna_chat"
export const ARIADNA_CHAT_VERSION = "ariadna.v1"
const INTENTS = ["guia", "cobro", "paciente", "permiso", "datos", "otro"] as const
type Intent = (typeof INTENTS)[number]

const brandOf = (product: ClinicalProduct) => productWords(product).name

/* ---------- Los textos fijos ---------- */

/** «Soy Ariadna, la Ayuda de odentIA.»: la primera vez que escribe en la conversación. */
export function ariadnaIntro(product: ClinicalProduct): string {
  return `Soy ${AGENT_NAMES.ayuda}, la Ayuda de ${brandOf(product)}.`
}

/** Que también puede preguntar en la app: ahí sí ve lo de su cuenta. */
export const ARIADNA_APP_HELP = "También puedes preguntarme dentro de la app, en «Ayuda»."

const SAY = {
  offerWhy:
    "Por aquí no veo tu cuenta ni tus permisos, así que no sé qué te falta. En la app, en «Ayuda», te digo qué falta en esa pantalla y qué puede hacer tu rol. Si prefieres, te paso con Soporte por aquí mismo: ¿quieres que te pase?",
  offerNone:
    "No lo encuentro en la guía y no quiero inventarlo. ¿Quieres que te pase con Soporte? Te responden por aquí mismo.",
  offerDoubt: (choices: string[]) =>
    `No estoy segura de qué preguntas. ¿Es alguna de estas? ${choices.map((choice) => `«${choice}»`).join(", ")}. Escríbela tal cual o, si no es ninguna, te paso con Soporte.`,
  soporte: "Listo, te paso con Soporte: alguien del equipo te escribe por aquí.",
  media:
    "Por aquí no puedo ver audios, fotos ni archivos. Escríbeme tu pregunta y te digo cómo se hace en el sistema.",
  noThanks: "Listo. Si necesitas algo más, escríbeme por aquí.",
  administracion:
    "Eso lo ve Administración (cobros, tu plan, sumar algo más o abrir otra sede). Ya les pasé tu mensaje: te escriben por aquí.",
  paciente: (product: ClinicalProduct) =>
    `Hola. Este chat es de Sallca, la empresa que hace ${brandOf(product)}, el sistema que usa tu ${productWords(product).place.one}: por aquí no vemos citas ni historias. Para tu cita o tu atención, escríbele directamente a tu ${productWords(product).place.one}.`,
  datos: (product: ClinicalProduct, where: string | null) =>
    `Por aquí no veo los datos de tu ${productWords(product).place.one}: ${where ? `los ves en la app, en ${where}` : "los ves en la app"}.`,
}

/** Los textos fijos de Ariadna en el chat, para la medición (todo lo demás sale de la guía). */
export function ariadnaFixedTexts(product: ClinicalProduct): string[] {
  return [
    ariadnaIntro(product),
    ARIADNA_APP_HELP,
    SAY.offerWhy,
    SAY.offerNone,
    SAY.soporte,
    SAY.media,
    SAY.noThanks,
    SAY.administracion,
    SAY.paciente(product),
  ]
}

/* ---------- Lo que se aparta por palabras ---------- */

/** Lo que Sallca le cobra a la clínica, su plan o comprar más: siempre Administración. */
const BILLING = [
  /\b(me|nos|les) (cobr|factur|descont)\w*/,
  /\bcobr\w* (dos|2|doble|de mas|demas)\b/,
  /\b(cobro|pago|cargo) (doble|duplicado|repetido)\b/,
  /\b(dos|2) (cobros|cargos|veces)\b.*\b(tarjeta|cuenta|cobr\w*|pag\w*)/,
  /\b(mi|nuestro|el|del|de) plan\b/,
  /\b(cambiar|subir|bajar|mejorar|renovar|pasar) (de |el |mi |a otro )?plan\b/,
  /\bplan (fundadores|basico|pro|premium|mensual|anual)\b/,
  /\b(mi|la|nuestra|una) (factura|boleta|suscripcion|mensualidad)\b/,
  /\b(factura|boleta|comprobante) (de|del) (pago|sistema|mes|plan)\b/,
  /\b(cuanto|que) (me|nos) (cobran|cuesta|sale|van a cobrar)\b/,
  /\b(reembolso|devolucion de (mi|el|la) (pago|dinero|plata)|devuelvan (mi|el) (pago|dinero|plata))\b/,
  /\b(dar de baja|cancelar) (mi|la|nuestra) (cuenta|suscripcion|plan)\b/,
  /\b(comprar|contratar|sumar|agregar|pagar) (mas|otro|otra|un paquete|paquete)\b.*\b(preguntas|mensajes|usuarios|paquete|plan|sede|licencia)/,
  /\b(otra|nueva|segunda|tercera) (sede|sucursal|clinica|optica|consultorio|local)\b/,
  /\b(abrir|abrimos|abriremos|tenemos) (otra|una nueva|una segunda) (sede|sucursal|clinica|optica|consultorio|local)\b/,
  /\bmetodo de pago\b|\bpagar (el|mi) (sistema|plan|mes)\b|\btarjeta (de credito|de debito)?\b.*\b(cobr|cambi)/,
]

/** Quien escribe es un paciente de la clínica: pide su cita o su atención. */
const PATIENT = [
  /\bsoy (paciente|el paciente|la paciente|su paciente)\b/,
  /\b(me duele|tengo dolor|dolor de (muela|diente|cabeza)|se me (cayo|rompio) (un|el|mi) (diente|lente|brackets?))\b/,
  /\b(quiero|quisiera|necesito|deseo) (una|sacar|separar|pedir|reservar|agendar) (una )?(cita|hora|turno|consulta)\b(?! en el sistema)/,
  /\b(tengo|tenia) (una )?cita (con|para|el|mañana|manana|hoy)\b/,
  /\b(mi|mis) (doctor|doctora|dentista|odontologo|odontologa|tratamiento|ortodoncia|brackets|lentes|receta|medicina|resultados|examen)\b/,
  /\ba que hora (atienden|abren|cierran)\b|\batienden (hoy|manana|el sabado|el domingo|los sabados)\b/,
  /\b(cuanto (cuesta|sale|cobran)) (una|la|el) (limpieza|consulta|curacion|extraccion|endodoncia|ortodoncia|medida|resina|corona)\b/,
]

/** «No me deja», «no tengo permiso», un error: Ariadna no ve su cuenta por aquí. */
const BLOCKED = [
  /\b(no me deja|no me permite|no puedo|no tengo (permiso|acceso)|sin permiso|no me sale|no aparece|no me aparece|no funciona|no carga|no abre|no entra|bloquead\w*|me sale (un )?error|sale error|da error|un error|se cayo|se colgo)\b/,
]

/** Insistir después de la oferta: también lo pasa. */
const INSISTS =
  /\b(ya (lo )?(intente|probe|hice)|igual no|sigue (sin|igual)|todavia no|aun no|tampoco|no sirve|no resulta)\b/

/** Un sí a «¿quieres que te pase con Soporte?». */
const YES =
  /^(si|sii+|sip|sep|ok|oki|okey|okay|dale|ya|bueno|claro|por favor|porfa|porfavor|pasame|pasalo|pasa|de acuerdo|va|listo|perfecto|si por favor|si porfa|si gracias|si pasame|si dale|si claro|quiero soporte|soporte|con soporte|un humano|una persona|alguien)( .*)?$/
/** Un no a la oferta. */
const NO =
  /^(no|nop|no gracias|no por ahora|asi esta bien|ya no|ya esta|ya lo resolvi|ya pude|ya salio|ya funciono)( .*)?$/

/** Pide una cifra, una lista o un dato de su clínica. */
const DATA = [
  /\bcuant[oa]s (citas|pacientes|clientes|cobros|ventas|presupuestos|pedidos|mensajes|consultas)\b/,
  /\bcuanto (cobramos|vendimos|facturamos|ganamos|nos deben|me deben|debe)\b/,
  /\b(quien|quienes) (viene|vienen|tiene cita|tienen cita|debe|deben|falto|faltaron)\b/,
  /\b(dame|dime|pasame|mandame|enviame) (el|los|la|las) (telefono|numero|datos|lista|correo|dni|historia)\b/,
  /\b(el|los) (telefono|numero|celular|correo|dni) de\b/,
]

const matches = (rules: readonly RegExp[], text: string) => rules.some((rule) => rule.test(text))

/** Nombra otro producto de Sallca que no es el suyo (una óptica que pregunta por latidIA): es venta. */
function otherProduct(text: string, product: ClinicalProduct): string | null {
  for (const other of CLINICAL_PRODUCTS) {
    if (other === product) continue
    const name = normalizeForSearch(productWords(other).name)
    if (new RegExp(`\\b${name}\\b`).test(text)) return productWords(other).name
  }
  return null
}

/** Lo que dicen las palabras, sin modelo; nulo si nada aparta la pregunta de la guía. */
export function ariadnaRuleIntent(question: string, product: ClinicalProduct): Intent | null {
  const text = normalizeForSearch(question)
  if (!text) return null
  if (otherProduct(text, product) || matches(BILLING, text)) return "cobro"
  if (matches(PATIENT, text)) return "paciente"
  if (matches(DATA, text)) return "datos"
  if (matches(BLOCKED, text)) return "permiso"
  return null
}

/* ---------- La pregunta del decisor ---------- */

/** Lo que el decisor ve para apartar lo que no es de la guía: solo lo que escribió. */
export function ariadnaChatQuestion(product: ClinicalProduct): AdminQuestion {
  const brand = brandOf(product)
  const place = productWords(product).place.one
  return {
    id: ARIADNA_CHAT_QUESTION,
    kind: "choice",
    instructions: `Alguien escribe por WhatsApp a Sallca, la empresa que hace ${brand} (el sistema que usa una ${place} para trabajar). Quien atiende es la Ayuda de ${brand}: explica cómo se usa el sistema. ¿Qué es lo que escribió?`,
    options: [
      {
        value: "guia",
        description: `Pregunta cómo se hace algo en ${brand}, dónde está una pantalla o un botón, o qué significa algo del sistema.`,
      },
      {
        value: "cobro",
        description: `Es de lo que Sallca le cobra a la ${place}: un cobro, su factura, su plan, cambiar o renovar el plan, comprar o sumar algo más, abrir otra sede u otro producto de Sallca.`,
      },
      {
        value: "paciente",
        description: `Quien escribe es un paciente o cliente de la ${place}: pide su cita, su atención, un precio de un tratamiento o cuenta un síntoma.`,
      },
      {
        value: "permiso",
        description:
          "Dice que el sistema no le deja hacer algo, que no tiene permiso, que le sale un error o que algo no funciona en su cuenta.",
      },
      {
        value: "datos",
        description: `Pide una cifra, una lista o un dato de su propia ${place} (cuántas citas tiene, quién debe, el teléfono de alguien).`,
      },
      { value: "otro", description: "Un saludo, un agradecimiento u otro tema." },
    ],
  }
}

type ChoiceAnswer = Extract<AdminAnswer, { kind: "choice" }>

/** Lee la pregunta del decisor con el umbral de la Ayuda; sin certeza, nulo. */
export function readAriadnaChatIntent(result: { answers: readonly AdminAnswer[] }): Intent | null {
  const answer = result.answers.find(
    (item): item is ChoiceAnswer =>
      item.id === ARIADNA_CHAT_QUESTION && item.kind === "choice" && "choice" in item,
  )
  if (!answer?.probabilities) return null
  const [top] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
  if (!top || top[1] < HELP_CONFIDENT) return null
  return (INTENTS as readonly string[]).includes(top[0]) ? (top[0] as Intent) : null
}

/* ---------- La respuesta ---------- */

/** El enlace a la pantalla de una respuesta: el origen de la app de la clínica y la ruta del tema. */
function linkOf(
  option: HelpOption | undefined,
  appOrigin: string | null | undefined,
): string | null {
  if (!option || !appOrigin) return null
  if (option.kind === "faq" && option.faq.general) return null
  // Una ruta con partes variables (`/people/:id`) no lleva a ninguna parte por sí sola.
  if (/[:[*]/.test(option.topic.path)) return null
  return `${appOrigin.replace(/\/+$/, "")}${option.topic.path}`
}

function withIntro(text: string, input: AriadnaChatInput, appHelp = true): string {
  return [
    input.firstReply ? ariadnaIntro(input.product) : null,
    text,
    input.firstReply && appHelp ? ARIADNA_APP_HELP : null,
  ]
    .filter(Boolean)
    .join(PARAGRAPH)
}

/** Un párrafo aparte en WhatsApp: el enlace y el recuerdo de la Ayuda no quedan pegados al texto. */
const PARAGRAPH = "\n\n"

const choiceText = (option: HelpOption) =>
  option.kind === "faq" ? option.faq.q : `¿Qué es ${helpTopicLabel(option.topic)}?`

/** Dónde ve un dato en la app: la pantalla que nombran las palabras, o Reportes. */
function dataPlace(question: string, topics: readonly HelpTopic[]): HelpTopic | undefined {
  return matchHelpTopics(question, topics)[0]?.topic ?? helpTopic("reportes", topics)
}

/** «Por aquí no veo los datos de tu clínica: los ves en la app, en Agenda.» y el enlace. */
function dataReply(
  question: string,
  topics: readonly HelpTopic[],
  input: AriadnaChatInput,
): AriadnaChatReply {
  const place = dataPlace(question, topics)
  const link = place ? linkOf({ kind: "tema", topic: place }, input.appOrigin) : null
  const text = SAY.datos(input.product, place ? helpTopicLabel(place) : null)
  return {
    kind: "datos",
    text: withIntro(link ? `${text}${PARAGRAPH}Te dejo la pantalla: ${link}` : text, input),
    link,
  }
}

/**
 * Responde un turno del chat con la guía del producto de la clínica, sin datos
 * de ella. El decisor y quien redacta son los de la Ayuda (nulos: solo palabras).
 */
export async function askHelpByChat(
  input: AriadnaChatInput,
  decider: HelpDecider | null = null,
  writer: HelpWriter | null = null,
): Promise<AriadnaChatReply> {
  const topics = helpTopicsFor(input.product)
  const texts = agentTextsFor(input.product)
  const question = input.question.trim().slice(0, 500)
  const plain = normalizeForSearch(question)
  // La anterior viaja como en la Ayuda: sin cifras ni correos y, si puede ser un dato de alguien, no viaja.
  const previousAsked = input.previous
    ? withoutPersonData(input.previous.question.trim().slice(0, 500))
    : null
  const previous: HelpPrevious | null = previousAsked
    ? { question: previousAsked, where: input.previous?.where ?? null }
    : null
  if (!plain)
    return {
      kind: "respuesta",
      text: withIntro(SAY.media, input),
      link: null,
      topicId: null,
      faqId: null,
      written: false,
    }

  // Después de «¿quieres que te pase con Soporte?»: un sí, o insistir, lo pasa; un no, se despide.
  if (input.offered) {
    if (
      YES.test(plain) ||
      INSISTS.test(plain) ||
      (matches(BLOCKED, plain) && plain.split(" ").length <= 6)
    ) {
      return {
        kind: "soporte",
        text: SAY.soporte,
        why: "Dijo que sí a pasar con Soporte o insistió",
      }
    }
    if (NO.test(plain))
      return {
        kind: "respuesta",
        text: SAY.noThanks,
        link: null,
        topicId: null,
        faqId: null,
        written: false,
      }
  }

  const talk = helpSmallTalk(question)
  if (talk) {
    const greeting = talk.startsWith("Hola")
    return {
      kind: "respuesta",
      text: greeting
        ? withIntro("Dime qué quieres hacer en el sistema o qué no encuentras.", {
            ...input,
            firstReply: true,
          })
        : talk,
      link: null,
      topicId: null,
      faqId: null,
      written: false,
    }
  }

  // Lo escrito igual que en la guía responde sin modelo (también lo que se toca de una duda).
  const exact = exactHelpOption(question, topics)
  // A un modelo viaja sin cifras ni correos; si lo que queda puede ser el dato de una persona, no viaja.
  const forModel = exact ? null : withoutPersonData(question)

  // Lo que no es de la guía: primero las palabras; si no dicen nada, el decisor.
  let intent = exact ? null : ariadnaRuleIntent(question, input.product)
  let decidedPromise: Promise<HelpDecided> | null = null
  if (!exact && !intent && forModel !== null && decider) {
    const state = `Mensaje: ${forModel.replace(/\s+/g, " ")}`
    const [read, decided] = await Promise.all([
      decider
        .decide(state, [ariadnaChatQuestion(input.product)])
        .then(readAriadnaChatIntent, () => null),
      decideHelp(forModel, null, topics, texts, decider, writer, previous),
    ])
    intent = read === "cobro" || read === "paciente" || read === "permiso" ? read : null
    decidedPromise = Promise.resolve(decided)
  }

  if (intent === "cobro") {
    const other = otherProduct(plain, input.product)
    return {
      kind: "administracion",
      text: withIntro(SAY.administracion, input, false),
      why: other
        ? `Pregunta por ${other}, otro producto`
        : "Es de cobros, su plan o comprar algo más",
    }
  }
  if (intent === "paciente") {
    return {
      kind: "paciente",
      text: SAY.paciente(input.product),
      why: "Parece un paciente de la clínica, no alguien del equipo",
    }
  }
  if (intent === "permiso" && input.offered)
    return { kind: "soporte", text: SAY.soporte, why: "Insistió en que no le deja" }
  if (intent === "datos") return dataReply(question, topics, input)

  const decided: HelpDecided = exact
    ? {
        via: "exacta",
        selection: { verdict: "seguro", shown: [exact], offered: [], top: null },
        why: "ninguna",
      }
    : decidedPromise
      ? await decidedPromise
      : forModel === null
        ? await decideHelp(question, null, topics, texts, null)
        : await decideHelp(forModel, null, topics, texts, decider, writer, previous)
  const { selection } = decided
  if (intent === "permiso") {
    // Lo que la guía dice de eso (una cita ya atendida no se cancela) va primero; lo de su cuenta no se ve por aquí.
    const [first] = selection.verdict === "seguro" ? selection.shown : []
    const guide = first && !decided.written ? `${helpAnswerText(first)} ` : ""
    return {
      kind: "oferta",
      text: withIntro(`${guide}${SAY.offerWhy}`, input, false),
      why: "No le deja hacer algo: por aquí no se ve su cuenta",
      topicId: first?.topic.id ?? null,
      faqId: first?.kind === "faq" ? first.faq.id : null,
    }
  }
  if (selection.verdict === "seguro" && selection.shown[0]) {
    const [first] = selection.shown
    const body =
      decided.written ?? selection.shown.map((option) => helpAnswerText(option)).join(" ")
    const link = linkOf(first, input.appOrigin)
    return {
      kind: "respuesta",
      text: withIntro(link ? `${body}${PARAGRAPH}Te dejo la pantalla: ${link}` : body, input),
      link,
      topicId: first.topic.id,
      faqId: first.kind === "faq" ? first.faq.id : null,
      written: Boolean(decided.written),
    }
  }
  if (selection.verdict === "datos") return dataReply(question, topics, input)
  if (selection.verdict === "duda" && selection.offered.length > 0) {
    return {
      kind: "oferta",
      text: withIntro(SAY.offerDoubt(selection.offered.map(choiceText)), input, false),
      why: "No está segura de cuál respuesta de la guía es",
    }
  }
  return {
    kind: "oferta",
    text: withIntro(SAY.offerNone, input, false),
    why: decided.why === "sin_jev" ? "No pudo buscar en la guía" : "No está en la guía",
  }
}
