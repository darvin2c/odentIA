import { Button } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { createContext, useContext } from "react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import type { DictationSuggestion } from "./dictation-session"

/**
 * Lo que propuso Clío para las fichas empezadas de esta atención (entrega 11):
 * la atención lo comparte con el panel de la ficha, donde se acepta cada
 * respuesta en su pregunta (forma B, aprobada el 14 nov). Fuera de una
 * atención con Clío no hay contexto y nada de esto se ve.
 */
export interface ClioFormProposals {
  /** Las propuestas sin decidir, listas y por revisar. */
  items: DictationSuggestion[]
  /** Acepta en el orden de la ficha: la pregunta de la que depende otra, primero. */
  accept: (items: DictationSuggestion[]) => Promise<void>
  discard: (item: DictationSuggestion) => void
  busy: boolean
  /** El panel de una ficha se abrió o se cerró: dictar no le pone encima «Lo dictado». */
  setFormOpen: (open: boolean) => void
}

export const ClioFormProposalsContext = createContext<ClioFormProposals | null>(null)

export const useClioFormProposals = (): ClioFormProposals | null => useContext(ClioFormProposalsContext)

/** Las de una ficha. */
export const proposalsOf = (proposals: ClioFormProposals | null, responseId: string): DictationSuggestion[] =>
  (proposals?.items ?? []).filter((item) => item.payload["responseId"] === responseId)

/** El orden de la ficha: así se acepta la pregunta de la que depende otra antes que esa. */
export function byFormOrder(a: DictationSuggestion, b: DictationSuggestion): number {
  if (a.kind !== "ficha" || b.kind !== "ficha") return 0
  const form = String(a.payload["responseId"]).localeCompare(String(b.payload["responseId"]))
  return form !== 0 ? form : Number(a.payload["order"] ?? 0) - Number(b.payload["order"] ?? 0)
}

/** El valor propuesto, dicho corto: «Sí», «Clase I», «6 mm». */
export function proposedWords(item: DictationSuggestion): string {
  const value = item.payload["value"]
  const unit = typeof item.payload["unit"] === "string" && item.payload["unit"] ? ` ${item.payload["unit"]}` : ""
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return `${String(value).replace(".", ",")}${unit}`
  if (Array.isArray(value)) return value.join(", ")
  return typeof value === "string" ? value : ""
}

/**
 * El aviso en la fila de la ficha (en «Fichas para esta atención» o en
 * Documentos): solo avisa y abre la ficha, donde se acepta cada respuesta.
 * Lleva el nombre de la lista de sugerencias de la barra del dictado
 * («Fichas ↓» lleva aquí).
 */
export function ClioFormNotice({
  responseId,
  title,
  onOpen,
}: {
  responseId: string
  title: string
  onOpen: () => void
}): React.JSX.Element | null {
  const proposals = proposalsOf(useClioFormProposals(), responseId)
  if (proposals.length === 0) return null
  const ready = proposals.filter((item) => item.status === "lista").length
  const words =
    ready > 0
      ? `${CLINICAL_NAME} propone ${ready === 1 ? "1 respuesta" : `${ready} respuestas`}`
      : `${CLINICAL_NAME} no pudo llenar ${proposals.length === 1 ? "1 pregunta" : `${proposals.length} preguntas`}: elige tú`
  return (
    <div
      role="group"
      aria-label={`Sugerencias de ${CLINICAL_NAME}: Fichas`}
      className="flex basis-full flex-wrap items-center justify-between gap-2 rounded-xl border border-agent-border bg-agent-soft p-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <AgentMark size="sm" />
        <span>{words}</span>
      </span>
      <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" aria-label={`Revisar lo de ${CLINICAL_NAME} en ${title}`} onClick={onOpen}>
        Revisar lo de {CLINICAL_NAME}
      </Button>
    </div>
  )
}
