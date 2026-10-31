import { Button } from "@odentia/ui"
import { LoadingState, SkeletonRegion } from "@odentia/ui-patterns"
import { QueryErrorState } from "../../lib/query-error"
import type { KnowledgeBasics as Basics } from "./knowledge-model"
import { KnowledgeBasicsSkeleton } from "../skeletons/agent"

/** Preguntas pendientes a la vista como etiquetas; el resto se resume en «y N más». */
const CHIPS = 4

/**
 * «Lo básico de una clínica»: cuántas de las preguntas que casi todos hacen ya
 * tienen respuesta y cuáles faltan. En teléfono es una tarjeta que se toca
 * entera para responderlas.
 */
export function KnowledgeBasics({
  basics,
  isPending,
  error,
  onRetry,
  canWrite,
  onAnswerMissing,
}: {
  basics: Basics | null
  isPending: boolean
  error: unknown
  onRetry: () => void
  canWrite: boolean
  onAnswerMissing: () => void
}) {
  const missing = basics?.items.filter((item) => !item.covered) ?? []
  const missingHint = missing.length === 1 ? "Falta 1. Toca para responderla." : `Faltan ${missing.length}. Toca para responderlas.`
  return (
    <section
      aria-labelledby="lo-basico"
      className="elevated relative flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6 max-sm:gap-2"
    >
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="lo-basico" className="font-heading text-base font-semibold">
            Lo básico de una clínica
          </h2>
          <p className="hidden text-sm text-muted-foreground sm:block">Las preguntas que casi todos los pacientes hacen.</p>
        </div>
        {basics ? (
          <span className="text-sm font-semibold tabular-nums text-primary-soft-foreground sm:hidden">
            {basics.covered} de {basics.total}
          </span>
        ) : null}
      </div>
      {isPending ? (
        <SkeletonRegion message="Cargando…">
          <KnowledgeBasicsSkeleton />
        </SkeletonRegion>
      ) : error || !basics ? (
        <QueryErrorState error={error} onRetry={onRetry} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <p className="hidden items-baseline gap-2 sm:flex">
              <strong className="font-heading text-2xl font-semibold tabular-nums tracking-tight">
                {basics.covered} de {basics.total}
              </strong>
              <span className="text-muted-foreground">ya tienen respuesta</span>
            </p>
            <div
              role="progressbar"
              aria-label="Preguntas básicas respondidas"
              aria-valuemin={0}
              aria-valuemax={basics.total}
              aria-valuenow={basics.covered}
              className="h-2 overflow-hidden rounded-full bg-muted sm:h-2.5"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${(basics.covered / basics.total) * 100}%` }} />
            </div>
          </div>
          {missing.length === 0 ? (
            <p className="text-sm text-success">Todo lo básico está respondido.</p>
          ) : (
            <>
              <div className="hidden flex-col gap-3 sm:flex">
                <h3 className="text-sm font-semibold">Las que faltan</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {missing.slice(0, CHIPS).map((item) => (
                    <li key={item.key} className="rounded-full bg-muted px-3 py-1 text-sm">
                      {item.question}
                    </li>
                  ))}
                  {missing.length > CHIPS ? (
                    <li className="px-1 py-1 text-sm text-muted-foreground">y {missing.length - CHIPS} más</li>
                  ) : null}
                </ul>
                {canWrite ? (
                  <Button type="button" variant="outline" className="self-start border-primary text-primary-soft-foreground" onClick={onAnswerMissing}>
                    Responder las que faltan
                  </Button>
                ) : null}
              </div>
              {canWrite ? (
                // El botón ocupa toda la tarjeta y escribe su texto abajo; la línea
                // invisible le reserva el sitio. (Un `::after` estirado no sirve: al
                // pulsar, el botón se desplaza y pasa a contener su propio `::after`.)
                <>
                  <span aria-hidden className="invisible text-sm sm:hidden">
                    {missingHint}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="absolute inset-0 h-auto items-end justify-start whitespace-normal rounded-xl p-[15px] text-left text-sm font-normal text-muted-foreground hover:bg-transparent sm:hidden"
                    onClick={onAnswerMissing}
                  >
                    {missingHint}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground sm:hidden">{missing.length === 1 ? "Falta 1." : `Faltan ${missing.length}.`}</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
