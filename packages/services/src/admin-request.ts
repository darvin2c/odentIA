import { ADMIN_LINES, type AdminLine, type AdminLineKey, adminLineOf, CUSTOM_LINES, say } from "./admin-lines.js"
import { clinicWord, type ProductAgentTexts } from "./product-agent.js"

/**
 * Pedirle algo a Argos con palabras. El modelo solo **entiende**: de
 * qué línea se habla y qué se quiere hacer con ella, eligiendo entre opciones
 * cerradas. Lo demás es código: los números y las horas del pedido se leen del
 * texto con reglas, y el resultado es un cambio sobre piezas que el sistema ya
 * conoce (una línea del catálogo, sus dos partes, su plazo). Nunca redacta un
 * mensaje, nunca elige a quién escribirle y nunca aplica nada: devuelve una
 * propuesta que una persona prende, guarda o descarta.
 *
 * Lo que no reconoce se dice como «no se puede», con el motivo: no se inventa
 * una pieza para complacer el pedido.
 */

/** Puerto del modelo de decisión, igual en forma al del paquete del agente. */
export type AdminQuestion =
  | { id: string; kind: "yesno"; instructions: string; criteria?: { yes: string; no: string } }
  | { id: string; kind: "choice"; instructions: string; options: Array<{ value: string; description?: string }> }

export type AdminAnswer =
  | { id: string; kind: "yesno"; probability: number }
  /** `probabilities`: la de cada opción, si el modelo la entrega (Jev sí; el modelo de chat no). */
  | { id: string; kind: "choice"; choice: string; confidence: number | null; probabilities?: Record<string, number> | null }
  | { id: string; kind: string }

export interface AdminDecider {
  decide(
    state: string,
    questions: AdminQuestion[],
  ): Promise<{ answers: AdminAnswer[]; model: string; usage: { inputTokens: number; outputTokens: number } | null }>
}

export type AdminIntent = "prender" | "apagar" | "cambiar" | "eliminar"

export interface AdminChanges {
  enabled?: boolean
  agentPart?: boolean
  teamPart?: boolean
  days?: number
  hoursBefore?: number[]
  /** Horas de espera, en las líneas que esperan horas y no días. */
  delayHours?: number
  /** Hora del día a la que sale (0–23), con la hora de la sede. */
  hour?: number
}

export interface AdminInterpretation {
  /** El modelo reconoció de qué línea se habla y qué se quiere. */
  understood: boolean
  key: AdminLineKey | null
  intent: AdminIntent | null
  changes: AdminChanges
  /** Lo que pidió y no se puede, cada cosa con su motivo. */
  unsupported: string[]
  /** Para medir: modelo que decidió y tokens de la llamada. */
  model: string | null
  usage: { inputTokens: number; outputTokens: number } | null
}

/** Por debajo de esta confianza no se da por entendido: se pregunta de nuevo, no se adivina. */
export const ADMIN_MIN_CONFIDENCE = 0.5
const YES = 0.7

const WORD_NUMBERS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  quince: 15, veinte: 20, treinta: 30, cuarenta: 40, sesenta: 60, noventa: 90,
}
const NUMBER = `(\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})`

function numberOf(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : (WORD_NUMBERS[raw] ?? Number.NaN)
}

function plain(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/**
 * Los números del pedido, leídos con reglas (un modelo de decisión no cuenta
 * bien): «3 días», «una semana», «2 horas antes», «a las 10», «a las 4 de la tarde».
 */
export function readNumbers(text: string): { days: number | null; hours: number | null; hour: number | null; week: boolean } {
  const t = plain(text)
  const days = new RegExp(`${NUMBER}\\s*dias?\\b`).exec(t)
  const weeks = new RegExp(`${NUMBER}\\s*semanas?\\b`).exec(t)
  const hours = new RegExp(`${NUMBER}\\s*horas?\\b`).exec(t)
  const at = /\ba las?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?\s?m\.?|p\.?\s?m\.?|de la (?:manana|tarde|noche))?/.exec(t)
  let hour: number | null = null
  if (at) {
    hour = Number(at[1])
    const suffix = (at[3] ?? "").replace(/[.\s]/g, "")
    if ((suffix === "pm" || suffix.includes("tarde") || suffix.includes("noche")) && hour < 12) hour += 12
    if (hour > 23) hour = null
  }
  return {
    days: days ? numberOf(days[1]!) : weeks ? numberOf(weeks[1]!) * 7 : null,
    hours: hours ? numberOf(hours[1]!) : null,
    hour,
    week: !!weeks,
  }
}

function describeOption(line: AdminLine, recallMonths: number): string {
  return `${line.name}: ${line.trigger(line.defaultDays, recallMonths)}. ${line.agent ? `El agente ${say(line.agent.does)}` : line.team.does}.`
}

/** Las preguntas que se le hacen al modelo, todas con opciones cerradas. */
export function adminQuestions(
  texts: ProductAgentTexts,
  lines: readonly AdminLine[] = [...ADMIN_LINES, ...CUSTOM_LINES],
): AdminQuestion[] {
  return [
    {
      id: "linea",
      kind: "choice",
      instructions:
        `La persona que administra una ${clinicWord(texts)} le pide algo a su asistente. ¿De cuál de estas tareas automáticas está hablando? Elige «ninguna» si no habla de ninguna de ellas.`,
      options: [...lines.map((line) => ({ value: line.key, description: describeOption(line, texts.recallMonths) })), { value: "ninguna", description: "No habla de ninguna de estas tareas." }],
    },
    {
      id: "intencion",
      kind: "choice",
      instructions: "¿Qué quiere hacer con esa tarea automática?",
      options: [
        { value: "prender", description: "Quiere que empiece a hacerse, crearla o activarla." },
        { value: "apagar", description: "Quiere que deje de hacerse, pausarla o desactivarla." },
        { value: "cambiar", description: "Ya existe y quiere ajustar cómo se hace: cuándo, quién lo hace o qué pasa si no se puede." },
        { value: "eliminar", description: "Quiere borrarla del todo." },
        { value: "otra", description: "Pide otra cosa." },
      ],
    },
    {
      id: "persona",
      kind: "yesno",
      instructions: "¿Pide que lo haga una persona del equipo EN LUGAR del agente (que el agente no escriba)?",
      criteria: { yes: "Dice que llame o lo haga una persona, y no el agente.", no: "No pide quitar al agente." },
    },
    {
      id: "respaldo",
      kind: "yesno",
      instructions: "¿Pide que, ADEMÁS, quede una tarea o una llamada para una persona cuando el agente no pueda escribir?",
      criteria: { yes: "Pide una tarea o llamada de respaldo.", no: "No habla de una tarea de respaldo." },
    },
    {
      id: "sin_respaldo",
      kind: "yesno",
      instructions: "¿Pide que NO se creen tareas para el equipo cuando el agente no pueda escribir?",
      criteria: { yes: "Pide quitar las tareas de respaldo.", no: "No pide quitarlas." },
    },
    {
      id: "fuera",
      kind: "yesno",
      instructions:
        "¿Pide algo que va más allá de activar, pausar, cambiar cuándo se hace o quién lo hace? Por ejemplo: cambiar el texto del mensaje, ofrecer descuentos o promociones, escribir por otro canal, o escribirle a un grupo distinto de personas.",
      criteria: { yes: "Pide cambiar el contenido, ofrecer algo o un destinatario distinto.", no: "Solo pide activar, pausar, o cambiar cuándo o quién." },
    },
  ]
}

export const OUT_OF_REACH =
  "Cambiar lo que dice el mensaje, ofrecer descuentos o escribir a otras personas no se puede desde aquí: fuera de las 24 horas WhatsApp solo deja el texto que aprobó, y Sofi no ofrece descuentos."

function choice(answers: AdminAnswer[], id: string): { value: string; confidence: number } | null {
  const found = answers.find((answer) => answer.id === id && answer.kind === "choice")
  if (!found || !("choice" in found)) return null
  return { value: found.choice, confidence: found.confidence ?? 1 }
}

function yes(answers: AdminAnswer[], id: string): boolean {
  const found = answers.find((answer) => answer.id === id && answer.kind === "yesno")
  return !!found && "probability" in found && found.probability >= YES
}

/**
 * Entiende un pedido. Una sola llamada al modelo de decisión, con el texto de
 * la persona y nada de la clínica: ni nombres, ni cifras, ni conversaciones.
 * Si el modelo falla, lanza: quien llama dice que ahora no puede y deja todo
 * como estaba.
 */
export async function interpretAdminRequest(
  text: string,
  decider: AdminDecider,
  /** Las palabras del producto de la clínica (`productAgentTexts`). */
  texts: ProductAgentTexts,
): Promise<AdminInterpretation> {
  const request = text.trim().slice(0, 600)
  const result = await decider.decide(request, adminQuestions(texts))
  const line = choice(result.answers, "linea")
  const intent = choice(result.answers, "intencion")
  const base = { model: result.model, usage: result.usage }
  const key = line && line.value !== "ninguna" && line.confidence >= ADMIN_MIN_CONFIDENCE ? adminLineOf(line.value)?.key ?? null : null
  if (!key || !intent || intent.value === "otra" || intent.confidence < ADMIN_MIN_CONFIDENCE) {
    return { understood: false, key, intent: null, changes: {}, unsupported: [], ...base }
  }
  const found = adminLineOf(key)!
  const numbers = readNumbers(request)
  const changes: AdminChanges = {}
  const unsupported: string[] = []
  const asked = intent.value as AdminIntent
  // «Que no escriba el agente» o «sin tareas» apagan una parte, no la línea: si
  // el modelo lo leyó como apagar, vale la instrucción concreta.
  const partOnly = asked === "apagar" && !!found.agent && (yes(result.answers, "persona") || yes(result.answers, "sin_respaldo"))
  const kind: AdminIntent = partOnly ? "cambiar" : asked
  if (kind === "prender") changes.enabled = true
  if (kind === "apagar") changes.enabled = false

  if (yes(result.answers, "persona")) {
    if (found.agent) {
      changes.agentPart = false
      changes.teamPart = true
    }
  } else if (yes(result.answers, "sin_respaldo")) {
    if (found.agent) changes.teamPart = false
    else unsupported.push(`En «${found.name}» la tarea para el equipo es lo único que se hace: para quitarla, apaga la línea.`)
  } else if (yes(result.answers, "respaldo")) {
    changes.teamPart = true
  }

  if (numbers.days !== null) {
    if (found.defaultDays !== null) {
      if (numbers.days >= 1 && numbers.days <= 365) changes.days = numbers.days
      else unsupported.push("El plazo va de 1 a 365 días.")
    } else if (key !== "recordatorio_cita" && !(key === "seguimiento_no_asistencia" && numbers.days === 1)) {
      unsupported.push(`«${found.name}» no tiene un plazo en días que se pueda cambiar.`)
    }
  }
  if (key === "recordatorio_cita") {
    // «Dos días antes», «3 horas antes»: el recordatorio se ajusta por horas.
    const before = [
      ...(numbers.days !== null && numbers.days >= 1 && numbers.days <= 7 ? [numbers.days * 24] : []),
      ...(numbers.hours !== null && numbers.hours >= 1 && numbers.hours <= 168 ? [numbers.hours] : []),
    ]
    if (before.length > 0) changes.hoursBefore = before
    else if (numbers.days !== null || numbers.hours !== null) unsupported.push("El recordatorio sale entre 1 hora y 7 días antes de la cita.")
  } else if (numbers.hours !== null) {
    if (found.delayHours !== undefined && numbers.hours >= 1 && numbers.hours <= 72) changes.delayHours = numbers.hours
    else if (found.delayHours !== undefined) unsupported.push("La espera va de 1 a 72 horas.")
    else unsupported.push(`«${found.name}» no espera horas: ${found.wait(found.defaultDays)?.toLowerCase() ?? "actúa en el momento"}.`)
  }
  if (numbers.hour !== null) {
    if (found.hourAdjustable) changes.hour = numbers.hour
    else unsupported.push(`«${found.name}» no tiene una hora fija de salida que se pueda cambiar.`)
  }
  if (yes(result.answers, "fuera")) unsupported.push(OUT_OF_REACH)
  return { understood: true, key, intent: kind, changes, unsupported, ...base }
}

// ------------------------------------------------ sin modelo real ---

/** De qué línea habla un texto, por palabras: también la usa Argos en Reportes para decir qué prender. */
export const LINE_WORDS: Array<[AdminLineKey, RegExp]> = [
  ["cita_cancelada", /cancel/],
  ["seguimiento_no_asistencia", /falt|inasist|no (vino|vinieron|asist)/],
  ["presupuestos_sin_cita", /presupuesto.*(aceptad|sin cita)/],
  ["seguimiento_presupuesto", /presupuesto/],
  ["recordatorio_control", /control/],
  ["recordatorio_cita", /recuerd|recordator/],
  ["atenciones_sin_firmar", /firm/],
  ["cobranza_vencida", /deud|saldo|cobr|debe/],
  ["seguimiento_comercial", /oportunidad|comercial/],
]

/**
 * Entiende por palabras clave, sin llamar a nadie. Es el doble del modelo para
 * desarrollo y pruebas (cuando la clínica usa el modelo de demostración): deja
 * recorrer la pantalla de forma determinista y no acredita la calidad de
 * ningún proveedor.
 */
export function keywordAdminDecider(): AdminDecider {
  return {
    async decide(state, questions) {
      const text = plain(state)
      const has = (pattern: RegExp) => pattern.test(text)
      const answers = questions.map((question): AdminAnswer => {
        if (question.id === "linea") {
          return { id: question.id, kind: "choice", choice: LINE_WORDS.find(([, words]) => has(words))?.[0] ?? "ninguna", confidence: 0.9 }
        }
        if (question.id === "intencion") {
          const choice = has(/\b(elimina|borra|quita la linea)/)
            ? "eliminar"
            : has(/\b(apaga|pausa|desactiva|deja de|ya no)/)
              ? "apagar"
              : has(/\b(cambia|que salga|en vez|en lugar|ademas|sin tarea)/)
                ? "cambiar"
                : "prender"
          return { id: question.id, kind: "choice", choice, confidence: 0.9 }
        }
        const yes =
          question.id === "persona"
            ? has(/en (vez|lugar) del agente|que no escriba/)
            : question.id === "respaldo"
              ? has(/ademas.*(llam|tarea)|si no puede.*(llam|tarea)/)
              : question.id === "sin_respaldo"
                ? has(/sin tareas?|no (crees|dejes|generes) tareas?/)
                : question.id === "fuera"
                  ? has(/descuento|promoci|%|que diga|otro texto|instagram|sms/)
                  : false
        return { id: question.id, kind: "yesno", probability: yes ? 0.95 : 0.05 }
      })
      return { answers, model: "palabras-clave", usage: null }
    },
  }
}
