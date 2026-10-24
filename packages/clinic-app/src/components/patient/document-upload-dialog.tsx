import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { DatePickerButton, FormDrawer, regionToday } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { FileText, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { instantFromClinicValue } from "../../lib/clinical-journey"
import { orgSlugFromHostname } from "../../lib/host"
import { mayHoldStudy, type SelectedFile } from "../../lib/imaging-scan"
import type { Encounter, PlanItem } from "../../lib/patients"
import {
  basenameWithoutExtension,
  categoryLabel,
  encounterLabel,
  imageTypeLabel,
  imageTypesFor,
  isAcceptedFile,
  MAX_BYTES,
  planItemLabel,
  UPLOAD_CATEGORIES,
} from "./document-labels"
import { DocumentLinkSelects } from "./document-link-selects"
import { TagsInput } from "./tags-input"
import {
  TomographyDropZone,
  TomographyFlowBody,
  tomographySubmitLabel,
  useTomographyFlow,
} from "./tomography-upload"
import { PlacesField } from "../../product/site-fields"

type RowStatus = "pending" | "uploading" | "saved" | "error" | "unconfirmed"

interface QueuedFile {
  key: string
  file: File
  previewUrl: string | null
  title: string
  category: string
  /** Subtipo de imagen (radiografía o foto clínica). */
  imageType: string
  /** Día de toma (`yyyy-mm-dd`, en la zona de la clínica); vacío = el de subida. */
  capturedAt: string
  source: string
  teeth: number[]
  tags: string[]
  planItemId: string
  encounterProcedureId: string
  budgetId: string
  followUpId: string
  prescriptionId: string
  paymentId: string
  expanded: boolean
  status: RowStatus
  error: string | null
  validationError: string | null
}

export interface DocumentUploadDialogProps {
  patientId: string
  defaultEncounterId?: string
  /** Tratamiento ya en foco (p. ej. desde su recorrido): se propone en cada fila. */
  defaultPlanItemId?: string
  initialTeeth?: number[]
  encounters: Encounter[]
  planItems: PlanItem[]
  suggestions: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => Promise<void>
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
  disabled?: boolean
  /** Abre un documento que ya está en la ficha (la tomografía repetida). */
  onOpenDocument?: (documentId: string) => void
}

/**
 * Instante de toma de un día elegido en la clínica: hoy, ahora (nunca en el
 * futuro); otro día, su mediodía, que no se corre de fecha en ningún formato.
 * Sin día, `null`: vale la fecha de subida.
 */
function capturedInstant(day: string): string | null {
  if (!day) return null
  if (day === regionToday()) return new Date().toISOString()
  return instantFromClinicValue(`${day}T12:00`)
}

/** Solo borradores admiten vínculo directo al subir; lo cerrado se vincula por revisión auditada. */
function draftEncounters(encounters: Encounter[]): Encounter[] {
  return encounters.filter((e) => e.status === "borrador")
}

let rowSeq = 0

function toRow(
  file: File,
  initialTeeth: number[],
  defaultPlanItemId?: string,
): QueuedFile | { fileError: string } {
  if (!isAcceptedFile(file)) return { fileError: "Solo se admiten JPG, PNG, WebP, PDF o DICOM." }
  if (file.size === 0) return { fileError: "El archivo está vacío." }
  if (file.size > MAX_BYTES) return { fileError: "El archivo no puede superar 10 MB." }
  rowSeq += 1
  return {
    key: `${Date.now()}-${rowSeq}`,
    file,
    previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    title: basenameWithoutExtension(file.name),
    category: "",
    imageType: "",
    capturedAt: "",
    source: "",
    teeth: [...initialTeeth],
    tags: [],
    planItemId: defaultPlanItemId ?? "",
    encounterProcedureId: "",
    budgetId: "",
    followUpId: "",
    prescriptionId: "",
    paymentId: "",
    expanded: false,
    status: "pending",
    error: null,
    validationError: null,
  }
}

/**
 * Subida múltiple de imágenes/documentos con cola visible.
 * Sin porcentajes: cada fila muestra su estado (pendiente, subiendo,
 * guardado, error o resultado no confirmado). Sin reintento ciego:
 * un fallo de red deja la fila como "no confirmado" y refresca el
 * listado antes de permitir reenviar, para no duplicar archivos.
 */
export function DocumentUploadDialog({
  patientId,
  defaultEncounterId,
  defaultPlanItemId,
  initialTeeth,
  encounters,
  planItems,
  suggestions,
  open,
  onOpenChange,
  onSuccess,
  beforeWrite,
  onPendingChange,
  disabled,
  onOpenDocument,
}: DocumentUploadDialogProps) {
  const drafts = draftEncounters(encounters)
  const defaultIsDraft =
    defaultEncounterId != null && drafts.some((e) => e.id === defaultEncounterId)
  // Una carpeta de CD o un ZIP con una tomografía siguen su propio recorrido (ADR 0055).
  const tomography = useTomographyFlow({
    patientId,
    where: "Su fila en Documentos",
    onChange: () => void onSuccess(),
  })
  const [noStudy, setNoStudy] = useState(false)
  const [encounterChoice, setEncounterChoice] = useState<string>(
    defaultIsDraft ? (defaultEncounterId ?? "") : "",
  )
  const [rows, setRows] = useState<QueuedFile[]>([])
  const [rejected, setRejected] = useState<string[]>([])
  const [serverError, setServerError] = useState<string | null>(null)
  const fileId = useId()
  const encounterChoiceId = useId()
  const wasOpen = useRef(false)

  const patchRow = (key: string, patch: Partial<QueuedFile>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const reset = () => {
    for (const row of rows) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl)
    setRows([])
    setRejected([])
    setServerError(null)
    setEncounterChoice(defaultIsDraft ? (defaultEncounterId ?? "") : "")
    tomography.reset()
    setNoStudy(false)
  }

  useEffect(() => {
    if (open && !wasOpen.current) reset()
    wasOpen.current = open
  })

  const uploading = rows.some((row) => row.status === "uploading")
  // Los procedimientos solo existen dentro de una atención: el vínculo se elige
  // con la atención a la vista, nunca escribiendo un identificador.
  const procedureQuery = useQuery({
    queryKey: ["encounter-procedures", patientId, encounterChoice],
    queryFn: () =>
      apiFetch<{ data: { procedures: Array<{ id: string; description: string }> } }>(
        `/api/patients/${patientId}/encounters/${encounterChoice}`,
      ),
    enabled: open && encounterChoice !== "",
  })
  const procedures = procedureQuery.data?.data.procedures ?? []
  const pendingRows = rows.filter((row) => row.status === "pending" || row.status === "error")
  const unconfirmedRows = rows.filter((row) => row.status === "unconfirmed")
  const addFiles = (files: FileList | File[] | undefined | null) => {
    if (!files || disabled) return
    const list = [...files]
    if (!list.length) return
    const added: QueuedFile[] = []
    const bad: string[] = []
    for (const file of list) {
      const row = toRow(file, initialTeeth ?? [], defaultPlanItemId)
      if ("fileError" in row) bad.push(`${file.name}: ${row.fileError}`)
      else added.push(row)
    }
    if (added.length > 0) setRows((prev) => [...prev, ...added])
    if (bad.length > 0) setRejected((prev) => [...prev, ...bad])
  }

  const select = async (selection: SelectedFile[]) => {
    if (!selection.length || disabled) return
    setNoStudy(false)
    if (mayHoldStudy(selection, MAX_BYTES)) {
      const found = await tomography.scan(selection)
      if (found.studies.some((study) => study.isVolume)) return
      tomography.reset()
      // Una carpeta o un ZIP sin tomografía: solo entran sus imágenes y documentos sueltos.
      const fromFolder = selection.some((item) => item.name.includes("/") || /[.]zip$/i.test(item.name))
      if (fromFolder) {
        setNoStudy(true)
        addFiles(
          selection
            .map((item) =>
              item.file instanceof File
                ? item.file
                : new File([item.file], item.name.split("/").at(-1) ?? item.name),
            )
            .filter((file) => isAcceptedFile(file)),
        )
        return
      }
    }
    addFiles(selection.map((item) => item.file as File))
  }

  const removeRow = (key: string) => {
    setRows((prev) => {
      const row = prev.find((r) => r.key === key)
      if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl)
      return prev.filter((r) => r.key !== key)
    })
  }

  const validateRow = (row: QueuedFile): string | null => {
    const title = row.title.trim()
    if (!title) return "El título es obligatorio."
    if (title.length > 200) return "El título debe tener 1–200 caracteres."
    if (!row.category) return "Elige la categoría."
    if (imageTypesFor(row.category).length > 0 && !row.imageType)
      return "Elige el tipo de imagen."
    // El día de toma se elige en la zona de la clínica, no en la del navegador.
    if (row.capturedAt && row.capturedAt > regionToday()) return "La fecha de toma no puede ser futura."
    return null
  }

  const uploadRow = async (row: QueuedFile): Promise<boolean> => {
    patchRow(row.key, { status: "uploading", error: null })
    try {
      const form = new FormData()
      form.append("file", row.file)
      form.append("category", row.category)
      form.append("label", row.title.trim())
      if (row.imageType && imageTypesFor(row.category).includes(row.imageType as never))
        form.append("imageType", row.imageType)
      const capturedAt = capturedInstant(row.capturedAt)
      if (capturedAt) form.append("capturedAt", capturedAt)
      if (row.source.trim()) form.append("source", row.source.trim())
      if (encounterChoice) form.append("encounterId", encounterChoice)
      if (row.planItemId) form.append("planItemId", row.planItemId)
      if (row.encounterProcedureId) form.append("encounterProcedureId", row.encounterProcedureId)
      if (row.budgetId) form.append("budgetId", row.budgetId)
      if (row.followUpId) form.append("followUpId", row.followUpId)
      if (row.prescriptionId) form.append("prescriptionId", row.prescriptionId)
      if (row.paymentId) form.append("paymentId", row.paymentId)
      form.append("toothNumbers", JSON.stringify(row.teeth))
      form.append("tags", JSON.stringify(row.tags))
      const slug =
        typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname)
      const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      })
      if (!response.ok) {
        let message = `Error ${response.status}`
        try {
          const body = (await response.json()) as { error?: { message?: string } }
          if (body.error?.message) message = body.error.message
        } catch {
          // cuerpo no-JSON
        }
        patchRow(row.key, { status: "error", error: message })
        return false
      }
      patchRow(row.key, { status: "saved", error: null })
      await onSuccess()
      return true
    } catch {
      // Fallo de red o respuesta ilegible: el archivo pudo haberse guardado.
      // No se reintenta a ciegas: se refresca el listado y la fila exige
      // decisión explícita (verificar en Documentos o reenviar).
      patchRow(row.key, {
        status: "unconfirmed",
        error:
          "Resultado no confirmado: se perdió la conexión durante la subida. Revisa la lista de Documentos antes de reenviar para no duplicar.",
      })
      await onSuccess()
      return false
    }
  }

  const uploadRows = async (targets: QueuedFile[]) => {
    if (uploading || disabled || targets.length === 0) return
    let invalid = 0
    const valid: QueuedFile[] = []
    for (const row of targets) {
      const error = validateRow(row)
      patchRow(row.key, { validationError: error })
      if (error) invalid += 1
      else valid.push(row)
    }
    if (valid.length === 0) {
      setServerError(invalid > 0 ? "Revisa las filas marcadas antes de subir." : null)
      return
    }
    setServerError(null)
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      let failures = 0
      for (const row of valid) {
        const ok = await uploadRow(row)
        if (!ok) failures += 1
      }
      // Sin cierre automático ni toast de éxito global: si algo falló, el
      // diálogo queda abierto con cada fila marcada para decidir.
      if (failures > 0) {
        setServerError(
          `${failures} archivo(s) sin guardar. Revisa cada fila: corrige, reenvía o descarta.`,
        )
      }
    } finally {
      onPendingChange?.(false)
    }
  }

  const retryRow = async (row: QueuedFile) => {
    if (uploading || disabled) return
    // Tras un resultado no confirmado el listado ya se refrescó al fallar;
    // reenviar es una decisión explícita del usuario sobre esa fila.
    await uploadRows([{ ...row, status: "pending", error: null }])
  }

  const close = () => {
    if (uploading) return
    reset()
    onOpenChange(false)
  }

  const studyMode = Boolean(
    tomography.scanning || tomography.candidate || tomography.job || tomography.existing,
  )
  const reviewingStudy = Boolean(tomography.candidate) && !tomography.job && !tomography.existing

  if (studyMode)
    return (
      <FormDrawer
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(40rem,calc(100vw-2rem))]"
        open={open}
        onClose={close}
        title="Subir a la ficha"
        description="La tomografía va directo al almacenamiento y queda como un solo documento en Imágenes."
        onSubmit={(e) => {
          e.preventDefault()
          if (reviewingStudy) void tomography.start()
          else close()
        }}
        isSubmitting={tomography.starting}
        submitDisabled={
          disabled || Boolean(tomography.scanning) || (reviewingStudy && tomography.tooBig)
        }
        submitLabel={tomographySubmitLabel(tomography)}
        cancelLabel={
          reviewingStudy ? (tomography.nameCheck === false ? "No, cancelar" : "Cancelar") : "Cerrar"
        }
      >
        <div className="flex flex-col gap-4">
          <TomographyFlowBody
            flow={tomography}
            onOpenExisting={
              onOpenDocument
                ? (documentId) => {
                    close()
                    onOpenDocument(documentId)
                  }
                : undefined
            }
          />
          {tomography.job && tomography.job.status !== "lista" && (
            <div>
              <Button type="button" size="sm" variant="ghost" onClick={() => void tomography.cancel()}>
                Cancelar subida
              </Button>
            </div>
          )}
        </div>
      </FormDrawer>
    )

  return (
    <FormDrawer
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      open={open}
      onClose={close}
      title="Subir imágenes o documentos"
      description="JPG, PNG, WebP, PDF o DICOM, máx. 10 MB por archivo; la tomografía, hasta 1 GB. El formato se verifica por contenido. Sin atención queda como General."
      onSubmit={(e) => {
        e.preventDefault()
        void uploadRows(pendingRows)
      }}
      isSubmitting={uploading}
      submitDisabled={disabled || pendingRows.length === 0}
      submitLabel={uploading ? "Subiendo…" : `Subir ${pendingRows.length}`}
      error={serverError}
    >
      <fieldset disabled={uploading || disabled} className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={encounterChoiceId}>Atención común (opcional)</FieldLabel>
          <Select
            items={Object.fromEntries(drafts.map((e) => [e.id, encounterLabel(e)] as const))}
            value={encounterChoice}
            onValueChange={(v) => setEncounterChoice(v ?? "")}
          >
            <SelectTrigger id={encounterChoiceId} aria-label="Atención a vincular">
              <SelectValue placeholder="General (sin atención)" />
            </SelectTrigger>
            <SelectContent>
              {drafts.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {encounterLabel(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {encounterChoice && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEncounterChoice("")}>
              Subir como general
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {defaultEncounterId && !defaultIsDraft
              ? "La atención actual está cerrada: los archivos se suben como general y luego puedes vincularlos con una revisión de contexto (queda auditado)."
              : "Solo atenciones en borrador. Para una atención cerrada, sube como general y vincúlalo después con una revisión de contexto."}
          </p>
        </Field>

        <Field>
          <FieldLabel htmlFor={fileId}>Archivos</FieldLabel>
          <div id={fileId}>
            <TomographyDropZone
              disabled={disabled}
              onSelect={(selection) => void select(selection)}
              hint="Fotos, PDF, radiografías y tomografías. Hasta 10 MB por archivo y 1 GB por tomografía."
            />
          </div>
          {noStudy && (
            <p className="text-xs text-muted-foreground">
              No encontramos una tomografía en lo elegido: se agregan solo sus imágenes y documentos.
            </p>
          )}
          {rejected.length > 0 && (
            <ul className="flex flex-col gap-1">
              {rejected.map((message) => (
                <li key={message} className="flex items-center gap-2 text-xs text-destructive">
                  <span className="min-w-0 flex-1">{message}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejected((prev) => prev.filter((m) => m !== message))}
                  >
                    Descartar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {rows.length > 0 && (
          <ol className="flex flex-col gap-3">
            {rows.map((row) => (
              <QueuedRow
                key={row.key}
                row={row}
                patientId={patientId}
                planItems={planItems}
                procedures={procedures}
                suggestions={suggestions}
                busy={uploading}
                onPatch={(patch) => patchRow(row.key, patch)}
                onRemove={() => removeRow(row.key)}
                onRetry={() => void retryRow(row)}
              />
            ))}
          </ol>
        )}

        {unconfirmedRows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Hay {unconfirmedRows.length} archivo(s) con resultado no confirmado. La lista de Documentos ya se
            actualizó: verifica si aparecen antes de reenviar.
          </p>
        )}
      </fieldset>
    </FormDrawer>
  )
}

function rowStateLabel(status: RowStatus): string {
  switch (status) {
    case "pending":
      return "Pendiente"
    case "uploading":
      return "Subiendo…"
    case "saved":
      return "Guardado"
    case "error":
      return "Error"
    case "unconfirmed":
      return "Resultado no confirmado"
  }
}

function QueuedRow({
  row,
  patientId,
  planItems,
  procedures,
  suggestions,
  busy,
  onPatch,
  onRemove,
  onRetry,
}: {
  row: QueuedFile
  patientId: string
  planItems: PlanItem[]
  /** Procedimientos de la atención elegida; vacío sin atención. */
  procedures: Array<{ id: string; description: string }>
  suggestions: string[]
  busy: boolean
  onPatch: (patch: Partial<QueuedFile>) => void
  onRemove: () => void
  onRetry: () => void
}) {
  const titleId = useId()
  const categoryId = useId()
  const planChoiceId = useId()
  const removable =
    row.status === "pending" || row.status === "error" || row.status === "unconfirmed"
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <Attachment
        state={
          row.status === "uploading"
            ? "uploading"
            : row.status === "error" || row.status === "unconfirmed"
              ? "error"
              : "done"
        }
        orientation="horizontal"
        className="w-full"
      >
        <AttachmentMedia variant={row.previewUrl ? "image" : "icon"}>
          {row.previewUrl ? (
            <img src={row.previewUrl} alt={row.file.name} />
          ) : (
            <FileText aria-hidden="true" />
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{row.file.name}</AttachmentTitle>
          <AttachmentDescription>
            {row.file.type || "archivo"} · {(row.file.size / 1024).toFixed(0)} KB ·{" "}
            {rowStateLabel(row.status)}
          </AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          {removable && (
            <AttachmentAction
              aria-label={`Descartar ${row.file.name}`}
              disabled={busy}
              onClick={onRemove}
            >
              <X aria-hidden="true" />
            </AttachmentAction>
          )}
        </AttachmentActions>
      </Attachment>

      {row.status !== "saved" ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={titleId}>Título</FieldLabel>
              <Input
                id={titleId}
                value={row.title}
                disabled={busy}
                onChange={(e) => onPatch({ title: e.currentTarget.value, validationError: null })}
                placeholder="p. ej. Panorámica inicial"
                maxLength={200}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={categoryId}>Categoría</FieldLabel>
              <Select
                items={Object.fromEntries(UPLOAD_CATEGORIES.map((c) => [c, categoryLabel(c)]))}
                value={row.category}
                onValueChange={(v) =>
                  onPatch({
                    category: v ?? "",
                    imageType: imageTypesFor(v ?? "").includes(row.imageType as never)
                      ? row.imageType
                      : "",
                    validationError: null,
                  })
                }
              >
                <SelectTrigger id={categoryId} aria-label={`Categoría de ${row.file.name}`}>
                  <SelectValue placeholder="Elige la categoría" />
                </SelectTrigger>
                <SelectContent>
                  {UPLOAD_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {categoryLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {imageTypesFor(row.category).length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${titleId}-type`}>Tipo de imagen</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    imageTypesFor(row.category).map((t) => [t, imageTypeLabel(t)] as const),
                  )}
                  value={row.imageType}
                  onValueChange={(v) => onPatch({ imageType: v ?? "", validationError: null })}
                >
                  <SelectTrigger
                    id={`${titleId}-type`}
                    aria-required="true"
                    aria-label={`Tipo de imagen de ${row.file.name}`}
                  >
                    <SelectValue placeholder="Elige el tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    {imageTypesFor(row.category).map((t) => (
                      <SelectItem key={t} value={t}>
                        {imageTypeLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${titleId}-taken`}>Fecha de toma</FieldLabel>
                <DatePickerButton
                  id={`${titleId}-taken`}
                  className="w-full"
                  value={row.capturedAt}
                  disabled={busy}
                  max={regionToday()}
                  emptyLabel="La de subida"
                  onChange={(next) => onPatch({ capturedAt: next, validationError: null })}
                  aria-describedby={`${titleId}-taken-help`}
                />
                <p id={`${titleId}-taken-help`} className="text-xs text-muted-foreground">
                  Si queda vacía se usa la fecha de subida.
                </p>
              </Field>
            </div>
          )}
          {row.validationError && <FieldError>{row.validationError}</FieldError>}

          <details
            open={row.expanded}
            onToggle={(e) => onPatch({ expanded: (e.currentTarget as HTMLDetailsElement).open })}
          >
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Extras: piezas, tratamiento, vínculos y etiquetas
              {row.teeth.length > 0 ||
              row.planItemId ||
              row.encounterProcedureId ||
              row.budgetId ||
              row.followUpId ||
              row.prescriptionId ||
              row.paymentId ||
              row.tags.length > 0
                ? " (con datos)"
                : ""}
            </summary>
            <div className="flex flex-col gap-2 pt-2">
              {imageTypesFor(row.category).length > 0 && (
                <Field>
                  <FieldLabel htmlFor={`${titleId}-source`}>Origen (opcional)</FieldLabel>
                  <Input
                    id={`${titleId}-source`}
                    value={row.source}
                    maxLength={120}
                    disabled={busy}
                    placeholder="p. ej. Sensor intraoral · sala 2 o centro externo"
                    onChange={(e) => onPatch({ source: e.currentTarget.value })}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={planChoiceId}>Tratamiento (opcional)</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    planItems.map((p) => [p.id, planItemLabel(p)] as const),
                  )}
                  value={row.planItemId}
                  onValueChange={(v) => onPatch({ planItemId: v ?? "" })}
                >
                  <SelectTrigger id={planChoiceId} aria-label={`Tratamiento de ${row.file.name}`}>
                    <SelectValue placeholder="Sin tratamiento" />
                  </SelectTrigger>
                  <SelectContent>
                    {planItems.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {planItemLabel(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {row.planItemId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onPatch({ planItemId: "" })}
                  >
                    Quitar vínculo a tratamiento
                  </Button>
                )}
              </Field>
              <PlacesField value={row.teeth} onChange={(teeth) => onPatch({ teeth })} optional />
              <DocumentLinkSelects
                patientId={patientId}
                idPrefix={`${planChoiceId}-links`}
                procedures={procedures}
                value={{
                  budgetId: row.budgetId,
                  followUpId: row.followUpId,
                  prescriptionId: row.prescriptionId,
                  paymentId: row.paymentId,
                  encounterProcedureId: row.encounterProcedureId,
                }}
                onChange={(patch) => onPatch(patch)}
              />
              <TagsInput
                value={row.tags}
                onChange={(tags) => onPatch({ tags })}
                suggestions={suggestions}
              />
            </div>
          </details>

          {(row.status === "error" || row.status === "unconfirmed") && row.error && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
                {row.error}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
                {row.status === "unconfirmed" ? "Verifiqué: reenviar" : "Reintentar"}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Guardado en Documentos
          {row.category
            ? ` como ${imageTypeLabel(row.imageType) ?? categoryLabel(row.category)}`
            : ""}
          .
        </p>
      )}
    </li>
  )
}
