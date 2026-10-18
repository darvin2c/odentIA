import { Button } from "@odentia/ui"
import { FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import {
  dicomNameMatches,
  droppedFiles,
  type ScanResult,
  type SelectedFile,
  type StudyCandidate,
  scanSelection,
} from "../../lib/imaging-scan"
import {
  cancelStudyUpload,
  startStudyUpload,
  type UploadJob,
  useImagingUploads,
} from "../../lib/imaging-upload"
import { activeOrgLocale } from "../../lib/locale"
import type { Patient } from "../../lib/patients"
import { ToothSelector } from "./tooth-selector"

/** Tope por tomografía (decisión 4 del lienzo; lo valida también la API). */
export const TOMOGRAPHY_MAX_BYTES = 1024 ** 3

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1
  return `${value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: digits })} ${units[unit]}`
}

function formatMm(value: number): string {
  return value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })
}

/** AAAAMMDD de DICOM al formato de la clínica. */
function dicomDate(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null
  return formatDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`)
}

/** Mediodía del día del estudio, para guardarlo como fecha de toma sin correrse de día. */
function capturedAtOf(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00Z`
  return new Date(iso).getTime() > Date.now() ? null : iso
}

export function usePatientIdentity(patientId: string) {
  const query = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: Patient }>(`/api/patients/${patientId}`),
  })
  const patient = query.data?.data
  return patient
    ? {
        displayName: patient.displayName,
        givenNames: patient.givenNames ?? null,
        familyNames: [patient.paternalSurname, patient.maternalSurname].filter(Boolean).join(" ") || null,
      }
    : null
}

/** Revisa la selección y entrega lo encontrado; recuerda el avance para mostrarlo. */
export function useStudyScan() {
  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  const scan = async (selection: readonly SelectedFile[]) => {
    setResult(null)
    setScanning({ done: 0, total: selection.length })
    try {
      const found = await scanSelection(selection, (done, total) => setScanning({ done, total }))
      setResult(found)
      return found
    } finally {
      setScanning(null)
    }
  }
  return { scanning, result, scan, reset: () => setResult(null) }
}

export function ScanningState({ scanning }: { scanning: { done: number; total: number } }) {
  return (
    <LoadingState
      message={`Revisando lo que elegiste… ${scanning.done.toLocaleString(activeOrgLocale())} de ${scanning.total.toLocaleString(activeOrgLocale())} archivos`}
    />
  )
}

export interface ReviewChoice {
  teeth: number[]
  /** El nombre del archivo no coincide y quien sube confirmó que es de esta persona. */
  nameConfirmed: boolean
}

/** Paso 2 del lienzo: lo encontrado, antes de subir. */
export function TomographyReview({
  candidate,
  result,
  personName,
  nameCheck,
  teeth,
  onTeethChange,
}: {
  candidate: StudyCandidate
  result: ScanResult
  personName: string
  /** null: el archivo no trae nombre; false: no coincide. */
  nameCheck: boolean | null
  teeth: number[]
  onTeethChange: (teeth: number[]) => void
}) {
  const others = result.studies.filter((study) => study !== candidate)
  const tooBig = candidate.totalBytes > TOMOGRAPHY_MAX_BYTES
  return (
    <section aria-labelledby="tomography-found" className="flex flex-col gap-4">
      <h3 id="tomography-found" className="text-base font-semibold">
        Encontramos una tomografía
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Tipo</dt>
        <dd className="font-medium">Tomografía (CBCT)</dd>
        <dt className="text-muted-foreground">Fecha</dt>
        <dd className="font-medium">{dicomDate(candidate.studyDate) ?? "El archivo no la dice"}</dd>
        <dt className="text-muted-foreground">Origen</dt>
        <dd className="font-medium">{candidate.institution ?? "El archivo no lo dice"}</dd>
        <dt className="text-muted-foreground">Cortes</dt>
        <dd className="font-medium">
          {candidate.sliceCount.toLocaleString(activeOrgLocale())}
          {candidate.voxelMm ? ` · cada ${formatMm(candidate.voxelMm)} mm` : ""}
        </dd>
        <dt className="text-muted-foreground">Tamaño</dt>
        <dd className="font-medium">{formatBytes(candidate.totalBytes)}</dd>
      </dl>
      <ToothSelector value={teeth} onChange={onTeethChange} label="Piezas (opcional)" />
      {tooBig && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          Pesa {formatBytes(candidate.totalBytes)} y el máximo por tomografía es 1 GB. Pide al centro
          de imágenes la tomografía sin su visor.
        </p>
      )}
      {nameCheck === false && candidate.patientName && (
        <div role="alert" className="flex flex-col gap-1 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <p className="font-semibold">El archivo dice «{candidate.patientName}»</p>
          <p>
            Y la ficha es de {personName}. Comprueba que sea de esta persona: odentIA no cambia la ficha
            por lo que diga el archivo.
          </p>
        </div>
      )}
      {nameCheck === null && (
        <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
          El archivo no dice de quién es: comprueba que sea de {personName}.
        </p>
      )}
      {(result.ignored > 0 || others.length > 0) && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {result.ignored > 0 && (
            <li>
              No se suben {result.ignored.toLocaleString(activeOrgLocale())}{" "}
              {result.ignored === 1 ? "archivo que no es" : "archivos que no son"} imágenes DICOM (el
              visor del CD, sus programas e imágenes de muestra).
            </li>
          )}
          {others.length > 0 && (
            <li>
              Lo elegido trae además {others.length === 1 ? "otro estudio" : `${others.length} estudios`}{" "}
              más pequeño{others.length === 1 ? "" : "s"}: se sube solo la tomografía.
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function remaining(job: UploadJob, startedAt: number, startBytes: number): string | null {
  const elapsed = (Date.now() - startedAt) / 1000
  const sent = job.sentBytes - startBytes
  if (elapsed < 3 || sent <= 0) return null
  const seconds = ((job.totalBytes - job.sentBytes) / sent) * elapsed
  if (seconds < 60) return "falta menos de un minuto"
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? "falta 1 min" : `faltan ${minutes} min`
}

/** Paso 3 del lienzo: el avance. Sigue aunque se cierre la ventana. */
export function TomographyProgress({
  job,
  where,
  onRetry,
}: {
  job: UploadJob
  /** Dónde se verá el avance al cerrar («la tarjeta en Imágenes», «el Resumen»). */
  where: string
  onRetry?: () => void
}) {
  const start = useRef({ at: Date.now(), bytes: job.sentBytes })
  const percent = job.totalBytes ? Math.floor((job.sentBytes / job.totalBytes) * 100) : 0
  const eta = job.status === "subiendo" ? remaining(job, start.current.at, start.current.bytes) : null
  return (
    <section aria-labelledby="tomography-progress" className="flex flex-col gap-3">
      <h3 id="tomography-progress" className="text-base font-semibold">
        {job.status === "lista" ? "La tomografía quedó en la ficha" : "Subiendo la tomografía"}
      </h3>
      <div
        role="progressbar"
        aria-label="Avance de la subida"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.status === "lista" ? 100 : percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
          style={{ width: `${job.status === "lista" ? 100 : percent}%` }}
        />
      </div>
      <p className="flex flex-wrap justify-between gap-2 text-sm" aria-live="polite">
        <span>
          {job.uploadedCount.toLocaleString(activeOrgLocale())} de{" "}
          {job.fileCount.toLocaleString(activeOrgLocale())} archivos
        </span>
        <span className="text-muted-foreground">
          {formatBytes(job.sentBytes)} de {formatBytes(job.totalBytes)}
          {eta ? ` · ${eta}` : ""}
        </span>
      </p>
      {job.status === "subiendo" && (
        <p className="text-sm text-muted-foreground">
          Puedes cerrar esta ventana y seguir trabajando. {where} muestra el avance y avisa cuando esté
          lista.
        </p>
      )}
      {job.status === "sin_conexion" && (
        <p role="status" className="rounded-xl bg-warning-soft p-3 text-sm text-warning">
          Sin conexión. La subida sigue sola cuando vuelva internet; lo que ya se subió no se repite.
        </p>
      )}
      {job.status === "error" && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          <p>{job.error}</p>
          {job.missing > 0 && (
            <p>Vuelve a elegir la carpeta completa del CD: solo se sube lo que falta.</p>
          )}
          {onRetry && job.missing === 0 && (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                Reintentar
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function tomographyLabel(candidate: StudyCandidate): string {
  return candidate.institution ? `Tomografía (CBCT) · ${candidate.institution}`.slice(0, 200) : "Tomografía (CBCT)"
}

/**
 * Todo el recorrido de la tomografía para una ficha: elegir, revisar y subir.
 * Lo usa el diálogo de subida de Imágenes (con lo ya elegido) y recepción, que
 * la recibe sin abrir la historia clínica.
 */
export function useTomographyFlow({
  patientId,
  where,
  onChange,
}: {
  patientId: string
  where: string
  onChange?: () => void
}) {
  const queryClient = useQueryClient()
  const person = usePatientIdentity(patientId)
  const { scanning, result, scan, reset: resetScan } = useStudyScan()
  const [teeth, setTeeth] = useState<number[]>([])
  const [documentId, setDocumentId] = useState<string | null>(null)
  const [existing, setExisting] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jobs = useImagingUploads(patientId)
  const job = documentId ? jobs.find((j) => j.documentId === documentId) : undefined
  const candidate = result?.studies.find((study) => study.isVolume) ?? null
  const nameCheck = candidate && person ? dicomNameMatches(candidate.patientName, person) : null
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-documents", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["imaging-uploads", patientId] })
    onChange?.()
  }

  /** `chosen`: el estudio ya elegido (al retomar no se espera al estado de la revisión). */
  const start = async (chosen: StudyCandidate | null = candidate) => {
    if (!chosen || starting) return
    setStarting(true)
    setError(null)
    try {
      const started = await startStudyUpload({
        patientId,
        candidate: chosen,
        label: tomographyLabel(chosen),
        capturedAt: capturedAtOf(chosen.studyDate),
        source: chosen.institution?.slice(0, 120) ?? null,
        toothNumbers: teeth,
        onChange: refresh,
      })
      if (started.state === "exists") setExisting(started.documentId)
      else setDocumentId(started.documentId)
      refresh()
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.shape.message ?? "La ficha no aceptó la tomografía.")
          : "No se pudo empezar la subida. Revisa la conexión y vuelve a intentarlo.",
      )
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!documentId) return
    try {
      await cancelStudyUpload(patientId, documentId)
      setDocumentId(null)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo cancelar.") : "No se pudo cancelar.")
    }
  }

  const reset = () => {
    resetScan()
    setTeeth([])
    setDocumentId(null)
    setExisting(null)
    setError(null)
  }

  const personName = person?.displayName ?? "esta persona"
  return {
    scan,
    scanning,
    result,
    candidate,
    nameCheck,
    personName,
    teeth,
    setTeeth,
    job,
    existing,
    starting,
    error,
    start,
    cancel,
    reset,
    where,
    tooBig: (candidate?.totalBytes ?? 0) > TOMOGRAPHY_MAX_BYTES,
  }
}

export type TomographyFlow = ReturnType<typeof useTomographyFlow>

/** Lo que va dentro del cajón según el paso. */
export function TomographyFlowBody({
  flow,
  onOpenExisting,
}: {
  flow: TomographyFlow
  onOpenExisting?: (documentId: string) => void
}) {
  if (flow.scanning) return <ScanningState scanning={flow.scanning} />
  if (flow.job)
    return <TomographyProgress job={flow.job} where={flow.where} onRetry={() => void flow.start()} />
  if (flow.existing)
    return (
      <div role="status" className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
        <p className="font-semibold">Esta tomografía ya está en la ficha</p>
        <p className="text-muted-foreground">No se guarda dos veces.</p>
        {onOpenExisting && (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenExisting(flow.existing!)}>
              Abrir la que ya está
            </Button>
          </div>
        )}
      </div>
    )
  if (flow.candidate && flow.result)
    return (
      <div className="flex flex-col gap-3">
        <TomographyReview
          candidate={flow.candidate}
          result={flow.result}
          personName={flow.personName}
          nameCheck={flow.nameCheck}
          teeth={flow.teeth}
          onTeethChange={flow.setTeeth}
        />
        {flow.error && (
          <p role="alert" className="text-sm text-destructive">
            {flow.error}
          </p>
        )}
      </div>
    )
  return null
}

/** Etiqueta del botón principal del cajón según el paso. */
export function tomographySubmitLabel(flow: TomographyFlow): string {
  if (flow.job) return "Seguir trabajando"
  if (flow.existing) return "Cerrar"
  if (flow.starting) return "Empezando…"
  if (flow.nameCheck === false) return `Sí, es de ${flow.personName}: subir`
  return "Subir tomografía"
}

/** Zona para soltar la carpeta del CD, un ZIP o los archivos. */
export function TomographyDropZone({
  onSelect,
  disabled,
  hint = "Fotos, PDF, radiografías y tomografías. Hasta 1 GB por tomografía.",
}: {
  onSelect: (selection: SelectedFile[]) => void
  disabled?: boolean
  hint?: string
}) {
  const filesRef = useRef<HTMLInputElement | null>(null)
  const folderRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const toSelection = (files: FileList | null) =>
    [...(files ?? [])].map((file) => ({ file, name: file.webkitRelativePath || file.name }))
  return (
    <section
      aria-label="Soltar archivos"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (disabled) return
        void droppedFiles(event.dataTransfer).then(onSelect)
      }}
      className={`flex flex-col items-center gap-2 rounded-xl border border-dashed p-5 text-center transition-colors ${dragging ? "border-primary bg-primary/5" : "bg-muted/40"}`}
    >
      <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">Arrastra aquí la carpeta del CD, el ZIP o los archivos</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <input
          ref={folderRef}
          type="file"
          aria-label="Carpeta"
          tabIndex={-1}
          className="sr-only"
          // Elegir una carpeta entera (el CD): todos los navegadores actuales lo admiten.
          {...({ webkitdirectory: "" } as Record<string, string>)}
          disabled={disabled}
          onChange={(event) => {
            onSelect(toSelection(event.currentTarget.files))
            event.currentTarget.value = ""
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => folderRef.current?.click()}>
          <FolderOpen aria-hidden="true" />
          Elegir carpeta
        </Button>
        <input
          ref={filesRef}
          type="file"
          aria-label="Archivos"
          tabIndex={-1}
          multiple
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            onSelect(toSelection(event.currentTarget.files))
            event.currentTarget.value = ""
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => filesRef.current?.click()}>
          Elegir archivos
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        En el CD, elige la carpeta entera: odentIA busca los DICOM dentro.
      </p>
    </section>
  )
}

/**
 * Cajón para subir una tomografía sin pasar por Imágenes: lo usa recepción
 * (`clinical.receive`), que no abre la historia clínica.
 */
export function TomographyUploadDrawer({
  patientId,
  open,
  onClose,
}: {
  patientId: string
  open: boolean
  onClose: () => void
}) {
  const flow = useTomographyFlow({ patientId, where: "El Resumen" })
  const [notFound, setNotFound] = useState(false)
  const close = () => {
    flow.reset()
    setNotFound(false)
    onClose()
  }
  const choose = async (selection: SelectedFile[]) => {
    if (!selection.length) return
    setNotFound(false)
    const found = await flow.scan(selection)
    if (!found.studies.some((study) => study.isVolume)) setNotFound(true)
  }
  const reviewing = Boolean(flow.candidate) && !flow.job && !flow.existing
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Subir una tomografía"
      description="La verá el equipo clínico. Tú ves que llegó, pero no la abres."
      onSubmit={(event) => {
        event.preventDefault()
        if (reviewing) void flow.start()
        else close()
      }}
      submitLabel={reviewing || flow.job || flow.existing ? tomographySubmitLabel(flow) : "Cerrar"}
      submitDisabled={flow.starting || Boolean(flow.scanning) || (reviewing && flow.tooBig)}
      isSubmitting={flow.starting}
      cancelLabel={reviewing ? (flow.nameCheck === false ? "No, cancelar" : "Cancelar") : "Cerrar"}
    >
      <div className="flex flex-col gap-4">
        {!flow.candidate && !flow.scanning && (
          <>
            <TomographyDropZone
              onSelect={(selection) => void choose(selection)}
              hint="Hasta 1 GB por tomografía."
            />
            {notFound && (
              <p role="alert" className="text-sm text-destructive">
                No encontramos una tomografía en lo que elegiste. Elige la carpeta entera del CD o el ZIP
                del centro de imágenes.
              </p>
            )}
          </>
        )}
        <TomographyFlowBody flow={flow} />
        {flow.job && flow.job.status !== "lista" && (
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={() => void flow.cancel()}>
              Cancelar subida
            </Button>
          </div>
        )}
      </div>
    </FormDrawer>
  )
}
