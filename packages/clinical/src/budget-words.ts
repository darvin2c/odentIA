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
      return "Lo está pensando"
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
      return "Lo está pensando"
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
