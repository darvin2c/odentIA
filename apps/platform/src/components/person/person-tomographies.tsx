import { Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import { useImagingUploads } from "../../lib/imaging-upload"
import { activeOrgLocale } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"
import { SummaryCard } from "../patient/resumen-tab"
import { TomographyUploadDrawer } from "../patient/tomography-upload"

interface ImagingUploadRow {
  documentId: string
  label: string
  capturedAt: string | null
  createdAt: string
  fileCount: number
  uploadedCount: number
  totalBytes: number
  completedAt: string | null
}

/**
 * Tomografías en el Resumen de quien las recibe sin leer la historia
 * (recepción, `clinical.receive`, decisión 5): sube la del CD y ve que llegó;
 * abrirla es del equipo clínico.
 */
export function PersonTomographies({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false)
  const jobs = useImagingUploads(patientId)
  const uploads = useQuery({
    queryKey: ["imaging-uploads", patientId],
    queryFn: () => apiFetch<{ data: ImagingUploadRow[] }>(`/api/patients/${patientId}/imaging/uploads`),
  })
  const rows = uploads.data?.data ?? []
  const status = (row: ImagingUploadRow) => {
    const job = jobs.find((j) => j.documentId === row.documentId)
    if (row.completedAt || job?.status === "lista") return "Recibida · la verá el equipo clínico"
    if (job && (job.status === "subiendo" || job.status === "sin_conexion")) {
      const percent = job.totalBytes ? Math.floor((job.sentBytes / job.totalBytes) * 100) : 0
      return job.status === "sin_conexion" ? `Sin conexión · ${percent} %` : `Subiendo · ${percent} %`
    }
    const uploaded = job?.uploadedCount ?? row.uploadedCount
    return `Sin terminar · ${uploaded.toLocaleString(activeOrgLocale())} de ${row.fileCount.toLocaleString(activeOrgLocale())} archivos`
  }
  return (
    <SummaryCard
      title="Tomografías"
      action={
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Subir tomografía
        </Button>
      }
    >
      {uploads.isError ? (
        <QueryErrorState error={uploads.error} onRetry={() => void uploads.refetch()} />
      ) : uploads.isPending ? (
        <p className="text-sm text-muted-foreground">Consultando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          ¿Trajo una tomografía en CD, USB o ZIP? Súbela a su ficha y la verá el equipo clínico.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const incomplete = !row.completedAt
            return (
              <li key={row.documentId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{row.label}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatDate(row.capturedAt ?? row.createdAt)}
                  </span>
                  <span className="block text-xs text-muted-foreground">{status(row)}</span>
                </span>
                {incomplete && !jobs.some((j) => j.documentId === row.documentId && j.status === "subiendo") && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
                    Subir lo que falta
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <TomographyUploadDrawer patientId={patientId} open={open} onClose={() => setOpen(false)} />
    </SummaryCard>
  )
}
