/**
 * Un solo nombre para cada estado del presupuesto (tablero 3 de la fase 3),
 * igual en la página de la persona, la atención, Inicio, el portal y lo que
 * dice el agente. Antes había cuatro juegos de palabras para lo mismo («Acepta
 * / Lo piensa», «Pospuesto», «Lo está pensando», «Lo pienso»).
 *
 * Los estados del código no cambian (`borrador`, `presentado`…); aquí solo se
 * dicen. «Aceptó N de M» cuenta las líneas de la opción elegida. Con varios
 * caminos y ninguno elegido, cada tratamiento cuenta una vez y lo que falta es
 * elegir el camino («Aceptó 2 · falta elegir el camino»).
 */

/** Lo mínimo de una línea para decir el estado. */
interface WordLine {
  decision: string | null | undefined
  optionId?: string | null
  /** El tratamiento de la línea: lo común a varias opciones cuenta una vez. */
  planItemId?: string | null
}

/** Lo mínimo de una opción para decir el estado. */
interface WordOption {
  id: string
  decision: string
  /** Su lugar (1 = «Opción A»): con varias y una elegida, se dice cuál. */
  position?: number
}

/** Líneas que cuentan para «Aceptó N de M»: las de la opción elegida, o todas si no hay. */
function decidedLines(lines: readonly WordLine[], options: readonly WordOption[] | undefined): WordLine[] {
  const chosen = options?.find((option) => option.decision === "elegida")
  if (chosen) return lines.filter((line) => line.optionId === chosen.id)
  const seen = new Set<string>()
  return lines.filter((line) => {
    if (line.decision === "no_elegida") return false
    if (!line.planItemId) return true
    if (seen.has(line.planItemId)) return false
    seen.add(line.planItemId)
    return true
  })
}

/** Varios caminos y ninguno elegido todavía. */
function choosingPath(options: readonly WordOption[] | undefined): boolean {
  return !!options && options.length > 1 && !options.some((option) => option.decision === "elegida")
}

/** «Por enviar», «Entregado · espera respuesta», «Aceptó 2 de 3»… */
export function budgetStateText(budget: {
  status: string
  items: readonly WordLine[]
  options?: readonly WordOption[]
}): string {
  switch (budget.status) {
    case "borrador":
      return "Por enviar"
    case "presentado":
      // Impreso, enviado o mostrado en consulta: «Entregado» no supone un canal.
      return "Entregado · espera respuesta"
    case "pospuesto":
      return "Lo piensa"
    case "aceptado": {
      // Con varios caminos, aceptar es elegir uno: «Aceptó todo» junto a «Exodoncia · No
      // elegida» se leía como si hubiera aceptado las dos (QA del 9 nov).
      const chosen = budget.options && budget.options.length > 1 ? budget.options.find((option) => option.decision === "elegida") : undefined
      if (chosen) return chosen.position ? `Eligió la ${inSentence(budgetOptionLabel(chosen.position))}` : "Eligió una opción"
      return "Aceptó todo"
    }
    case "parcial": {
      const lines = decidedLines(budget.items, budget.options)
      const accepted = lines.filter((line) => line.decision === "aceptado").length
      // Sin camino elegido y con algo de los caminos por responder (no si dijo «ninguno»).
      if (choosingPath(budget.options) && lines.some((line) => line.decision === "pendiente" || line.decision === "pospuesto"))
        return `Aceptó ${accepted} · falta elegir el camino`
      // Una revisión pregunta por lo que cambió: eso no es un «no», está por responder.
      const asked = lines.filter((line) => line.decision === "pendiente").length
      if (asked > 0) return `Aceptó ${accepted} · ${asked} por responder`
      return `Aceptó ${accepted} de ${lines.length}`
    }
    case "rechazado":
      return "No aceptó"
    case "sustituido":
      return "Reemplazado"
    case "cancelado":
      return "Anulado"
    default: {
      // Un estado nuevo nunca llega a pantalla como código crudo.
      const text = budget.status.replace(/[_-]+/g, " ").trim()
      return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Sin estado"
    }
  }
}

/** La respuesta a un tratamiento, con las mismas palabras que el estado del presupuesto. */
export function budgetAnswerText(decision: string | null | undefined): string {
  switch (decision) {
    case "aceptado":
      return "Aceptado"
    case "pospuesto":
      return "Lo piensa"
    case "rechazado":
      return "No aceptó"
    case "no_elegida":
      return "No elegida"
    case "reemplazado":
      return "Reemplazado"
    default:
      return "Por responder"
  }
}

/** Los estados de un tratamiento, en palabras (nunca «en_curso»). */
const PLAN_STATE_WORDS: Record<string, string> = {
  pendiente: "Pendiente",
  programado: "Con cita",
  en_curso: "En curso",
  suspendido: "Suspendido",
  realizado: "Realizado",
  cancelado: "Cancelado",
  reemplazado: "Reemplazado",
}

/**
 * Una sola etiqueta por tratamiento (U8 de la QA de la ficha): mientras no
 * empieza, su decisión («Aceptado», «Lo piensa»); después, su estado.
 * La usan la tarjeta de la Historia y el detalle de la atención, para que lo
 * plegado y lo abierto digan lo mismo (tercer repaso del 9 nov, E9).
 */
export function planItemStateText(status: string, decision: string | null | undefined): string {
  if ((status === "pendiente" || status === "programado") && decision && decision !== "aceptado")
    return budgetAnswerText(decision)
  if (status === "pendiente" && decision === "aceptado") return "Aceptado"
  return PLAN_STATE_WORDS[status] ?? status
}

/** Lo que ya no es trabajo vigente: se pliega en «Ya no vigente», no se tacha. */
export function isRetiredPlanStatus(status: string): boolean {
  return status === "cancelado" || status === "reemplazado"
}

/** «Opción A» para la posición 1. */
export function budgetOptionLabel(position: number): string {
  const letter = String.fromCharCode(64 + Math.min(Math.max(Math.trunc(position), 1), 26))
  return `Opción ${letter}`
}

/** Cuántas opciones admite un presupuesto. */
export const BUDGET_OPTIONS_MAX = 3

/**
 * Lo que acepta quien firma el presupuesto en la clínica: la misma frase en la
 * tablet y en su hoja (se copia al firmar). La firma es opcional; sin ella, la
 * respuesta es la palabra de quien la anotó.
 */
export const BUDGET_SIGN_DECLARATION =
  "Me explicaron este presupuesto, sus precios y sus condiciones. Acepto los tratamientos que dicen «Aceptado»."

/** «Opción A» → «opción A», para decirla dentro de una frase. */
function inSentence(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/** Lo mínimo de una línea con su importe para decir lo respondido. */
interface AnswerLine extends WordLine {
  title: string
  lineTotalCents: number | null
  currency: string
}

/**
 * Lo respondido en una línea, igual en la atención, el Plan y lo que leen Sofi y Argos (QA del 16
 * nov, E3): «Eligió la opción A · aceptó S/ 950.00 · lo piensa: Corona cerámica · S/ 900.00». Lo
 * aceptado es lo que se aceptó, no el total de la opción; «Lo piensa» es la única palabra de lo
 * que sigue esperando (cuenta como «espera respuesta»). Sin respuesta todavía, null.
 */
export function budgetAnswerLine(
  budget: { status: string; items: readonly AnswerLine[]; options?: readonly WordOption[] },
  format: (cents: number, currency: string) => string,
): string | null {
  if (!["aceptado", "parcial", "pospuesto", "rechazado"].includes(budget.status)) return null
  const chosen = budget.options && budget.options.length > 1 ? budget.options.find((option) => option.decision === "elegida") : undefined
  const lines = decidedLines(budget.items, budget.options) as AnswerLine[]
  const sum = (rows: readonly AnswerLine[]) => {
    const currencies = [...new Set(rows.map((row) => row.currency))].sort()
    const parts: string[] = []
    for (const currency of currencies) {
      const own = rows.filter((row) => row.currency === currency)
      if (own.some((row) => row.lineTotalCents == null)) return "falta algún precio"
      parts.push(format(own.reduce((total, row) => total + (row.lineTotalCents ?? 0), 0), currency))
    }
    return parts.join(" + ")
  }
  const titles = (rows: readonly AnswerLine[]) => [...new Set(rows.map((row) => row.title))].join(", ")
  const of = (decision: string) => lines.filter((line) => line.decision === decision)
  const accepted = of("aceptado")
  const thinking = of("pospuesto")
  const asked = of("pendiente")
  const refused = of("rechazado")
  const all = lines.length > 0 && accepted.length === lines.length
  const head = chosen
    ? chosen.position
      ? `Eligió la ${inSentence(budgetOptionLabel(chosen.position))}`
      : "Eligió una opción"
    : all
      ? "Aceptó todo"
      : choosingPath(budget.options) && (thinking.length > 0 || asked.length > 0)
        ? "Falta elegir el camino"
        : null
  return [
    head,
    accepted.length > 0 ? (all && !chosen ? sum(accepted) : `aceptó ${sum(accepted)}`) : null,
    thinking.length > 0 ? `lo piensa: ${titles(thinking)} · ${sum(thinking)}` : null,
    asked.length > 0 ? `por responder: ${titles(asked)} · ${sum(asked)}` : null,
    refused.length > 0 ? `no aceptó: ${titles(refused)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ")
    .replace(/^./, (first) => first.toUpperCase())
}
