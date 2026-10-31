import { Button, cn } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { Check } from "lucide-react"
import { useReceptionName } from "../../lib/agent-names"
import { QueryErrorState } from "../../lib/query-error"
import type { KnowledgeBasics as Basics } from "./knowledge-model"

/**
 * «Lo que solo tú sabes» (ADR 0119): lo que los pacientes preguntan seguido y
 * no está en ningún dato del sistema. Es opcional, así que no se presenta como
 * algo que falta: cada pregunta dice si ya tiene respuesta, con su marca y no
 * solo con el color. Lo que sí está en los datos va en «Lo que toma de tus datos».
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
  const receptionName = useReceptionName()
  const missing = basics?.items.filter((item) => !item.covered) ?? []
  return (
    <section aria-labelledby="solo-tu" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="solo-tu" className="font-heading text-base font-semibold">
            Lo que solo tú sabes
          </h2>
          <p className="text-sm text-muted-foreground">Lo que preguntan seguido y no está en tus datos. Es opcional.</p>
        </div>
        {basics ? (
          <span className="text-sm font-semibold tabular-nums text-primary-soft-foreground sm:hidden">
            {basics.covered} de {basics.total}
          </span>
        ) : null}
      </div>
      {isPending ? (
        <LoadingState message="Cargando…" />
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
              aria-label="Preguntas con respuesta"
              aria-valuemin={0}
              aria-valuemax={basics.total}
              aria-valuenow={basics.covered}
              className="h-2 overflow-hidden rounded-full bg-muted sm:h-2.5"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${(basics.covered / basics.total) * 100}%` }} />
            </div>
          </div>
          <ul aria-label="Preguntas" className="flex flex-wrap gap-1.5">
            {basics.items.map((item) => (
              <li
                key={item.key}
                title={item.question}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm",
                  item.covered ? "bg-success-soft text-success" : "bg-muted",
                )}
              >
                {item.covered ? <Check aria-hidden className="size-3.5" /> : null}
                {item.label}
                <span className="sr-only">{item.covered ? ": con respuesta" : ": sin respuesta"}</span>
              </li>
            ))}
          </ul>
          {missing.length === 0 ? (
            <p className="text-sm text-success">Todas tienen respuesta.</p>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              {canWrite ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 border-primary text-primary-soft-foreground sm:min-h-9 sm:self-start"
                  onClick={onAnswerMissing}
                >
                  {missing.length === 1 ? "Responder la que falta" : `Responder las ${missing.length} que faltan`}
                </Button>
              ) : null}
              <span className="text-sm text-muted-foreground">Sin respuesta, {receptionName} dice que lo confirma y lo pasa al equipo.</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}
