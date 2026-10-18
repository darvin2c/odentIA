import { Button, buttonVariants } from "@odentia/ui"
import { Download } from "lucide-react"
import { useState } from "react"
import { TomographyViewer } from "./tomography-viewer"
import type { SelectedFile } from "../../lib/imaging-scan"
import { cancelStudyUpload, tomographyDownloadUrl, useImagingUploads } from "../../lib/imaging-upload"
import { activeOrgLocale } from "../../lib/locale"
import type { ImagingSummary, PatientDocument } from "../../lib/patients"
import {
  formatBytes,
  TomographyDropZone,
  TomographyProgress,
  useTomographyFlow,
} from "./tomography-upload"

export function imagingFacts(imaging: ImagingSummary): string {
  const parts = [`${imaging.sliceCount.toLocaleString(activeOrgLocale())} cortes`]
  if (imaging.voxelMm)
    parts.push(`${imaging.voxelMm.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })} mm`)
  parts.push(formatBytes(imaging.totalBytes))
  return parts.join(" · ")
}

/** «Subiendo · 64 %», «Sin terminar · 346 de 540» o null si ya está completa. */
export function useImagingState(patientId: string, doc: PatientDocument) {
  const jobs = useImagingUploads(patientId)
  const imaging = doc.imaging
  const job = jobs.find((j) => j.documentId === doc.id)
  if (!imaging || imaging.completedAt || job?.status === "lista") return null
  if (job && (job.status === "subiendo" || job.status === "sin_conexion")) {
    const percent = job.totalBytes ? Math.floor((job.sentBytes / job.totalBytes) * 100) : 0
    return {
      active: true,
      job,
      percent,
      text: job.status === "sin_conexion" ? `Sin conexión · ${percent} %` : `Subiendo · ${percent} %`,
    }
  }
  const uploaded = job?.uploadedCount ?? imaging.uploadedCount
  return {
    active: false,
    job,
    percent: Math.floor((uploaded / imaging.fileCount) * 100),
    text: `Sin terminar · ${uploaded.toLocaleString(activeOrgLocale())} de ${imaging.fileCount.toLocaleString(activeOrgLocale())}`,
  }
}

/**
 * Detalle de una tomografía en Imágenes. Mientras sube, su avance; si quedó a
 * medias, «Subir lo que falta» con la misma carpeta; completa, sus datos y la
 * descarga para el programa del equipo. El visor llega con la fase 3.
 */
export function TomographyDetail({
  patientId,
  doc,
  canUpload,
  onChanged,
  viewer,
}: {
  patientId: string
  doc: PatientDocument
  canUpload: boolean
  onChanged: () => Promise<void> | void
  /** El visor de la tomografía completa. */
  viewer?: React.ReactNode
}) {
  const imaging = doc.imaging!
  const state = useImagingState(patientId, doc)
  const flow = useTomographyFlow({ patientId, where: "La tarjeta en Imágenes", onChange: () => void onChanged() })
  const [wrongStudy, setWrongStudy] = useState(false)
  const [viewing, setViewing] = useState(false)

  if (!state) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {viewer}
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">{imagingFacts(imaging)}</span>
          <Button type="button" size="sm" onClick={() => setViewing(true)}>
            Abrir visor
          </Button>
          <a
            href={tomographyDownloadUrl(patientId, doc.id)}
            download
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            <Download aria-hidden="true" />
            Descargar para el programa del equipo
          </a>
        </div>
        <p className="text-xs text-muted-foreground">
          La descarga es un ZIP con la tomografía tal como llegó, para abrirla en el programa del equipo o
          en Weasis.
        </p>
        {viewing && (
          <TomographyViewer patientId={patientId} doc={doc} open canWrite={canUpload} onClose={() => setViewing(false)} />
        )}
      </div>
    )
  }

  const resume = async (selection: SelectedFile[]) => {
    setWrongStudy(false)
    const found = await flow.scan(selection)
    const same = found.studies.find((study) => study.studyInstanceUid === imaging.studyInstanceUid)
    if (!same) {
      setWrongStudy(true)
      flow.reset()
      return
    }
    await flow.start(same)
  }

  const job = flow.job ?? state.job
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-4">
      {job ? (
        <TomographyProgress job={job} where="La tarjeta en Imágenes" />
      ) : (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">
            Faltan {(imaging.fileCount - imaging.uploadedCount).toLocaleString(activeOrgLocale())} de{" "}
            {imaging.fileCount.toLocaleString(activeOrgLocale())} archivos
          </p>
          <p className="text-muted-foreground">
            La subida quedó a medias. Vuelve a elegir la carpeta del CD: lo que ya se subió no se repite.
          </p>
        </div>
      )}
      {canUpload && !state.active && (
        <>
          {flow.scanning ? (
            <p className="text-sm text-muted-foreground">Revisando lo que elegiste…</p>
          ) : (
            <TomographyDropZone onSelect={(selection) => void resume(selection)} hint="Elige la misma carpeta o ZIP." />
          )}
          {wrongStudy && (
            <p role="alert" className="text-sm text-destructive">
              Lo que elegiste no trae esta tomografía. Elige la carpeta o el ZIP de la misma.
            </p>
          )}
          {flow.error && (
            <p role="alert" className="text-sm text-destructive">
              {flow.error}
            </p>
          )}
        </>
      )}
      {canUpload && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void cancelStudyUpload(patientId, doc.id).then(() => onChanged())}
          >
            Cancelar subida
          </Button>
        </div>
      )}
    </div>
  )
}
