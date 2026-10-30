import { productUi } from "../../product/product-ui"
import { appWords } from "../../lib/product-words"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Button,
  FieldError,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  type ApiErrorShape,
  DatePickerButton,
  FormDrawer,
  focusFirstInvalid,
  isUnconfirmedSubmit,
  regionToday,
  setSubmitErrors,
  submitErrorOf,
  submitForm,
  useAppForm,
  useFieldControl,
  useFormSurface,
  withForm,
} from "@odentia/ui-patterns"
import { type AnyFormApi, useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { FileText, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
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
import { DocumentLinkSelects, type DocumentLinkValue } from "./document-link-selects"
import { TAGS_INPUT_HELP, TagsCount, TagsInput } from "./tags-input"
import {
  TomographyDropZone,
  TomographyFlowBody,
  tomographySubmitLabel,
  useTomographyFlow,
} from "./tomography-upload"
import { PlacesField } from "../../product/site-fields"

type RowStatus = "pending" | "uploading" | "saved" | "error" | "unconfirmed"

/** Lo que se escribe de cada archivo: los campos de su fila. */
interface RowValues {
  key: string
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
  links: DocumentLinkValue
}

/** El archivo de una fila y cómo va su subida (no son datos que se escriban). */
interface RowFile {
  file: File
  previewUrl: string | null
  status: RowStatus
  /** Lo que la ficha dijo del archivo y no es de ningún campo de la fila. */
  error: string | null
  expanded: boolean
}

interface UploadValues {
  encounterId: string
  rows: RowValues[]
}

const NO_LINKS: DocumentLinkValue = {
  budgetId: "",
  followUpId: "",
  prescriptionId: "",
  paymentId: "",
  encounterProcedureId: "",
}

const EMPTY_UPLOAD: UploadValues = { encounterId: "", rows: [] }

const UNCONFIRMED_ROW =
  "Resultado no confirmado: se perdió la conexión durante la subida. Revisa la lista de Documentos antes de reenviar para no duplicar."

/**
 * Lo que se comprueba de cada fila antes de subirla: los mismos límites que
 * `POST /api/patients/:id/documents` (título 1–200, categoría, tipo de imagen
 * de esa categoría, toma no futura, origen hasta 120).
 */
const rowSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, { error: "Escribe el título." })
      .max(200, { error: "El título admite hasta 200 caracteres." }),
    category: z.string().min(1, { error: "Elige la categoría." }),
    imageType: z.string(),
    capturedAt: z.string(),
    source: z.string(),
  })
  .superRefine((row, ctx) => {
    // Tipo, fecha de toma y origen solo se piden (y se envían) en las categorías de imagen.
    if (imageTypesFor(row.category).length === 0) return
    if (!row.imageType)
      ctx.addIssue({ code: "custom", path: ["imageType"], message: "Elige el tipo de imagen." })
    // El día de toma se elige en la zona de la clínica, no en la del navegador.
    if (row.capturedAt && row.capturedAt > regionToday())
      ctx.addIssue({ code: "custom", path: ["capturedAt"], message: "La fecha de toma no puede ser futura." })
    if (row.source.trim().length > 120)
      ctx.addIssue({ code: "custom", path: ["source"], message: "El origen admite hasta 120 caracteres." })
  })

/** Cómo se llama en la fila cada dato que la API señala por su nombre en el cuerpo. */
const ROW_FIELD: Record<string, keyof RowValues> = {
  label: "title",
  category: "category",
  imageType: "imageType",
  capturedAt: "capturedAt",
  source: "source",
  planItemId: "planItemId",
  toothNumbers: "teeth",
  tags: "tags",
  budgetId: "links",
  followUpId: "links",
  prescriptionId: "links",
  paymentId: "links",
  encounterProcedureId: "links",
}

/** Los campos que viven en «Extras»: si el error cae en uno, se abre. */
const EXTRAS_FIELDS: Partial<Record<keyof RowValues, true>> = {
  source: true,
  planItemId: true,
  teeth: true,
  tags: true,
  links: true,
}

type RowOutcome = { ok: true } | { ok: false; message: string | null; fields: Record<string, string> }

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
): { values: RowValues; meta: RowFile } | { fileError: string } {
  if (!isAcceptedFile(file)) return { fileError: "Solo se admiten JPG, PNG, WebP, PDF o DICOM." }
  if (file.size === 0) return { fileError: "El archivo está vacío." }
  if (file.size > MAX_BYTES) return { fileError: "El archivo no puede superar 10 MB." }
  rowSeq += 1
  return {
    values: {
      key: `${Date.now()}-${rowSeq}`,
      title: basenameWithoutExtension(file.name),
      category: "",
      imageType: "",
      capturedAt: "",
      source: "",
      teeth: [...initialTeeth],
      tags: [],
      planItemId: defaultPlanItemId ?? "",
      links: { ...NO_LINKS },
    },
    meta: {
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      status: "pending",
      error: null,
      expanded: false,
    },
  }
}

/**
 * Subida múltiple de imágenes/documentos con cola visible.
 * Sin porcentajes: cada fila muestra su estado (pendiente, subiendo,
 * guardado, error o resultado no confirmado). Sin reintento ciego:
 * un fallo de red deja la fila como "no confirmado" y refresca el
 * listado antes de permitir reenviar, para no duplicar archivos.
 *
 * Cada fila es parte de un mismo formulario (`rows[i].…`): lo que falta o lo
 * que la ficha rechaza se dice en el campo de esa fila; lo que es de la
 * atención común, en ella; el resumen, junto a los botones.
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
  const [files, setFiles] = useState<Record<string, RowFile>>({})
  const [rejected, setRejected] = useState<string[]>([])
  const wasOpen = useRef(false)
  /** Las filas que sube este envío: las pendientes, o la que se reintenta. */
  const targets = useRef<ReadonlySet<string>>(new Set())

  const patchFile = (key: string, patch: Partial<RowFile>) =>
    setFiles((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev))

  const uploadRow = async (row: RowValues, file: File, encounterId: string): Promise<RowOutcome> => {
    patchFile(row.key, { status: "uploading", error: null })
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("category", row.category)
      body.append("label", row.title.trim())
      const types = imageTypesFor(row.category)
      if (types.length > 0) {
        if (types.includes(row.imageType)) body.append("imageType", row.imageType)
        const capturedAt = capturedInstant(row.capturedAt)
        if (capturedAt) body.append("capturedAt", capturedAt)
        if (row.source.trim()) body.append("source", row.source.trim())
      }
      if (encounterId) body.append("encounterId", encounterId)
      if (row.planItemId) body.append("planItemId", row.planItemId)
      for (const [name, id] of Object.entries(row.links)) if (id) body.append(name, id)
      body.append("toothNumbers", JSON.stringify(row.teeth))
      body.append("tags", JSON.stringify(row.tags))
      const slug =
        typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname)
      const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body,
      })
      if (!response.ok) {
        const shape = await response
          .json()
          .then((parsed: { error?: ApiErrorShape }) => parsed.error ?? {})
          .catch(() => ({}))
        const error = new ApiError(response.status, shape)
        // 5xx/408: no se sabe si quedó guardado; se trata como la red.
        if (isUnconfirmedSubmit(error)) throw error
        const { form: message, fields } = submitErrorOf(error)
        patchFile(row.key, { status: "error" })
        return { ok: false, message, fields }
      }
      patchFile(row.key, { status: "saved", error: null })
      await onSuccess()
      return { ok: true }
    } catch {
      // Fallo de red o respuesta ilegible: el archivo pudo haberse guardado.
      // No se reintenta a ciegas: se refresca el listado y la fila exige
      // decisión explícita (verificar en Documentos o reenviar).
      patchFile(row.key, { status: "unconfirmed", error: UNCONFIRMED_ROW })
      await onSuccess()
      return { ok: false, message: null, fields: {} }
    }
  }

  const form = useAppForm({
    defaultValues: {
      encounterId: defaultIsDraft ? (defaultEncounterId ?? "") : "",
      rows: [],
    } as UploadValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        const queued = value.rows.filter((row) => targets.current.has(row.key))
        if (queued.length === 0)
          fields.rows =
            value.rows.length === 0
              ? "Elige los archivos que quieres subir."
              : "No queda ningún archivo por subir: los no confirmados se reenvían desde su fila."
        value.rows.forEach((row, index) => {
          if (!targets.current.has(row.key)) return
          const parsed = rowSchema.safeParse(row)
          if (parsed.success) return
          for (const issue of parsed.error.issues)
            fields[`rows[${index}].${String(issue.path[0])}`] ??= issue.message
        })
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const queue = value.rows.flatMap((row, index) => {
        const meta = files[row.key]
        return targets.current.has(row.key) && meta ? [{ row, index, file: meta.file }] : []
      })
      onPendingChange?.(true)
      try {
        // Si guardar antes la atención falla, el error sale de aquí y se dice junto a los botones.
        await beforeWrite?.()
        const api = formApi as unknown as AnyFormApi
        // Solo los campos en pantalla: lo que no lo está se dice como texto de su fila.
        const fieldInfo = api.fieldInfo as Record<string, { instance: unknown } | undefined>
        const placed: Record<string, string> = {}
        let failures = 0
        for (const { row, index, file } of queue) {
          const outcome = await uploadRow(row, file, value.encounterId)
          if (outcome.ok) continue
          failures += 1
          const loose: string[] = []
          let inExtras = false
          for (const [serverField, message] of Object.entries(outcome.fields)) {
            const sub = ROW_FIELD[serverField]
            const name = serverField === "encounterId" ? "encounterId" : sub ? `rows[${index}].${sub}` : null
            if (name && fieldInfo[name]?.instance) {
              placed[name] ??= message
              if (sub && EXTRAS_FIELDS[sub]) inExtras = true
            } else loose.push(message)
          }
          const text = [outcome.message, ...loose].filter((part): part is string => Boolean(part))
          if (text.length > 0 || inExtras)
            patchFile(row.key, {
              ...(text.length > 0 ? { error: [...new Set(text)].join(" ") } : {}),
              ...(inExtras ? { expanded: true } : {}),
            })
        }
        // Sin cierre automático ni toast de éxito global: si algo falló, el
        // diálogo queda abierto con cada fila marcada para decidir.
        if (failures > 0) {
          setSubmitErrors(api, {
            form: `${failures} archivo(s) sin guardar. Revisa cada fila: corrige, reenvía o descarta.`,
            fields: placed,
          })
          focusFirstInvalid(null)
        }
      } finally {
        onPendingChange?.(false)
      }
    },
  })
  const surface = useFormSurface(form)
  const uploading = surface.isSubmitting

  const reset = () => {
    for (const meta of Object.values(files)) if (meta.previewUrl) URL.revokeObjectURL(meta.previewUrl)
    setFiles({})
    setRejected([])
    form.reset()
    tomography.reset()
    setNoStudy(false)
  }

  useEffect(() => {
    if (open && !wasOpen.current) reset()
    wasOpen.current = open
  })

  const rows = useStore(form.store, (state) => state.values.rows)
  const encounterChoice = useStore(form.store, (state) => state.values.encounterId)
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
  const statusOf = (key: string) => files[key]?.status
  const pendingKeys = rows
    .filter((row) => statusOf(row.key) === "pending" || statusOf(row.key) === "error")
    .map((row) => row.key)
  const unconfirmedCount = rows.filter((row) => statusOf(row.key) === "unconfirmed").length

  const addFiles = (list: File[]) => {
    if (disabled || !list.length) return
    const bad: string[] = []
    const added: Record<string, RowFile> = {}
    for (const file of list) {
      const row = toRow(file, initialTeeth ?? [], defaultPlanItemId)
      if ("fileError" in row) {
        bad.push(`${file.name}: ${row.fileError}`)
        continue
      }
      added[row.values.key] = row.meta
      form.pushFieldValue("rows", row.values)
    }
    if (Object.keys(added).length > 0) setFiles((prev) => ({ ...prev, ...added }))
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

  const removeRow = (index: number) => {
    const row = rows[index]
    if (!row) return
    const meta = files[row.key]
    if (meta?.previewUrl) URL.revokeObjectURL(meta.previewUrl)
    void form.removeFieldValue("rows", index)
    setFiles((prev) => {
      const next = { ...prev }
      delete next[row.key]
      return next
    })
  }

  const retryRow = (key: string) => {
    if (uploading || disabled) return
    // Tras un resultado no confirmado el listado ya se refrescó al fallar;
    // reenviar es una decisión explícita del usuario sobre esa fila.
    targets.current = new Set([key])
    void submitForm(form)
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
      onSubmit={(event) => {
        targets.current = new Set(pendingKeys)
        surface.onSubmit(event)
      }}
      isSubmitting={uploading}
      error={surface.error}
      // Solo por permiso: lo que falta en una fila se dice en su campo al subir.
      submitDisabled={disabled}
      submitLabel={uploading ? "Subiendo…" : `Subir ${pendingKeys.length}`}
    >
      <fieldset disabled={uploading || disabled} className="flex flex-col gap-3">
        <form.AppField name="encounterId">
          {(field) => (
            <field.Control
              label="Atención común (opcional)"
              description={
                defaultEncounterId && !defaultIsDraft
                  ? "La atención actual está cerrada: los archivos se suben como general y luego puedes vincularlos con una revisión de contexto (queda auditado)."
                  : "Solo atenciones en borrador. Para una atención cerrada, sube como general y vincúlalo después con una revisión de contexto."
              }
            >
              {(control) => (
                <>
                  <Select
                    items={Object.fromEntries(drafts.map((e) => [e.id, encounterLabel(e)] as const))}
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v ?? "")}
                  >
                    <SelectTrigger
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    >
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
                  {field.state.value && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => field.handleChange("")}>
                      Subir como general
                    </Button>
                  )}
                </>
              )}
            </field.Control>
          )}
        </form.AppField>

        <form.AppField name="rows" mode="array">
          {(rowsField) => (
            <>
              <rowsField.Group legend="Archivos">
                {(control) => (
                  <>
                    <div aria-invalid={control.invalid || undefined} aria-describedby={control.describedBy}>
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
                      <ul role="alert" className="flex flex-col gap-1">
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
                  </>
                )}
              </rowsField.Group>

              {rows.length > 0 && (
                <ol className="flex flex-col gap-3">
                  {rows.map((row, index) => {
                    const meta = files[row.key]
                    return meta ? (
                      <QueuedRow
                        key={row.key}
                        form={form}
                        index={index}
                        meta={meta}
                        patientId={patientId}
                        planItems={planItems}
                        procedures={procedures}
                        suggestions={suggestions}
                        busy={uploading}
                        onToggle={(expanded) => patchFile(row.key, { expanded })}
                        onRemove={() => removeRow(index)}
                        onRetry={() => retryRow(row.key)}
                      />
                    ) : null
                  })}
                </ol>
              )}
            </>
          )}
        </form.AppField>

        {unconfirmedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Hay {unconfirmedCount} archivo(s) con resultado no confirmado. La lista de Documentos ya se
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

/** Los vínculos de la fila: un grupo de selects con el error del que la ficha no encontró. */
function LinksControl({
  id,
  patientId,
  procedures,
  value,
  onChange,
}: {
  id: string
  patientId: string
  procedures: Array<{ id: string; description: string }>
  value: DocumentLinkValue
  onChange: (next: DocumentLinkValue) => void
}) {
  const { control, errors, errorId } = useFieldControl({ id, hasDescription: false })
  return (
    <div data-invalid={control.invalid || undefined} className="flex flex-col gap-2">
      <DocumentLinkSelects
        patientId={patientId}
        id={id}
        procedures={procedures}
        value={value}
        onChange={(patch) => onChange({ ...value, ...patch })}
        invalid={control.invalid}
        onBlur={control.onBlur}
        aria-describedby={control.describedBy}
        aria-label="Vínculos del archivo"
      />
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </div>
  )
}

interface QueuedRowProps {
  index: number
  meta: RowFile
  patientId: string
  planItems: PlanItem[]
  /** Procedimientos de la atención elegida; vacío sin atención. */
  procedures: Array<{ id: string; description: string }>
  suggestions: string[]
  busy: boolean
  onToggle: (expanded: boolean) => void
  onRemove: () => void
  onRetry: () => void
}

const QueuedRow = withForm({
  defaultValues: EMPTY_UPLOAD,
  props: {} as QueuedRowProps,
  render: function QueuedRowRender({
    form,
    index,
    meta,
    patientId,
    planItems,
    procedures,
    suggestions,
    busy,
    onToggle,
    onRemove,
    onRetry,
  }) {
    const id = useId()
    const row = useStore(form.store, (state) => state.values.rows[index])
    if (!row) return null
    const name = meta.file.name
    const forFile = <span className="sr-only"> de {name}</span>
    const types = imageTypesFor(row.category)
    const removable = meta.status === "pending" || meta.status === "error" || meta.status === "unconfirmed"
    const at = `rows[${index}]` as const
    const withExtras =
      row.teeth.length > 0 ||
      row.planItemId ||
      Object.values(row.links).some(Boolean) ||
      row.tags.length > 0
    return (
      <li className="flex flex-col gap-2 rounded-lg border p-3">
        <Attachment
          state={
            meta.status === "uploading"
              ? "uploading"
              : meta.status === "error" || meta.status === "unconfirmed"
                ? "error"
                : "done"
          }
          orientation="horizontal"
          className="w-full"
        >
          <AttachmentMedia variant={meta.previewUrl ? "image" : "icon"}>
            {meta.previewUrl ? <img src={meta.previewUrl} alt={name} /> : <FileText aria-hidden="true" />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{name}</AttachmentTitle>
            <AttachmentDescription>
              {meta.file.type || "archivo"} · {(meta.file.size / 1024).toFixed(0)} KB ·{" "}
              {rowStateLabel(meta.status)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            {removable && (
              <AttachmentAction aria-label={`Descartar ${name}`} disabled={busy} onClick={onRemove}>
                <X aria-hidden="true" />
              </AttachmentAction>
            )}
          </AttachmentActions>
        </Attachment>

        {meta.status !== "saved" ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <form.AppField name={`${at}.title`}>
                {(field) => (
                  <field.TextField
                    id={`${id}-title`}
                    label={<>Título{forFile}</>}
                    disabled={busy}
                    placeholder={`p. ej. ${appWords().examples.imagingTitle}`}
                    maxLength={200}
                  />
                )}
              </form.AppField>
              <form.AppField
                name={`${at}.category`}
                listeners={{
                  // Otro tipo de archivo: el tipo de imagen elegido deja de valer si no es de esa categoría.
                  onChange: ({ value }) => {
                    const current = form.getFieldValue(`${at}.imageType`)
                    if (current && !imageTypesFor(value).includes(current))
                      form.setFieldValue(`${at}.imageType`, "")
                  },
                }}
              >
                {(field) => (
                  <field.SelectField
                    id={`${id}-category`}
                    label={<>Categoría{forFile}</>}
                    placeholder="Elige la categoría"
                    options={UPLOAD_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                  />
                )}
              </form.AppField>
            </div>
            {types.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <form.AppField name={`${at}.imageType`}>
                  {(field) => (
                    <field.SelectField
                      id={`${id}-type`}
                      label={<>Tipo de imagen{forFile}</>}
                      placeholder="Elige el tipo"
                      options={types.map((t) => ({ value: t, label: imageTypeLabel(t) ?? t }))}
                    />
                  )}
                </form.AppField>
                <form.AppField name={`${at}.capturedAt`}>
                  {(field) => (
                    <field.Control
                      id={`${id}-taken`}
                      label="Fecha de toma"
                      description="Si queda vacía se usa la fecha de subida."
                    >
                      {(control) => (
                        <DatePickerButton
                          {...control.props}
                          className="w-full"
                          value={field.state.value}
                          disabled={busy}
                          max={regionToday()}
                          emptyLabel="La de subida"
                          onChange={(next) => field.handleChange(next)}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
              </div>
            )}

            <details open={meta.expanded} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {productUi().site
                  ? "Extras: piezas, tratamiento, vínculos y etiquetas"
                  : "Extras: tratamiento, vínculos y etiquetas"}
                {withExtras ? " (con datos)" : ""}
              </summary>
              <div className="flex flex-col gap-2 pt-2">
                {types.length > 0 && (
                  <form.AppField name={`${at}.source`}>
                    {(field) => (
                      <field.TextField
                        id={`${id}-source`}
                        label="Origen (opcional)"
                        maxLength={120}
                        disabled={busy}
                        placeholder={`p. ej. ${appWords().examples.imagingSource}`}
                      />
                    )}
                  </form.AppField>
                )}
                <form.AppField name={`${at}.planItemId`}>
                  {(field) => (
                    <field.Control id={`${id}-plan`} label={<>Tratamiento (opcional){forFile}</>}>
                      {(control) => (
                        <>
                          <Select
                            items={Object.fromEntries(planItems.map((p) => [p.id, planItemLabel(p)] as const))}
                            value={field.state.value}
                            onValueChange={(v) => field.handleChange(v ?? "")}
                          >
                            <SelectTrigger
                              id={control.id}
                              aria-invalid={control.invalid || undefined}
                              aria-describedby={control.describedBy}
                              onBlur={control.onBlur}
                            >
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
                          {field.state.value && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => field.handleChange("")}>
                              Quitar vínculo a tratamiento
                            </Button>
                          )}
                        </>
                      )}
                    </field.Control>
                  )}
                </form.AppField>
                {productUi().site ? (
                  <form.AppField name={`${at}.teeth`}>
                    {(field) => (
                      <field.Group id={`${id}-teeth`} legend={`${productUi().site?.placesLabel} (opcional)`}>
                        {(control) => (
                          <PlacesField
                            id={control.id}
                            value={field.state.value}
                            onChange={(teeth) => field.handleChange(teeth)}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                          />
                        )}
                      </field.Group>
                    )}
                  </form.AppField>
                ) : null}
                <form.AppField name={`${at}.links`}>
                  {(field) => (
                    <LinksControl
                      id={`${id}-links`}
                      patientId={patientId}
                      procedures={procedures}
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </form.AppField>
                <form.AppField name={`${at}.tags`}>
                  {(field) => (
                    <field.Control
                      id={`${id}-tags`}
                      label={
                        <>
                          Etiquetas <TagsCount count={field.state.value.length} />
                        </>
                      }
                      description={TAGS_INPUT_HELP}
                    >
                      {(control) => (
                        <TagsInput
                          id={control.id}
                          value={field.state.value}
                          onChange={(tags) => field.handleChange(tags)}
                          suggestions={suggestions}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
              </div>
            </details>

            {(meta.status === "error" || meta.status === "unconfirmed") && meta.error && (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
                  {meta.error}
                </p>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
                  {meta.status === "unconfirmed" ? "Verifiqué: reenviar" : "Reintentar"}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Guardado en Documentos
            {row.category ? ` como ${imageTypeLabel(row.imageType) ?? categoryLabel(row.category)}` : ""}.
          </p>
        )}
      </li>
    )
  },
})
