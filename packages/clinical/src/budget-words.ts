/**
 * Un solo nombre para cada estado del presupuesto (tablero 3 de la fase 3),
 * igual en la página de la persona, la atención, Inicio, el portal y lo que
 * dice el agente. Antes había cuatro juegos de palabras para lo mismo («Acepta
 * / Lo piensa», «Pospuesto», «Lo está pensando», «Lo pienso»).
 *
 * Los estados del código no cambian (`borrador`, `presentado`…); aquí solo se
 * dicen. «Aceptó N de M» cuenta las líneas de la opción elegida.
 */

/** Lo mínimo de una línea para decir el estado. */
interface WordLine {
  decision: string | null | undefined
  optionId?: string | null
}

/** Lo mínimo de una opción para decir el estado. */
interface WordOption {
  id: string
  decision: string
}

/** Líneas que cuentan para «Aceptó N de M»: las de la opción elegida, o todas si no hay. */
function decidedLines(lines: readonly WordLine[], options: readonly WordOption[] | undefined): WordLine[] {
  const chosen = options?.find((option) => option.decision === "elegida")
  if (chosen) return lines.filter((line) => line.optionId === chosen.id)
  return lines.filter((line) => line.decision !== "no_elegida")
}

/** «Por enviar», «Enviado · espera respuesta», «Aceptó 2 de 3»… */
export function budgetStateText(budget: {
  status: string
  items: readonly WordLine[]
  options?: readonly WordOption[]
}): string {
  switch (budget.status) {
    case "borrador":
      return "Por enviar"
    case "presentado":
      return "Enviado · espera respuesta"
    case "pospuesto":
      return "Lo está pensando"
    case "aceptado":
      return "Aceptó todo"
    case "parcial": {
      const lines = decidedLines(budget.items, budget.options)
      const accepted = lines.filter((line) => line.decision === "aceptado").length
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
