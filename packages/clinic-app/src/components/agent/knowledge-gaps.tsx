import { Button } from "@odentia/ui"
import { LoadingState, SkeletonRegion } from "@odentia/ui-patterns"
import { useState } from "react"
import { QueryErrorState } from "../../lib/query-error"
import { gapFrequency, type KnowledgeGap, TOUCH } from "./knowledge-model"
import { KnowledgeGapsSkeleton } from "../skeletons/agent"

/** Preguntas a la vista; el resto, con «Ver las N». */
const PREVIEW = 3

/**
 * «No supo responder»: lo que el equipo ya respondió se guarda con un toque
 * (o se edita antes); lo que nadie respondió se responde en el formulario.
 */
export function KnowledgeGaps({
  gaps,
  isPending,
  error,
  onRetry,
  canWrite,
  savingId,
  blocked,
  saveError,
  onSave,
  onEdit,
}: {
  gaps: KnowledgeGap[]
  isPending: boolean
  error: unknown
  onRetry: () => void
  canWrite: boolean
  /** Pregunta que se está guardando tal cual. */
  savingId: string | null
  /** Hay un guardado en curso o sin confirmar: no se inicia otro. */
  blocked: boolean
  saveError: string | null
  onSave: (gap: KnowledgeGap) => void
  onEdit: (gap: KnowledgeGap) => void
}) {
  const [showAll, setShowAll] = useState(false)
  // Primero lo que se resuelve con un toque: lo que el equipo ya respondió.
  const ordered = [...gaps.filter((gap) => gap.teamAnswer), ...gaps.filter((gap) => !gap.teamAnswer)]
  const visible = showAll ? ordered : ordered.slice(0, PREVIEW)
  const answered = visible.filter((gap) => gap.teamAnswer)
  const unanswered = visible.filter((gap) => !gap.teamAnswer)

  return (
    <section aria-labelledby="sin-respuesta" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
      <div className="min-w-0">
        <h2 id="sin-respuesta" className="font-heading text-base font-semibold">
          No supo responder{gaps.length > 0 ? ` · ${gaps.length}` : ""}
        </h2>
        <p className="text-sm text-muted-foreground">Respóndelas una vez y ya las sabe.</p>
      </div>
      {isPending ? (
        <SkeletonRegion message="Cargando preguntas…">
          <KnowledgeGapsSkeleton />
        </SkeletonRegion>
      ) : error ? (
        <QueryErrorState error={error} onRetry={onRetry} />
      ) : gaps.length === 0 ? (
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">Nada pendiente: encontró respuesta para todo lo que buscó.</p>
      ) : (
        <>
          {answered.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {answered.map((gap) => (
                <li key={gap.ids[0]} className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="min-w-0 flex-1 basis-40 font-semibold [overflow-wrap:anywhere]">{gap.question}</p>
                    <span className="text-sm">{gapFrequency(gap)}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-lg bg-card px-3 py-2.5">
                    <span className="text-xs font-semibold text-muted-foreground">Tu equipo respondió</span>
                    <span className="text-sm [overflow-wrap:anywhere]">«{gap.teamAnswer}»</span>
                  </div>
                  {canWrite ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Button type="button" className="min-h-11 sm:min-h-9" disabled={blocked} onClick={() => onSave(gap)}>
                        {savingId === gap.ids[0] ? "Guardando…" : "Guardar como respuesta oficial"}
                      </Button>
                      <Button type="button" variant="outline" className="min-h-11 bg-card sm:min-h-9" disabled={blocked} onClick={() => onEdit(gap)}>
                        Editar antes
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {unanswered.length > 0 ? (
            <ul className="flex flex-col divide-y">
              {unanswered.map((gap) => (
                <li key={gap.ids[0]} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 basis-48 flex-col">
                    <span className="font-semibold [overflow-wrap:anywhere]">{gap.question}</span>
                    <span className="text-sm text-muted-foreground">{gapFrequency(gap)}</span>
                  </div>
                  {canWrite ? (
                    <Button type="button" variant="outline" size="sm" className={TOUCH} disabled={blocked} onClick={() => onEdit(gap)}>
                      Responder
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {gaps.length > PREVIEW ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={`h-auto self-start p-0 ${TOUCH}`}
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Ver menos" : `Ver las ${gaps.length}`}
        </Button>
      ) : null}
    </section>
  )
}
