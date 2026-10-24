/**
 * Entender una pregunta a Argos sobre las cifras de Reportes (ADR 0070),
 * con la misma regla del pedido con palabras (ADR 0015): el modelo de decisión
 * solo elige entre opciones cerradas (de qué trata, qué cifra, cómo agruparla)
 * y recibe nada más que el texto de la pregunta. El periodo, la sede y el
 * canal se leen del texto con reglas: un modelo de decisión no lee bien fechas
 * ni nombres. Nunca se calcula ni se escribe una cifra aquí.
 *
 * Las cifras van en una pregunta por área para que cada lista sea corta (los
 * modelos de decisión tienden a la primera opción en listas largas); con la
 * probabilidad del área y la de su cifra se decide si se entendió, si hay que
 * preguntar entre dos o tres, o si no está en la lista.
 */
import type { AdminAnswer, AdminDecider, AdminQuestion } from "./admin-request.js"
import { FIGURE_AREAS, type FigureArea, type FigureGroup, groupsOf, type ReportFigure, reportFigureOf, visibleFigures, withFigureWords } from "./report-figures.js"
import { addDays, currentMonthIn, REPORT_PERIOD_PATTERN, reportDayOf } from "./report-periods.js"
import { clinicWord, type ProductAgentTexts, productName } from "./product-agent.js"

/** De qué trata la pregunta: solo `cifra` se responde. */
export const REPORT_QUESTION_TOPICS = ["cifra", "clinico", "accion", "otro"] as const
export type ReportQuestionTopic = (typeof REPORT_QUESTION_TOPICS)[number]

/** Por debajo de esto, la cifra no se da por entendida: se pregunta entre las más probables. */
export const REPORT_SURE = 0.5
/** La primera tiene que sacarle esto a la segunda para no preguntar. */
export const REPORT_MARGIN = 0.15
/** «No está en la lista» con al menos esta probabilidad: se dice «todavía no sé». */
export const REPORT_NONE = 0.5
/** Que no trata de una cifra, con al menos esta probabilidad. */
export const REPORT_OFF_TOPIC = 0.6
/** Pide un filtro que ninguna cifra tiene (por edad, por distrito, un margen), con al menos esta probabilidad. */
export const REPORT_UNSUPPORTED = 0.7
/** Una opción que se ofrece al preguntar o como «lo más cercano» necesita al menos esto. */
const REPORT_CANDIDATE = 0.05

/**
 * Lo clínico se reconoce también por sus palabras: «¿cuántos pacientes tienen
 * diabetes?» empieza como una cifra, pero no le toca (medido con Jev: lo leía
 * como una cifra que no sabe).
 */
const CLINICAL_RE = /\b(diabet\w*|hipertens\w*|alergi\w*|alergic\w*|caries|diagnostic\w*|diagnost\w*|enfermedad\w*|embaraz\w*|medicament\w*|penicilin\w*|antecedente\w*|periodontitis|gingivitis|historia clinica)\b/

const NONE = "ninguna"

const areaWords = (texts: ProductAgentTexts): Record<FigureArea, string> => ({
  dinero: "Dinero: lo cobrado, los gastos, lo que queda, las deudas, las comisiones, lo que se debe pagar.",
  pacientes: "Pacientes: los nuevos, los que nos buscaron, los presupuestos aceptados, cómo nos conocieron, los que vuelven o dejaron de venir, los controles.",
  agenda: "Agenda: las citas atendidas, las inasistencias, las canceladas, qué tan llena está la agenda, las horas libres, la espera en sala.",
  agente: `Los agentes de ${productName(texts)}: lo que hizo y trajo el agente, las conversaciones que atendió, las citas que agendó o recuperó, lo que cuesta, cuánto se tarda en responder, y las consultas dictadas con Clío.`,
})

const groupOptions = (texts: ProductAgentTexts): Array<{ value: FigureGroup; description: string }> => [
  { value: "total", description: "Una sola cifra, sin separarla: «¿cuánto…?», «¿cuántos…?»." },
  {
    value: "profesional",
    description: `Por profesional${texts.reports.professional ? `, ${texts.reports.professional}` : ""}: «¿quién…?», «¿qué doctor…?»${texts.reports.eachProfessional ? `, «${texts.reports.eachProfessional}»` : ""}.`,
  },
  { value: "sede", description: "Por sede o local: comparar las sedes, «en cada sede»." },
  { value: "mes", description: "Por mes, cómo cambió con el tiempo, la tendencia, mes a mes." },
  { value: "canal", description: "Por canal: WhatsApp, Instagram, Messenger, chat web, correo." },
  { value: "tratamiento", description: `Por tratamiento o servicio${texts.reports.treatments ? `: ${texts.reports.treatments}` : ""}.` },
  { value: "medio", description: "Por medio de pago: efectivo, tarjeta, transferencia, Yape." },
  { value: "categoria", description: "Por tipo de gasto: alquiler, laboratorio, materiales, personal." },
  { value: "como_nos_conocio", description: "Por cómo nos conocieron: recomendación, redes sociales, Google." },
  { value: "antiguedad", description: "Por antigüedad de la deuda: hace cuántos días deben." },
]

/** Las preguntas que se le hacen al modelo, todas cerradas. Solo las cifras que puede ver quien pregunta. */
export function reportQuestions(texts: ProductAgentTexts, figures: ReportFigure[] = visibleFigures(true)): AdminQuestion[] {
  return [
    {
      id: "tema",
      kind: "choice",
      instructions: `Quien dirige una ${clinicWord(texts)} le pregunta algo a su asistente de reportes. ¿De qué trata la pregunta?`,
      options: [
        { value: "cifra", description: "Pide una cifra o un dato de cómo va la clínica: dinero, pacientes, citas, el agente. «¿Cuánto…?», «¿cuántos…?», «¿quién…?», «compara…»." },
        {
          value: "clinico",
          description: `Pregunta por la salud o la historia clínica de los pacientes: enfermedades, diagnósticos, alergias, ${texts.reports.clinicalRecord ? `${texts.reports.clinicalRecord}, ` : ""}tratamientos de una persona.`,
        },
        { value: "accion", description: "Pide hacer algo, no saber algo: escribirles, enviar, llamar, recordar, prender o cambiar algo, agendar." },
        { value: "otro", description: "Saluda o pregunta algo que no es de la clínica." },
      ],
    },
    {
      id: "area",
      kind: "choice",
      instructions: "Si pide una cifra, ¿de qué parte de la clínica es?",
      options: FIGURE_AREAS.map((area) => ({ value: area, description: areaWords(texts)[area] })),
    },
    ...FIGURE_AREAS.map(
      (area): AdminQuestion => ({
        id: `cifra_${area}`,
        kind: "choice",
        instructions: `Si la pregunta es de ${area === "agente" ? "el agente" : area}, ¿cuál de estas cifras pide? Elige «${NONE}» si no pide ninguna de ellas.`,
        options: [
          ...figures
            .filter((figure) => figure.area === area)
            .map((official) => withFigureWords(official, texts))
            .map((figure) => ({ value: figure.key, description: `${figure.name}: ${figure.describes}` })),
          { value: NONE, description: "Pide otra cifra que no está aquí." },
        ],
      }),
    ),
    {
      id: "agrupar",
      kind: "choice",
      instructions: "¿Cómo quiere ver esa cifra?",
      options: groupOptions(texts),
    },
    {
      id: "fuera",
      kind: "yesno",
      instructions:
        "¿Pide separar o filtrar la cifra por algo distinto del periodo, la sede, el profesional, el canal, el tratamiento, el medio de pago, el tipo de gasto o cómo nos conocieron? Por ejemplo: por edad, sexo, distrito o barrio, aseguradora, o un costo o un margen de cada tratamiento.",
      criteria: {
        yes: "Pide un filtro o una cuenta así: «mayores de 40», «de Miraflores», «el margen después del laboratorio», «la edad promedio».",
        no: "Solo pide la cifra, quizá por periodo, sede, profesional, canal, tratamiento, medio de pago, tipo de gasto o cómo nos conocieron.",
      },
    },
  ]
}

// --- Lo que se lee con reglas ------------------------------------------------------------

function plain(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const MONTH_RE = new RegExp(`\\b(${[...MONTHS, "setiembre"].join("|")})\\b(?:\\s+(?:de|del)\\s+(\\d{4}|ano pasado|este ano))?`)

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * El periodo que nombra la pregunta, como clave de Reportes; null si no nombra
 * ninguno (vale el de la pantalla). Un mes sin año que todavía no llegó este
 * año es el del año pasado: «en diciembre» dicho en octubre es diciembre pasado.
 */
export function readReportPeriod(text: string, timezone: string, now: Date): string | null {
  const t = plain(text)
  const current = currentMonthIn(timezone, now)
  const today = reportDayOf(timezone, now)
  if (/\b(este|el presente) mes\b|\ben lo que va del mes\b/.test(t)) return "este_mes"
  if (/\b(el )?mes (pasado|anterior)\b/.test(t)) return "mes_pasado"
  if (/\b(ultimos|ultimo) (3|tres) meses\b|\bultimo trimestre\b/.test(t)) return "ultimos_3_meses"
  if (/\b(ano|año) pasado\b/.test(t) && !MONTH_RE.test(t)) {
    const year = current.year - 1
    return `${year}-01-01..${year}-12-31`
  }
  if (/\b(este|en el) ano\b|\ben lo que va del ano\b/.test(t)) return "este_ano"
  if (/\bhoy\b/.test(t)) return `${today}..${today}`
  if (/\bayer\b/.test(t)) {
    const day = addDays(today, -1)
    return `${day}..${day}`
  }
  // «La semana pasada» es de lunes a domingo, como el resumen del lunes; «los últimos 7 días», hasta ayer.
  if (/\b(semana pasada|semana anterior)\b/.test(t)) {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7
    const monday = addDays(today, -weekday - 7)
    return `${monday}..${addDays(monday, 6)}`
  }
  if (/\b(ultimos|ultima) (7|siete) dias\b|\bultima semana\b/.test(t)) return `${addDays(today, -7)}..${addDays(today, -1)}`
  if (/\bultimos (30|treinta) dias\b/.test(t)) return `${addDays(today, -30)}..${addDays(today, -1)}`
  // «En 2025»: un año entero ya cerrado; el de este año es «este año».
  const year = /\b(?:en|del|de) (?:el )?(20\d{2})\b/.exec(t)
  if (year && !MONTH_RE.test(t)) {
    const asked = Number(year[1])
    if (asked === current.year) return "este_ano"
    if (asked < current.year && asked >= current.year - 1) return `${asked}-01-01..${asked}-12-31`
  }
  const month = MONTH_RE.exec(t)
  if (month) {
    const index = month[1] === "setiembre" ? 8 : MONTHS.indexOf(month[1]!)
    const yearText = month[2]
    let year = yearText && /^\d{4}$/.test(yearText) ? Number(yearText) : yearText === "ano pasado" ? current.year - 1 : current.year
    if (!yearText && index + 1 > current.month) year -= 1
    const key = monthKey(year, index + 1)
    const monthsAgo = (current.year - year) * 12 + (current.month - (index + 1))
    if (monthsAgo < 0 || monthsAgo > 23) return null
    if (monthsAgo === 0) return "este_mes"
    return REPORT_PERIOD_PATTERN.test(key) ? key : null
  }
  return null
}

/** La sede que nombra la pregunta («en la sede Norte», «en Miraflores»); null si no nombra ninguna. */
export function readReportBranch(text: string, branches: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  const t = plain(text)
  const found = branches.filter((branch) => {
    const name = plain(branch.name)
    const bare = name.replace(/^sede\s+/, "").trim()
    return t.includes(name) || (bare.length >= 4 && new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))
  })
  return found.length === 1 ? found[0]! : null
}

/** Pide todas las sedes juntas: deja de lado la sede de la pantalla. */
export function asksAllBranches(text: string): boolean {
  return /\b(todas las sedes|toda la clinica|en total en la clinica)\b/.test(plain(text))
}

const CHANNEL_RE: Array<[string, RegExp]> = [
  ["whatsapp", /\bwhats ?app\b|\bwsp\b|\bwasap\b/],
  ["instagram", /\binstagram\b|\binsta\b|\big\b/],
  ["messenger", /\bmessenger\b|\bfacebook\b|\bfb\b/],
  ["telegram", /\btelegram\b/],
  ["webchat", /\bchat (web|de la (pagina|web))\b|\bpagina web\b/],
  ["email", /\bcorreo\b|\bemail\b|\bmail\b/],
]

/** El canal que nombra la pregunta («por Instagram»); null si ninguno o más de uno. */
export function readReportChannel(text: string): string | null {
  const t = plain(text)
  const found = CHANNEL_RE.filter(([, pattern]) => pattern.test(t)).map(([key]) => key)
  return found.length === 1 ? found[0]! : null
}

/** Agrupaciones que la pregunta dice con todas las letras: valen más que lo que elija el modelo. */
function readGroup(text: string): FigureGroup | null {
  const t = plain(text)
  if (/\bpor sede|\bcada sede|\bentre (las )?sedes|\bcompar\w* (las |mis )?(dos |tres |cuatro )?sedes|\blas sedes\b/.test(t)) return "sede"
  if (/\bpor mes\b|\bmes a mes\b|\bcada mes\b|\btendencia\b|\bevolucion\b/.test(t)) return "mes"
  if (/\bpor (profesional|doctor|doctora|dentista|odontolog)|\bcada (profesional|doctor|doctora|dentista|odontolog)|\bque (profesional|doctor|doctora|dentista|odontolog)|\bquien (tiene|cobro|cobra|atendio|atiende|hizo|genera|genero)\b/.test(t)) return "profesional"
  if (/\bpor (que )?canal|\bpor donde\b|\bque canal\b/.test(t)) return "canal"
  if (/\bpor (medio|metodo|forma) de pago|\bcomo (me )?pagan\b/.test(t)) return "medio"
  if (/\bpor tratamiento|\bpor servicio|\bque tratamiento|\bque servicio/.test(t)) return "tratamiento"
  if (/\bpor (tipo|categoria) de gasto|\ben que (se )?gast/.test(t)) return "categoria"
  if (/\bcomo nos conoc|\bcomo se enter|\bpor que vinieron\b/.test(t)) return "como_nos_conocio"
  if (/\bantiguedad\b|\bhace cuanto (me )?deben\b/.test(t)) return "antiguedad"
  return null
}

// --- Interpretar -------------------------------------------------------------------------

export interface ReportCandidate {
  figure: string
  probability: number
}

export type ReportInterpretation =
  | { kind: "cifra"; figure: string; group: FigureGroup; focus: string | null; period: string | null; branch: { id: string; name: string } | null; allBranches: boolean }
  | { kind: "pregunta"; candidates: ReportCandidate[]; group: FigureGroup; period: string | null; branch: { id: string; name: string } | null; allBranches: boolean }
  | { kind: "no_sabe"; closest: ReportCandidate[] }
  | { kind: "clinico" }
  | { kind: "accion" }
  | { kind: "otro" }

export interface ReportInterpretationResult {
  interpretation: ReportInterpretation
  model: string | null
  usage: { inputTokens: number; outputTokens: number } | null
}

function choiceOf(answers: AdminAnswer[], id: string): { value: string; probabilities: Record<string, number> | null } | null {
  const found = answers.find((answer) => answer.id === id && answer.kind === "choice")
  if (!found || !("choice" in found)) return null
  const probabilities = "probabilities" in found && found.probabilities ? (found.probabilities as Record<string, number>) : null
  return { value: found.choice, probabilities }
}

function yesOf(answers: AdminAnswer[], id: string): number {
  const found = answers.find((answer) => answer.id === id && answer.kind === "yesno")
  return found && "probability" in found ? found.probability : 0
}

/** La probabilidad de cada opción; sin distribución (el modelo de chat), la elegida vale 1. */
function distribution(choice: { value: string; probabilities: Record<string, number> | null }): Record<string, number> {
  return choice.probabilities ?? { [choice.value]: 1 }
}

/**
 * Entiende una pregunta. Una sola llamada al modelo de decisión, con el texto
 * de la persona y nada de la clínica: ni nombres, ni sedes, ni cifras. Si el
 * modelo falla, lanza: quien llama dice que ahora no puede.
 */
export async function interpretReportQuestion(
  text: string,
  decider: AdminDecider,
  context: {
    timezone: string
    now: Date
    branches: Array<{ id: string; name: string }>
    billing: boolean
    /** Las palabras del producto de la clínica (`productAgentTexts`). */
    texts: ProductAgentTexts
  },
): Promise<ReportInterpretationResult> {
  const question = text.trim().slice(0, 500)
  // Lo clínico se reconoce antes de llamar a nadie: no viaja al proveedor ni cuenta para el tope.
  if (CLINICAL_RE.test(plain(question))) return { interpretation: { kind: "clinico" }, model: null, usage: null }
  const figures = visibleFigures(context.billing)
  const result = await decider.decide(question, reportQuestions(context.texts, figures))
  const base = { model: result.model, usage: result.usage }
  const topic = choiceOf(result.answers, "tema")
  const topics = topic ? distribution(topic) : { cifra: 1 }
  const offTopic = (["clinico", "accion", "otro"] as const).find((key) => (topics[key] ?? 0) >= REPORT_OFF_TOPIC)
  if (offTopic) return { interpretation: offTopic === "clinico" ? { kind: "clinico" } : offTopic === "accion" ? { kind: "accion" } : { kind: "otro" }, ...base }

  // Cada cifra pesa lo que su área por lo que ella dentro de su área.
  const area = choiceOf(result.answers, "area")
  const areas = area ? distribution(area) : {}
  const scores = new Map<string, number>()
  let none = 0
  for (const key of FIGURE_AREAS) {
    const weight = areas[key] ?? 0
    const pick = choiceOf(result.answers, `cifra_${key}`)
    if (!pick || weight === 0) continue
    for (const [value, probability] of Object.entries(distribution(pick))) {
      if (value === NONE) none += weight * probability
      else if (figures.some((figure) => figure.key === value)) scores.set(value, (scores.get(value) ?? 0) + weight * probability)
    }
  }
  const ruled = readGroup(question)
  const channel = readReportChannel(question)
  // Lo que la pregunta dice con todas las letras («qué tratamiento», «por antigüedad», «por Instagram»)
  // solo lo responde una cifra que se puede agrupar así: las demás no cuentan, si queda alguna.
  const wanted = ruled ?? (channel ? "canal" : null)
  const all = [...scores].map(([figure, probability]) => ({ figure, probability })).sort((a, b) => b.probability - a.probability)
  // Una cifra que no se agrupa así puede tener otra que sí (`insteadFor`): «pacientes nuevos por Instagram» son los que nos buscaron por ahí.
  const moved = wanted
    ? [
        ...all
          .reduce((byFigure, item) => {
            const target = groupsOf(reportFigureOf(item.figure)!).includes(wanted) ? item.figure : (reportFigureOf(item.figure)?.insteadFor?.[wanted] ?? item.figure)
            byFigure.set(target, (byFigure.get(target) ?? 0) + item.probability)
            return byFigure
          }, new Map<string, number>())
          .entries(),
      ]
        .map(([figure, probability]) => ({ figure, probability }))
        .filter((item) => figures.some((figure) => figure.key === item.figure))
        .sort((a, b) => b.probability - a.probability)
    : all
  const fitting = wanted ? moved.filter((item) => item.probability >= REPORT_CANDIDATE && groupsOf(reportFigureOf(item.figure)!).includes(wanted)) : []
  const ranked = fitting.length > 0 ? fitting : all
  const candidates = ranked.filter((item) => item.probability >= REPORT_CANDIDATE).slice(0, 3)
  const top = ranked[0]
  const asksMissing = yesOf(result.answers, "fuera") >= REPORT_UNSUPPORTED
  if (!top || asksMissing || none >= REPORT_NONE || none > top.probability) return { interpretation: { kind: "no_sabe", closest: candidates.slice(0, 2) }, ...base }

  const chosen = choiceOf(result.answers, "agrupar")
  const period = readReportPeriod(question, context.timezone, context.now)
  // «¿Cuánto gané en septiembre?» nombra un periodo, no pide «por mes» (medido con Jev): sin palabras que lo pidan, va en total.
  const modelGroup = (chosen?.value === "mes" && period !== null ? "total" : (chosen?.value ?? "total")) as FigureGroup
  const branch = readReportBranch(question, context.branches)
  const allBranches = asksAllBranches(question)
  const groupFor = (figureKey: string): FigureGroup => {
    const figure = reportFigureOf(figureKey)
    // Si la cifra no tiene esa agrupación, `computeFigure` responde con la suya y lo dice.
    return ruled ?? (channel && figure && groupsOf(figure).includes("canal") ? "canal" : modelGroup)
  }
  const second = ranked[1]?.probability ?? 0
  // Si lo que pide con todas las letras deja una sola cifra posible, es esa: no hay entre qué preguntar.
  const only = fitting.length === 1
  if (!only && (top.probability < REPORT_SURE || top.probability - second < REPORT_MARGIN)) {
    return { interpretation: { kind: "pregunta", candidates, group: groupFor(top.figure), period, branch, allBranches }, ...base }
  }
  const group = groupFor(top.figure)
  return {
    interpretation: { kind: "cifra", figure: top.figure, group, focus: group === "canal" ? channel : null, period, branch, allBranches },
    ...base,
  }
}

// ------------------------------------------------ sin modelo real ---

const FIGURE_WORDS: Array<[string, RegExp]> = [
  ["agente_trajo", /\b(me )?trajo el agente|\baporto el agente|\bvale la pena el agente/],
  ["agente_pagado", /\b(pague|pagamos|cuesta|costo|cobra) (por )?el agente|\bfactura del agente/],
  ["agente_citas", /\bcitas? (que )?(agendo|reservo) el agente|\bagendo el agente/],
  ["agente_recuperadas", /\brecuper/],
  ["agente_dictadas", /\bdictad/],
  ["primera_respuesta", /\btarda\w* en responder|\bprimera respuesta|\bvelocidad de respuesta/],
  ["pasaron_al_equipo", /\bpaso al equipo|\bpasaron al equipo|\bderiv/],
  ["agente_conversaciones", /\bconversaciones\b.*\bagente|\bresolvio solo|\batendio el agente/],
  ["no_vinieron", /\binasistencia|\bfalt(aron|an|o)\b|\bno (vino|vinieron|asistio|asistieron)\b|\bausentismo/],
  ["canceladas", /\bcancel/],
  ["agenda_ocupada", /\bocupad|\bocupacion|\bllena la agenda/],
  ["horas_libres", /\bhoras libres|\bhuecos|\btiempo libre/],
  ["espera_en_sala", /\bespera\w*\b.*\bsala|\bcuanto esperan/],
  ["atendidas", /\bcitas atendidas|\bcuantas citas|\bcuantas consultas|\batendimos/],
  ["deuda_vencida", /\bhace mas de (30|treinta) dias|\bmoros|\bdeuda vencida|\batrasad/],
  ["te_deben", /\bme deben|\bnos deben|\bte deben|\bdeuda|\bsaldo/],
  ["lo_que_debes", /\b(debo|debemos) pagar|\blo que debo|\bproveedores/],
  ["lo_que_deja", /\butilidad|\bganancia neta|\blo que (me )?queda|\blo que deja/],
  ["comisiones", /\bcomision/],
  ["gastos", /\bgast/],
  ["lo_que_viene", /\blo que viene|\bpor cobrar de presupuestos|\btratamientos aceptados/],
  ["valor_paciente", /\bvale un paciente|\bticket promedio/],
  ["cobrado", /\bcobr|\bgane\b|\bganamos|\bingres|\bventas?\b|\bfactur/],
  ["como_nos_conocieron", /\bcomo nos conoc|\bcomo se enter/],
  ["nos_buscaron", /\bnos buscaron|\bescribieron por primera|\bllegaron por|\bcontactaron|\bpor donde (nos )?escrib/],
  ["aceptaron", /\bacept|\bconversion|\bcierre de ventas/],
  ["sin_venir", /\bdejaron de venir|\bsin venir|\binactivos|\bperdidos/],
  ["volvieron", /\bvolvieron|\bregres|\bfideli|\bretencion/],
  ["activos", /\bpacientes activos|\bcartera de pacientes|\bcuantos pacientes tengo/],
  ["controles", /\bcontrol/],
  ["dejaron_de_escribir", /\bdejaron de escribir|\bdejaron de responder/],
  ["pacientes_nuevos", /\bpacientes nuevos|\bnuevos pacientes|\bnuevos\b/],
]

/**
 * Entiende por palabras clave, sin llamar a nadie. Es el doble del modelo para
 * desarrollo y pruebas (cuando la clínica usa el modelo de demostración): deja
 * recorrer la pantalla de forma determinista y no acredita a ningún proveedor.
 */
export function keywordReportDecider(): AdminDecider {
  return {
    async decide(state, questions) {
      const text = plain(state)
      const figure = FIGURE_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
      const area = figure ? (reportFigureOf(figure)?.area ?? null) : null
      const topic = /\b(diabet|alergi|hipertens|caries|diagnost|enfermedad|embaraz)/.test(text)
        ? "clinico"
        : /^(escribe|escribeles|envia|enviales|manda|mandales|llama|recuerda|prende|apaga|agenda)\b/.test(text)
          ? "accion"
          : figure
            ? "cifra"
            : /\b(cuanto|cuantos|cuantas|cual|cuales|quien|compara|promedio|porcentaje)\b/.test(text)
              ? "cifra"
              : "otro"
      const answers = questions.map((question): AdminAnswer => {
        if (question.id === "tema") return { id: question.id, kind: "choice", choice: topic, confidence: 0.9 }
        if (question.id === "area") return { id: question.id, kind: "choice", choice: area ?? "dinero", confidence: 0.9 }
        if (question.id === "agrupar") return { id: question.id, kind: "choice", choice: readGroup(state) ?? "total", confidence: 0.9 }
        if (question.id === "fuera") return { id: question.id, kind: "yesno", probability: /\b(edad|mayores de|menores de|distrito|barrio|sexo|aseguradora|margen|costo del)\b/.test(text) ? 0.95 : 0.05 }
        const own = question.id === `cifra_${area}` && figure ? figure : NONE
        return { id: question.id, kind: "choice", choice: own, confidence: 0.9 }
      })
      return { answers, model: "palabras-clave", usage: null }
    },
  }
}

/** Las agrupaciones que ofrece una respuesta para seguir preguntando, en este orden. */
export const FOLLOW_UP_GROUPS: FigureGroup[] = ["sede", "profesional", "mes", "canal"]

