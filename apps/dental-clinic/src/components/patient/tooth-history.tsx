import { conditionLabel, surfaceLabel } from "@odentia/clinical"
import { Badge } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { apiFetch } from "../../lib/api"
import { DIAGNOSIS_STATUS_LABELS } from "../../lib/encounters"
import { categoryLabel } from "./document-labels"
import { activeOrgLocale } from "../../lib/locale"

export interface ToothEvent {
  kind: "hallazgo" | "diagnostico" | "procedimiento" | "control" | "documento"
  id: string
  at: string
  title: string
  code: string | null
  surfaces: string[]
  status: string
  detail: string | null
  encounterId: string | null
  encounterOpen: boolean
  authorName: string | null
  voidReason: string | null
}

const KIND_LABELS: Record<ToothEvent["kind"], string> = {
  hallazgo: "Hallazgo",
  diagnostico: "Diagnóstico",
  procedimiento: "Procedimiento",
  control: "Control",
  documento: "Imagen o documento",
}

const STATUS_LABELS: Record<string, string> = {
  vigente: "Vigente",
  tratado: "Tratado",
  anulado: "Anulado",
  en_curso: "En la atención en curso",
  realizado: "Realizado",
  pendiente: "Pendiente",
  programado: "Programado",
  cancelado: "Cancelado",
  ...DIAGNOSIS_STATUS_LABELS,
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

function title(event: ToothEvent) {
  if (event.kind === "hallazgo") return conditionLabel(event.title)
  if (event.kind === "diagnostico") return `${event.code} · ${event.title}`
  return event.title
}

/**
 * Historia de la pieza: todo lo que le pasó, del hecho más reciente al más
 * antiguo, con su profesional y su atención. No es un registro nuevo: se arma
 * con el odontograma, las atenciones, los controles y los documentos.
 */
export function ToothHistory({
  patientId,
  toothNumber,
}: {
  patientId: string
  toothNumber: number
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["tooth-history", patientId, toothNumber],
    queryFn: () =>
      apiFetch<{ data: ToothEvent[] }>(
        `/api/patients/${patientId}/odontogram/teeth/${toothNumber}/history`,
      ),
  })
  const events = query.data?.data ?? []
  const count = (kind: ToothEvent["kind"], status?: string) =>
    events.filter(
      (e) => e.kind === kind && e.status !== "anulado" && (!status || e.status === status),
    ).length
  const findings = count("hallazgo")
  const treated = count("hallazgo", "tratado")
  const procedures = count("procedimiento")
  const images = count("documento")

  return (
    <section aria-label={`Historia de la pieza ${toothNumber}`} className="flex flex-col gap-3">
      <h4 className="text-sm font-medium">Historia de la pieza</h4>
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando historia…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar la historia de la pieza.
        </p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin hechos registrados en esta pieza.</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-md border px-2 py-1.5">
              <dt className="text-xs text-muted-foreground">Hallazgos</dt>
              <dd>
                {findings}
                {treated > 0 ? ` · ${treated} tratado${treated === 1 ? "" : "s"}` : ""}
              </dd>
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <dt className="text-xs text-muted-foreground">Procedimientos</dt>
              <dd>{procedures}</dd>
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <dt className="text-xs text-muted-foreground">Imágenes y documentos</dt>
              <dd>{images}</dd>
            </div>
          </dl>
          <ol className="ml-1 flex flex-col gap-3 border-l pl-4">
            {events.map((event) => {
              const voided = event.status === "anulado"
              return (
                <li key={`${event.kind}-${event.id}`} className="relative text-sm">
                  <span
                    aria-hidden
                    className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-muted-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={event.at}>{day(event.at)}</time> · {KIND_LABELS[event.kind]}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={voided ? "text-muted-foreground line-through" : "font-medium"}>
                      {title(event)}
                      {event.surfaces.length > 0
                        ? ` (${event.surfaces.map(surfaceLabel).join(", ")})`
                        : ""}
                    </span>
                    <Badge variant={event.status === "tratado" ? "success" : "outline"}>
                      {STATUS_LABELS[event.status] ?? event.status}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      event.kind === "documento" && event.code ? categoryLabel(event.code) : null,
                      event.kind !== "documento" ? event.detail : null,
                      event.authorName,
                      voided && event.voidReason ? `Motivo: ${event.voidReason}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {event.encounterId ? (
                      <>
                        {" · "}
                        <Link
                          to="/patients/$patientId/encounters/$encounterId"
                          params={{ patientId, encounterId: event.encounterId }}
                          className="underline underline-offset-2"
                        >
                          {event.encounterOpen ? "Atención en curso" : "Ver atención"}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}
