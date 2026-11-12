import { Button } from "@odentia/ui"
import { ErrorState, SkeletonRegion, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../lib/api"

/**
 * «Carga» de una clínica (ADR 0104): el registro de lo que el equipo cargó con la skill de
 * carga y de los informes que se le enviaron, con su PDF tal como salió. Aquí no se carga
 * nada: la carga corre en el servidor (`apps/api/src/cli/carga.ts`). Solo administración,
 * y el servidor lo exige.
 */

const recordSchema = z.object({
  loads: z.array(
    z.object({
      kind: z.enum(["configuracion", "pacientes"]),
      at: z.string(),
      by: z.string().nullable(),
      summary: z.string(),
    }),
  ),
  reports: z.array(
    z.object({
      number: z.number(),
      state: z.enum(["enviando", "enviado", "desconocido"]),
      at: z.string(),
      to: z.string().nullable(),
      stage: z.string().nullable(),
      by: z.string().nullable(),
      registeredLater: z.boolean(),
      hasPdf: z.boolean(),
    }),
  ),
})
type Report = z.infer<typeof recordSchema>["reports"][number]

const LOAD_WORDS = { configuracion: "Configuración", pacientes: "Pacientes" } as const
const zone = { timeZone: "America/Lima" } as const
const dayAndTime = new Intl.DateTimeFormat("es-PE", {
  ...zone,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})
const dayOnly = new Intl.DateTimeFormat("es-PE", {
  ...zone,
  day: "numeric",
  month: "short",
  year: "numeric",
})

/** Lo que pasó con un informe, sin decir más de lo que se sabe: salió no es que lo leyó. */
function reportLine(report: Report): string {
  const when = new Date(report.at)
  const to = report.to ? ` a ${report.to}` : ""
  if (report.registeredLater)
    return `Salió el ${dayOnly.format(when)}${to} · por correo aparte; se registró después`
  const by = report.by ? ` · por ${report.by}` : ""
  if (report.state === "desconocido")
    return `No se sabe si salió · ${dayAndTime.format(when)}${to}${by}`
  if (report.state === "enviando") return `Enviándose desde el ${dayAndTime.format(when)}${to}${by}`
  return `Salió el ${dayAndTime.format(when)}${to}${by}`
}

export function OrgLoadRecord({ organizationId }: { organizationId: string }) {
  const [openError, setOpenError] = useState<string | null>(null)
  const record = useQuery({
    queryKey: ["admin", "org-load-record", organizationId],
    queryFn: async () =>
      recordSchema.parse(await api<unknown>(`/api/admin/imports/${organizationId}/record`)),
  })

  // El enlace vence a los 5 minutos: se pide al tocar, nunca antes.
  async function openPdf(number: number) {
    setOpenError(null)
    try {
      const { url } = z
        .object({ url: z.string() })
        .parse(await api<unknown>(`/api/admin/imports/${organizationId}/reports/${number}/pdf`))
      window.open(url, "_blank", "noopener,noreferrer")
    } catch (failure) {
      setOpenError(submitErrorMessage(failure))
    }
  }

  if (record.isPending) return <OrgLoadRecordSkeleton />
  if (record.isError)
    return (
      <ErrorState
        title="No se pudo traer el registro"
        message={record.error instanceof ApiError ? record.error.shape.message : undefined}
        onRetry={() => void record.refetch()}
      />
    )

  const { loads, reports } = record.data
  if (!loads.length && !reports.length)
    return (
      <section className="flex flex-col gap-1 rounded-xl border bg-card p-4">
        <h2 className="text-base font-medium">Aún no se cargó nada en esta clínica</h2>
        <p className="text-sm text-muted-foreground">
          La carga la hace el equipo con la skill de carga; aquí queda lo que se hizo y los informes
          que se le envían.
        </p>
      </section>
    )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Lo que el equipo cargó en esta clínica con la skill de carga y los informes que se le
        enviaron. Aquí no se carga nada.
      </p>
      <section
        aria-labelledby="informes-enviados"
        className="flex flex-col gap-1 rounded-xl border bg-card p-4"
      >
        <h2 id="informes-enviados" className="text-base font-medium">
          Informes enviados · {reports.length}
        </h2>
        {reports.length ? (
          <ul className="flex flex-col divide-y">
            {reports.map((report) => (
              <li
                key={report.number}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    N.º {report.number}
                    {report.stage ? ` · ${report.stage}` : ""}
                  </span>
                  <span className="text-sm text-muted-foreground break-words">
                    {reportLine(report)}
                  </span>
                </div>
                {report.hasPdf ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                    onClick={() => void openPdf(report.number)}
                  >
                    Ver el PDF
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Sin PDF guardado</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Todavía no se le envió ningún informe.</p>
        )}
        {openError ? (
          <p role="alert" className="text-sm text-destructive">
            {openError}
          </p>
        ) : null}
        {reports.length ? (
          <p className="pt-1 text-xs text-muted-foreground">
            «Salió» es que el correo lo aceptó; si rebota, el aviso llega al buzón de soporte. No se
            sabe si lo abrió.
          </p>
        ) : null}
      </section>
      <section
        aria-labelledby="cargas-hechas"
        className="flex flex-col gap-1 rounded-xl border bg-card p-4"
      >
        <h2 id="cargas-hechas" className="text-base font-medium">
          Cargas · {loads.length}
        </h2>
        {loads.length ? (
          <ul className="flex flex-col divide-y">
            {loads.map((load) => (
              <li key={`${load.kind}-${load.at}`} className="flex flex-col gap-0.5 py-3">
                <span className="text-sm font-medium">{LOAD_WORDS[load.kind]}</span>
                <span className="text-sm text-muted-foreground">
                  {dayAndTime.format(new Date(load.at))}
                  {load.by ? ` · por ${load.by}` : ""}
                </span>
                <span className="text-sm">{load.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Todavía no se cargó nada.</p>
        )}
        <p className="pt-1 text-xs text-muted-foreground">
          El detalle de cada dato está en el informe que se le envió.
        </p>
      </section>
    </div>
  )
}

export function OrgLoadRecordSkeleton() {
  return (
    <SkeletonRegion message="Cargando el registro…" className="flex flex-col gap-4">
      {["Informes enviados", "Cargas"].map((title) => (
        <section key={title} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 className="text-base font-medium">{title}</h2>
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </section>
      ))}
    </SkeletonRegion>
  )
}
