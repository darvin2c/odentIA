import { useSyncExternalStore } from "react"
import { ApiError } from "./api"
import { type ConsentDocument, fetchConsents, setConsentPersonalRisks } from "./clinical-forms"

/**
 * Lo escrito en «Riesgos propios» y aún sin guardar, por consentimiento (QA de diseño del 18 nov,
 * H1): con un riesgo escrito y sin «Guardar», «Firmar ahora» hacía firmar la hoja vieja sin avisar.
 * Lo escrito vive aquí mientras la pestaña siga abierta, aunque se cierre el panel del papel: cada
 * botón que firma ese consentimiento (el papel, la fila de Documentos, la del Plan, el cierre) dice
 * «Guardar y firmar», y la firma lo guarda antes de abrir la hoja (`ConsentSigningScreen`).
 */
export interface RisksDraft {
  documentId: string
  patientId: string
  planItemId: string | null
  /** Lo escrito, tal cual: una frase por línea. */
  text: string
  /** Los guardados que tenía a la vista al empezar a escribir: si otro los cambió, 409 y no se pisan. */
  seen: string[]
  /** Tras ese 409, lo que dicen ahora: se ven, y lo escrito se conserva para guardarlo encima a sabiendas. */
  latest: string[] | null
}

let drafts: ReadonlyMap<string, RisksDraft> = new Map()
const listeners = new Set<() => void>()
const saving = new Map<string, Promise<ConsentDocument>>()

function publish(next: Map<string, RisksDraft>): void {
  drafts = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: ReadonlyMap<string, RisksDraft> = new Map()

/** Lo escrito sin guardar de cada consentimiento; cambia de referencia con cada cambio. */
export function useRisksDrafts(): ReadonlyMap<string, RisksDraft> {
  return useSyncExternalStore(
    subscribe,
    () => drafts,
    () => EMPTY,
  )
}

/** ¿Alguno de estos consentimientos (o de estos tratamientos) tiene riesgos propios sin guardar? */
export function hasRisksDraft(
  all: ReadonlyMap<string, RisksDraft>,
  match: {
    documentIds?: ReadonlyArray<string | null | undefined>
    planItemIds?: ReadonlyArray<string | null | undefined>
  },
): boolean {
  if (all.size === 0) return false
  const documents = new Set((match.documentIds ?? []).filter(Boolean))
  const items = new Set((match.planItemIds ?? []).filter(Boolean))
  for (const draft of all.values())
    if (documents.has(draft.documentId) || (draft.planItemId && items.has(draft.planItemId)))
      return true
  return false
}

export function risksDraftOf(documentId: string): RisksDraft | null {
  return drafts.get(documentId) ?? null
}

/** Guarda lo escrito (o lo quita si volvió a ser lo guardado: `null`). */
export function setRisksDraft(documentId: string, draft: RisksDraft | null): void {
  const current = drafts.get(documentId)
  if (!draft && !current) return
  if (
    draft &&
    current &&
    current.text === draft.text &&
    current.latest === draft.latest &&
    current.seen === draft.seen
  )
    return
  const next = new Map(drafts)
  if (draft) next.set(documentId, draft)
  else next.delete(documentId)
  publish(next)
}

/**
 * Guarda lo escrito de un consentimiento y devuelve el documento como quedó. Si otra pestaña o
 * persona los cambió (409 `CONSENT_RISKS_CHANGED`, que dice quién), lo escrito se conserva y queda a
 * la vista lo que dicen ahora; el error sigue hacia quien guardó. Dos pedidos a la vez (un doble
 * clic, el panel y la firma) comparten el mismo guardado.
 */
export function saveRisksDraft(documentId: string): Promise<ConsentDocument> | null {
  const draft = drafts.get(documentId)
  if (!draft) return null
  const running = saving.get(documentId)
  if (running) return running
  const run = (async () => {
    try {
      const result = await setConsentPersonalRisks(
        documentId,
        draft.text.trim() || null,
        draft.seen,
      )
      // Lo que se escribió mientras guardaba sigue sin guardar.
      if (drafts.get(documentId)?.text === draft.text) setRisksDraft(documentId, null)
      return result.data
    } catch (error) {
      if (error instanceof ApiError && error.shape.code === "CONSENT_RISKS_CHANGED") {
        const fresh = await fetchConsents({ patientId: draft.patientId })
          .then((response) => response.data.find((row) => row.id === documentId) ?? null)
          .catch(() => null)
        const now = drafts.get(documentId) ?? draft
        if (fresh) {
          const latest = fresh.sectionsSnapshot?.personalRisks ?? []
          setRisksDraft(documentId, { ...now, seen: latest, latest })
        }
      }
      throw error
    } finally {
      saving.delete(documentId)
    }
  })()
  saving.set(documentId, run)
  return run
}

/** Antes de firmar: guarda lo escrito de cada hoja y devuelve las hojas como quedaron. */
export async function saveRisksDraftsOf(
  documents: readonly ConsentDocument[],
): Promise<ConsentDocument[]> {
  const out: ConsentDocument[] = []
  for (const document of documents) out.push((await saveRisksDraft(document.id)) ?? document)
  return out
}

/** Solo para pruebas: empieza sin nada escrito. */
export function resetRisksDraftsForTest(): void {
  saving.clear()
  publish(new Map())
}
