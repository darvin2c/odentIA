import { Button } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createContext, useContext } from "react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { fetchFormOffers } from "../../lib/consultation-forms"
import type { DictationSuggestion } from "./dictation-session"

/**
 * Lo que propuso Clío para las fichas empezadas de esta atención (entrega 11):
 * la atención lo comparte con el panel de la ficha, donde se acepta cada
 * respuesta en su pregunta (forma B, aprobada el 14 nov). Fuera de una
 * atención con Clío no hay contexto y nada de esto se ve.
 */
export interface ClioFormProposals {
  /** Las propuestas sin decidir: por confirmar y por revisar. */
  items: DictationSuggestion[]
  /** Confirma en el orden de la ficha: la pregunta de la que depende otra, primero. */
  accept: (items: DictationSuggestion[]) => Promise<void>
  discard: (item: DictationSuggestion) => void
  /** «Deshacer» de la ×: la propuesta vuelve a su pregunta. */
  restore: (item: DictationSuggestion) => void
  busy: boolean
  /**
   * El panel de una ficha se abrió o se cerró: dictar no le pone encima «Lo dictado», y
   * Clío lee esa ficha aunque no sea de las dos últimas tocadas. Cada panel avisa con su
   * clave: en la atención hay más de uno montado.
   */
  setFormOpen: (key: string, open: boolean, responseId?: string | null) => void
}

export const ClioFormProposalsContext = createContext<ClioFormProposals | null>(null)

export const useClioFormProposals = (): ClioFormProposals | null => useContext(ClioFormProposalsContext)

/** Las de una ficha. */
export const proposalsOf = (proposals: ClioFormProposals | null, responseId: string): DictationSuggestion[] =>
  (proposals?.items ?? []).filter((item) => item.payload["responseId"] === responseId)

/** El orden de la ficha entre respuestas de ficha: la pregunta de la que depende otra, antes que esa. */
export function byFormOrder(a: DictationSuggestion, b: DictationSuggestion): number {
  const form = String(a.payload["responseId"]).localeCompare(String(b.payload["responseId"]))
  return form !== 0 ? form : Number(a.payload["order"] ?? 0) - Number(b.payload["order"] ?? 0)
}

/**
 * Las respuestas de ficha en el orden de la ficha, y lo demás donde estaba:
 * ordenar todo junto con `byFormOrder` mezclaba clases que no se comparan.
 */
export function inFormOrder(items: readonly DictationSuggestion[]): DictationSuggestion[] {
  const forms = items.filter((item) => item.kind === "ficha").sort(byFormOrder)
  let next = 0
  return items.map((item) => (item.kind === "ficha" ? (forms[next++] ?? item) : item))
}

/** La etiqueta de la lista de Clío de una ficha: la barra del dictado lleva ahí («Ficha de ortodoncia: 3 por confirmar ↓»). */
export const formNoticeLabel = (title: string) => `Sugerencias de ${CLINICAL_NAME}: ${title}`

/**
 * Las fichas que la atención ofrece y nadie empezó: Clío solo propone en una
 * empezada, así que la barra lo dice (QA del 14 nov, D22). Misma consulta que
 * «Fichas para esta atención».
 */
export function useFormsToStart(patientId: string, encounterId: string, enabled: boolean): string[] {
  const offers = useQuery({
    queryKey: ["form-offers", patientId, encounterId],
    queryFn: () => fetchFormOffers(patientId, encounterId),
    enabled,
    retry: 1,
  })
  return (offers.data?.data ?? []).filter((offer) => offer.today === null).map((offer) => offer.title)
}

/** «Empieza «Ficha de ortodoncia» para que Clío proponga sus respuestas mientras dictas.» */
export function formsToStartWords(titles: readonly string[]): string | null {
  if (titles.length === 0) return null
  const names = titles.map((title) => `«${title}»`)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} o ${names.at(-1)}`
  return `Empieza ${list} para que ${CLINICAL_NAME} proponga sus respuestas mientras dictas.`
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
 * Documentos): solo avisa y abre la ficha, donde se confirma cada respuesta.
 * Lleva el nombre de la ficha en su lista: el enlace de la barra del dictado
 * («Ficha de ortodoncia: 3 por confirmar ↓») la encuentra y la abre.
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
      aria-label={formNoticeLabel(title)}
      data-clio-form={responseId}
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
