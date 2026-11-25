import { categoryLabel } from "@odentia/clinic-app/components/patient/document-labels"
import { EncounterReadDrawer } from "@odentia/clinic-app/components/patient/encounter-read-drawer"
import { apiFetch } from "@odentia/clinic-app/lib/api"
import { DIAGNOSIS_STATUS_LABELS } from "@odentia/clinic-app/lib/encounters"
import { activeOrgLocale } from "@odentia/clinic-app/lib/locale"
import { conditionLabel, surfaceLabel } from "@odentia/dental"
import { Badge } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useLocation } from "@tanstack/react-router"
import { useState } from "react"

export interface ToothEvent {
  kind: "hallazgo" | "diagnostico" | "procedimiento" | "control" | "documento"
  id: string
  at: string
  title: string
  code: string | null
  surfaces: string[]
  status: string
  /** El estado dicho por el servidor cuando la clave no alcanza («Sesión 1 de 2 · hecha»). */
  statusText?: string | null
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
  reemplazado: "Reemplazado",
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

/** Lo que tiene la pieza, para pedirlo una vez: la línea plegada y la historia lo comparten. */
export function useToothHistory(patientId: string, toothNumber: number) {
  return useQuery({
    queryKey: ["tooth-history", patientId, toothNumber],
    queryFn: () =>
      apiFetch<{ data: ToothEvent[] }>(`/api/patients/${patientId}/odontogram/teeth/${toothNumber}/history`),
  })
}

/** «1 hallazgo», «2 procedimientos»: sin «(s)» ni ceros. */
function counted(count: number, one: string, many: string): string | null {
  return count === 0 ? null : `${count} ${count === 1 ? one : many}`
}

/**
 * La historia de la pieza en una línea, para tenerla plegada debajo de lo que se viene a hacer:
 * «Historia de la 46 · 1 hallazgo · 1 procedimiento». Lo anulado no cuenta.
 */
export function toothHistoryWords(toothNumber: number, events: readonly ToothEvent[] | undefined): string {
  const head = `Historia de la ${toothNumber}`
  if (!events) return head
  const live = events.filter((event) => event.status !== "anulado")
  const of = (kind: ToothEvent["kind"]) => live.filter((event) => event.kind === kind).length
  const parts = [
    counted(of("hallazgo"), "hallazgo", "hallazgos"),
    counted(of("procedimiento"), "procedimiento", "procedimientos"),
    counted(of("documento"), "imagen o documento", "imágenes o documentos"),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `${head} · ${parts.join(" · ")}` : `${head} · sin registros`
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
  const query = useToothHistory(patientId, toothNumber)
  // «Ver atención» se lee al lado, sin cambiar de página: con una atención abierta, la dirección
  // sigue siendo la suya. La que está en curso solo se abre (para seguirla) desde fuera de una atención.
  const inEncounter = useLocation({
    select: (location) => /\/encounters\//.test(location.pathname),
  })
  const [reading, setReading] = useState<ToothEvent | null>(null)
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
                      {event.statusText ?? STATUS_LABELS[event.status] ?? event.status}
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
                        {event.encounterOpen && inEncounter ? (
                          "Atención en curso"
                        ) : event.encounterOpen ? (
                          <Link
                            to="/patients/$patientId/encounters/$encounterId"
                            params={{ patientId, encounterId: event.encounterId }}
                            className="underline underline-offset-2"
                          >
                            Atención en curso
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            onClick={() => setReading(event)}
                          >
                            Ver atención
                          </button>
                        )}
                      </>
                    ) : null}
                  </p>
                </li>
              )
            })}
          </ol>
        </>
      )}
      {reading?.encounterId ? (
        <EncounterReadDrawer
          patientId={patientId}
          encounterId={reading.encounterId}
          title={`${day(reading.at)} · ${title(reading)}`}
          onClose={() => setReading(null)}
        />
      ) : null}
    </section>
  )
}
