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
  cn,
  FieldError,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  addSubmitErrors,
  type ApiErrorShape,
  common,
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
import { readChosenFile } from "../../lib/chosen-file"
import { shortDay } from "../../lib/declared-health"
import { orgSlugFromHostname } from "../../lib/host"
import { mayHoldStudy, type SelectedFile } from "../../lib/imaging-scan"
import type { Encounter, EncounterDetail, PlanItem } from "../../lib/patients"
import {
  attentionTeeth,
  composeTitle,
  type FileHints,
  type HintSource,
  isGenericFileName,
  placesWords,
  readFileHints,
} from "../../lib/upload-hints"
import {
  basenameWithoutExtension,
  capturedInstant,
  categoryLabel,
  documentDateLabel,
  encounterLabel,
  imageTypeLabel,
  imageTypesFor,
  isAcceptedFile,
  isDicomFile,
  MAX_BYTES,
  maxBytesFor,
  planItemLabel,
  storesTomography,
  unsupportedFormatMessage,
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

/** La atención común vacía: el archivo queda en la ficha sin atención. */
const GENERAL_WORDS = "General (sin atención)"

type RowStatus = "pending" | "uploading" | "saved" | "error" | "unconfirmed"

/**
 * De dónde salió lo que se llenó solo: el archivo (sus datos, su nombre o su formato),
 * la atención, la pieza del filtro, la hoja que se va a subir o, en el título, todo eso junto.
 */
type FilledFrom = HintSource | "atencion" | "pieza" | "hoja" | "titulo"
type FilledField = "title" | "category" | "imageType" | "capturedAt" | "teeth"
/** Lo que se puso solo en un campo (las piezas, separadas por coma) y de dónde salió. */
interface Filled {
  value: string
  from: FilledFrom
}

/** La marca de lo que se llenó solo, mientras el campo siga con eso: después es de la persona. */
const FILLED_WORDS: Record<FilledField, Partial<Record<FilledFrom, string>>> = {
  title: { titulo: "Sugerido con lo que trae el archivo" },
  category: {
    archivo: "Tomada del archivo",
    nombre: "Tomada del nombre del archivo",
    formato: "Sugerida para un PDF",
    hoja: "La de la hoja que vas a subir",
  },
  imageType: { archivo: "Tomado del archivo", nombre: "Tomado del nombre del archivo" },
  capturedAt: { archivo: "Tomada del archivo" },
  teeth: { atencion: "De la atención", pieza: "La del filtro «Pieza»" },
}

const isOpenRow = (status: RowStatus | undefined) => status === "pending" || status === "error"

/** Lo que se escribe de cada archivo: los campos de su fila. */
interface RowValues {
  key: string
  title: string
  category: string
  /** Subtipo de imagen (radiografía o foto clínica). */
  imageType: string
  /** Día del documento, o de toma en una imagen (`yyyy-mm-dd`, en la zona de la clínica); vacío = el de subida. */
  capturedAt: string
  source: string
  teeth: number[]
  tags: string[]
  planItemId: string
  links: DocumentLinkValue
  /** Lo que se llenó solo (no se envía): marca su campo mientras nadie lo cambie. */
  filled: Partial<Record<FilledField, Filled>>
}

/** El archivo de una fila y cómo va su subida (no son datos que se escriban). */
interface RowFile {
  file: File
  previewUrl: string | null
  status: RowStatus
  /** Lo que la ficha dijo del archivo y no es de ningún campo de la fila. */
  error: string | null
  expanded: boolean
  /** El nombre es el de la cámara o la captura: el título lo arma la ficha mientras nadie lo cambie. */
  autoTitle: boolean
  /** Una radiografía intraoral sin decir cuál: el título dice «Radiografía intraoral». */
  intraoral: boolean
}

interface UploadValues {
  encounterId: string
  /** «Para todos»: lo que se elige aquí se copia a cada fila, y cada fila lo puede cambiar. */
  allCategory: string
  allCapturedAt: string
  rows: RowValues[]
}

const NO_LINKS: DocumentLinkValue = {
  budgetId: "",
  followUpId: "",
  prescriptionId: "",
  paymentId: "",
  encounterProcedureId: "",
}

const EMPTY_UPLOAD: UploadValues = { encounterId: "", allCategory: "", allCapturedAt: "", rows: [] }

/** Lo que dice la fila sin respuesta del servidor; su estado ya dice «Resultado no confirmado». */
const UNCONFIRMED_ROW =
  "No llegó la respuesta del servidor: puede que se haya guardado. Revisa la lista de Documentos antes de reenviar para no duplicar."

/** El archivo no se pudo leer del equipo al elegirlo: no se subió nada. */
const UNREADABLE_FILE =
  "No se pudo leer desde tu equipo: puede que haya cambiado o que esté solo en la nube. Ábrelo una vez o cópialo a otra carpeta y vuelve a elegirlo."

/**
 * Lo que se comprueba de cada fila antes de subirla: los mismos límites que
 * `POST /api/patients/:id/documents` (título 1–200, categoría, tipo de imagen
 * de esa categoría, fecha no futura, origen hasta 120).
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
    // El día se elige en la zona de la clínica, no en la del navegador. Vale para todo archivo.
    if (row.capturedAt && row.capturedAt > regionToday())
      ctx.addIssue({
        code: "custom",
        path: ["capturedAt"],
        message: `La ${documentDateLabel(row.category).toLowerCase()} no puede ser futura.`,
      })
    // Tipo y origen solo se piden (y se envían) en las categorías de imagen.
    if (imageTypesFor(row.category).length === 0) return
    if (!row.imageType)
      ctx.addIssue({ code: "custom", path: ["imageType"], message: "Elige el tipo de imagen." })
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

type RowOutcome =
  | { ok: true }
  /** Sin respuesta del servidor: su fila ya lo dice. */
  | { ok: false; unconfirmed: true }
  | { ok: false; unconfirmed?: never; message: string | null; fields: Record<string, string> }

export interface DocumentUploadDialogProps {
  patientId: string
  defaultEncounterId?: string
  /** Tratamiento ya en foco (p. ej. desde su recorrido): se propone en cada fila. */
  defaultPlanItemId?: string
  /**
   * La pieza en foco (el filtro «Pieza» de Documentos): se propone en cada fila y gana a
   * las de la atención, que se proponen sin ella.
   */
  initialTeeth?: number[]
  /** Lo que se sube ya se sabe qué es (la hoja firmada de un consentimiento): gana a lo que diga el archivo. */
  defaultCategory?: string
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

/** Solo borradores admiten vínculo directo al subir; lo cerrado se vincula por revisión auditada. */
function draftEncounters(encounters: Encounter[]): Encounter[] {
  return encounters.filter((e) => e.status === "borrador")
}

let rowSeq = 0

/** Por qué un archivo no entra a la cola, antes de leerlo; null si entra. */
function fileProblem(file: File): string | null {
  if (!isAcceptedFile(file)) return unsupportedFormatMessage(file.name)
  if (file.size === 0) return "El archivo está vacío."
  if (file.size > maxBytesFor(file))
    return maxBytesFor(file) > MAX_BYTES
      ? "La radiografía DICOM no puede superar 30 MB."
      : "El archivo no puede superar 10 MB (la radiografía DICOM, 30 MB)."
  return null
}

/**
 * Cómo se llama en el título lo que es el archivo, con lo elegido en su fila: su tipo, su
 * categoría o, sin ninguna, su formato.
 */
function titleWhat(row: RowValues, meta: Pick<RowFile, "file" | "intraoral">): string {
  if (row.imageType && imageTypesFor(row.category).includes(row.imageType))
    return imageTypeLabel(row.imageType) ?? row.imageType
  if (row.category === "radiografia" && meta.intraoral) return "Radiografía intraoral"
  if (row.category === "otro" || (!row.category && meta.file.type === "application/pdf")) return "Documento"
  return row.category ? categoryLabel(row.category) : "Imagen"
}

/** «Radiografía periapical · pieza 46 · 15 nov»: sin fecha propia, la de subida (hoy). */
function rowTitle(row: RowValues, meta: Pick<RowFile, "file" | "intraoral">): string {
  return composeTitle(
    titleWhat(row, meta),
    placesWords(row.teeth, productUi().site),
    shortDay(row.capturedAt || regionToday()),
  )
}

/** Lo que se llenó solo, sin la entrada del campo si ya no hay nada. */
function withFilled(
  filled: RowValues["filled"],
  field: FilledField,
  value: Filled | null,
): RowValues["filled"] {
  const { [field]: _gone, ...rest } = filled
  return value ? { ...rest, [field]: value } : rest
}

interface RowContext {
  hints: FileHints
  /** Las piezas que se proponen (las del filtro o las de la atención) y de dónde salen. */
  teeth: { values: readonly number[]; from: FilledFrom }
  defaultPlanItemId?: string
  defaultCategory?: string
  forAll: { category: string; capturedAt: string }
}

/**
 * La fila de un archivo, con lo que ya se sabe de él. La categoría que trae el archivo
 * (su modalidad o su nombre) gana a «Para todos», que es para los que no tienen una propia;
 * la que solo sale del formato (PDF) no. Lo que se sube para algo ya dicho (la hoja de un
 * consentimiento) gana a todo.
 */
function toRow(file: File, context: RowContext): { values: RowValues; meta: RowFile } {
  rowSeq += 1
  const { hints, teeth, forAll } = context
  const filled: RowValues["filled"] = {}
  let category = forAll.category
  if (context.defaultCategory) filled.category = { value: context.defaultCategory, from: "hoja" }
  else if (hints.category && hints.from && (hints.from !== "formato" || !forAll.category))
    filled.category = { value: hints.category, from: hints.from }
  if (filled.category) category = filled.category.value
  const imageType = category === hints.category && hints.imageType ? hints.imageType : ""
  if (imageType && hints.from) filled.imageType = { value: imageType, from: hints.from }
  const capturedAt = hints.takenOn ?? forAll.capturedAt
  if (hints.takenOn) filled.capturedAt = { value: hints.takenOn, from: "archivo" }
  if (teeth.values.length > 0) filled.teeth = { value: teeth.values.join(","), from: teeth.from }
  const meta: RowFile = {
    file,
    previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    status: "pending",
    error: null,
    expanded: false,
    autoTitle: isGenericFileName(file.name),
    intraoral: hints.intraoral,
  }
  const values: RowValues = {
    key: `${Date.now()}-${rowSeq}`,
    title: basenameWithoutExtension(file.name),
    category,
    imageType,
    capturedAt,
    source: "",
    teeth: [...teeth.values],
    tags: [],
    planItemId: context.defaultPlanItemId ?? "",
    links: { ...NO_LINKS },
    filled,
  }
  if (meta.autoTitle) {
    values.title = rowTitle(values, meta)
    filled.title = { value: values.title, from: "titulo" }
  }
  return { values, meta }
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
  defaultCategory,
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
  // Un producto que no guarda la tomografía lo dice antes de subir, sin cientos de cortes sueltos.
  const [studyNotStored, setStudyNotStored] = useState(false)
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
      // La fecha propia vale para todo archivo: la historia lo pone en ese día.
      const capturedAt = capturedInstant(row.capturedAt)
      if (capturedAt) body.append("capturedAt", capturedAt)
      const types = imageTypesFor(row.category)
      if (types.length > 0) {
        if (types.includes(row.imageType)) body.append("imageType", row.imageType)
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
      // Ya está guardado: que la lista tarde en refrescarse no lo vuelve dudoso.
      await onSuccess().catch(() => {})
      return { ok: true }
    } catch {
      // Fallo de red o respuesta ilegible: el archivo pudo haberse guardado.
      // No se reintenta a ciegas: se refresca el listado y la fila exige
      // decisión explícita (verificar en Documentos o reenviar).
      patchFile(row.key, { status: "unconfirmed", error: UNCONFIRMED_ROW })
      await onSuccess().catch(() => {})
      return { ok: false, unconfirmed: true }
    }
  }

  const form = useAppForm({
    defaultValues: {
      encounterId: defaultIsDraft ? (defaultEncounterId ?? "") : "",
      allCategory: "",
      allCapturedAt: "",
      rows: [],
    } as UploadValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        // Con filas y nada por subir no se llega aquí: el pie ya no ofrece subir.
        if (!value.rows.some((row) => targets.current.has(row.key)))
          fields.rows = "Elige los archivos que quieres subir."
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
          // Lo no confirmado lo dice su fila, una sola vez: no es «sin guardar».
          if (outcome.ok || outcome.unconfirmed) continue
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
    lastCommon.current = { category: "", capturedAt: "" }
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
    queryFn: () => apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${encounterChoice}`),
    enabled: open && encounterChoice !== "",
  })
  const attention = encounterChoice ? procedureQuery.data?.data : undefined
  const procedures = attention?.procedures ?? []
  // Las piezas que se proponen: la del filtro «Pieza», o las que la atención elegida trata o
  // examina. Nunca salen de la imagen.
  const focusTeeth = initialTeeth ?? []
  const suggestedTeeth: RowContext["teeth"] = !productUi().site
    ? { values: [], from: "atencion" }
    : focusTeeth.length > 0
      ? { values: focusTeeth, from: "pieza" }
      : { values: attention ? attentionTeeth(attention) : [], from: "atencion" }
  const teethKey = suggestedTeeth.values.join(",")
  const statusOf = (key: string) => files[key]?.status
  const pendingKeys = rows
    .filter((row) => isOpenRow(statusOf(row.key)))
    .map((row) => row.key)
  // Todo guardado o por verificar en su fila: no queda nada que subir y el pie no ofrece «Subir 0».
  const nothingLeft = !uploading && rows.length > 0 && pendingKeys.length === 0

  // Lo propuesto sigue a lo que cambia, en cada fila por subir, hasta que la persona lo toca. Se lee
  // la fila al día (no la de este render): las piezas cambian antes de armar el título.
  useEffect(() => {
    // Las piezas llegan con la atención (o cambian al elegir otra): las toma la fila que sigue con
    // las que se le propusieron, o sin ninguna.
    form.getFieldValue("rows").forEach((row, index) => {
      if (!isOpenRow(files[row.key]?.status)) return
      const current = row.teeth.join(",")
      const before = row.filled.teeth
      if (before ? current !== before.value : current !== "") return
      if (current === teethKey && (before?.from ?? suggestedTeeth.from) === suggestedTeeth.from) return
      form.setFieldValue(`rows[${index}].teeth`, [...suggestedTeeth.values])
      form.setFieldValue(
        `rows[${index}].filled`,
        withFilled(row.filled, "teeth", teethKey ? { value: teethKey, from: suggestedTeeth.from } : null),
      )
    })
    // El título armado sigue a lo elegido en la fila (tipo, fecha, piezas) hasta que la persona lo escribe.
    form.getFieldValue("rows").forEach((row, index) => {
      const meta = files[row.key]
      if (!meta?.autoTitle || !isOpenRow(meta.status) || row.filled.title?.value !== row.title) return
      const next = rowTitle(row, meta)
      if (next === row.title) return
      form.setFieldValue(`rows[${index}].title`, next)
      form.setFieldValue(`rows[${index}].filled`, withFilled(row.filled, "title", { value: next, from: "titulo" }))
    })
  })

  /** Lo último que se copió con «Para todos»: lo que una fila cambió a mano no se pisa. */
  const lastCommon = useRef({ category: "", capturedAt: "" })
  /**
   * «Para todos»: copia la categoría o la fecha a cada fila por subir que no tenga una
   * propia (vacía o la que se copió antes); la que se cambió a mano se respeta.
   */
  const applyToAll = (name: "category" | "capturedAt", value: string) => {
    const previous = lastCommon.current[name]
    lastCommon.current = { ...lastCommon.current, [name]: value }
    form.getFieldValue("rows").forEach((row, index) => {
      const status = statusOf(row.key)
      if (status !== "pending" && status !== "error") return
      if (row[name] !== "" && row[name] !== previous) return
      form.setFieldValue(`rows[${index}].${name}`, value)
      // Otro tipo de archivo: el tipo de imagen elegido deja de valer si no es de esa categoría.
      if (name === "category" && row.imageType && !imageTypesFor(value).includes(row.imageType))
        form.setFieldValue(`rows[${index}].imageType`, "")
      if (name === "category") askImageTypeNow(form as unknown as AnyFormApi, index, value)
    })
  }

  const addFiles = async (list: File[]) => {
    if (disabled || !list.length) return
    const bad: string[] = []
    const added: Record<string, RowFile> = {}
    // Lo elegido en «Para todos» vale también para los archivos que se agregan después.
    const forAll = { category: form.getFieldValue("allCategory"), capturedAt: form.getFieldValue("allCapturedAt") }
    // Se sube la copia leída ahora, no el archivo del disco (`readChosenFile`); se leen a la vez,
    // y de la copia sale lo que el archivo ya trae (su fecha, su tipo).
    const types = productUi().documents.imaging.types
    const today = regionToday()
    const read = await Promise.all(
      list.map(async (chosen) => {
        const problem = fileProblem(chosen)
        const file = problem ? null : await readChosenFile(chosen)
        return { chosen, problem, file, hints: file ? await readFileHints(file, types, today) : null }
      }),
    )
    for (const { chosen, problem, file, hints } of read) {
      if (!file || !hints) {
        bad.push(`${chosen.name}: ${problem ?? UNREADABLE_FILE}`)
        continue
      }
      const row = toRow(file, { hints, teeth: suggestedTeeth, defaultPlanItemId, defaultCategory, forAll })
      added[row.values.key] = row.meta
      form.pushFieldValue("rows", row.values)
    }
    if (Object.keys(added).length > 0) setFiles((prev) => ({ ...prev, ...added }))
    if (bad.length > 0) setRejected((prev) => [...prev, ...bad])
  }

  const select = async (selection: SelectedFile[]) => {
    if (!selection.length || disabled) return
    setNoStudy(false)
    setStudyNotStored(false)
    if (mayHoldStudy(selection, MAX_BYTES)) {
      const found = await tomography.scan(selection)
      const volume = found.studies.some((study) => study.isVolume)
      if (volume && storesTomography()) return
      tomography.reset()
      if (volume) {
        setStudyNotStored(true)
        await addFiles(
          selection
            .map((item) =>
              item.file instanceof File
                ? item.file
                : new File([item.file], item.name.split("/").at(-1) ?? item.name),
            )
            // Los cortes de la tomografía no entran sueltos: solo las imágenes y documentos que traiga.
            .filter(
              (file) =>
                isAcceptedFile(file) &&
                !/\.dcm$/i.test(file.name) &&
                file.type !== "application/dicom",
            ),
        )
        return
      }
      // Una carpeta o un ZIP sin tomografía: solo entran sus imágenes y documentos sueltos.
      const fromFolder = selection.some((item) => item.name.includes("/") || /[.]zip$/i.test(item.name))
      if (fromFolder) {
        setNoStudy(true)
        await addFiles(
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
    await addFiles(selection.map((item) => item.file as File))
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
  // El mismo motivo en varias filas (la conexión que se cortó para todas) se dice una sola vez.
  const sharedError = sharedRowError(rows.map((row) => files[row.key]?.error ?? null))

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
      description={`JPG, PNG, WebP, PDF o DICOM, máx. 10 MB por archivo y 30 MB la radiografía DICOM${storesTomography() ? "; la tomografía, hasta 1,5 GB" : ""}. El formato se verifica por contenido. Sin atención queda como General.`}
      onSubmit={(event) => {
        if (nothingLeft) {
          event.preventDefault()
          return
        }
        targets.current = new Set(pendingKeys)
        surface.onSubmit(event)
      }}
      isSubmitting={uploading}
      error={surface.error}
      // Solo por permiso: lo que falta en una fila se dice en su campo al subir.
      submitDisabled={disabled}
      submitLabel={uploading ? "Subiendo…" : pendingKeys.length > 0 ? `Subir ${pendingKeys.length}` : "Subir"}
      // Sin nada por subir, lo único que queda es cerrar: «Cerrar» es la «×» de arriba
      // (el pie no repite un botón que solo cierra) y no hay «Subir 0» ni «Cancelar».
      hideSubmit={nothingLeft}
      cancelLabel={nothingLeft ? common.actions.close : undefined}
    >
      {/* min-w-0: un fieldset mide lo que su contenido más ancho (la atención con su motivo largo) y a 390 px se salía de la ventana. */}
      <fieldset disabled={uploading || disabled} className="flex min-w-0 flex-col gap-3">
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
                    items={Object.fromEntries([
                      ["", GENERAL_WORDS],
                      ...drafts.map((e) => [e.id, encounterLabel(e)] as const),
                    ])}
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v ?? "")}
                  >
                    <SelectTrigger
                      id={control.id}
                      className="w-full"
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    >
                      <SelectValue placeholder={GENERAL_WORDS} />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Subir como general es elegirlo aquí, no un botón aparte. */}
                      <SelectItem value="">{GENERAL_WORDS}</SelectItem>
                      {drafts.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {encounterLabel(e)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                        hint={
                          storesTomography()
                            ? "Fotos, PDF, radiografías y tomografías. Hasta 10 MB por archivo, 30 MB la radiografía DICOM y 1,5 GB la tomografía."
                            : "Fotos, PDF y radiografías. Hasta 10 MB por archivo y 30 MB la radiografía DICOM."
                        }
                      />
                    </div>
                    {studyNotStored && (
                      <p role="status" className="text-xs text-muted-foreground">
                        La tomografía todavía no se guarda en la ficha: guarda el CD o pide al
                        centro el informe en PDF. Se agregan solo las imágenes y documentos sueltos
                        que traiga.
                      </p>
                    )}
                    {noStudy && (
                      <p className="text-xs text-muted-foreground">
                        No encontramos una tomografía en lo elegido: se agregan solo sus imágenes y documentos.
                      </p>
                    )}
                    {rejected.length > 0 && (
                      <ul role="alert" className="flex flex-col divide-y divide-destructive/15 rounded-xl border border-destructive/30 bg-destructive/5 px-3">
                        {rejected.map((message) => (
                          <li key={message} className="flex items-center gap-2 py-1.5 text-sm">
                            <span className="min-w-0 flex-1 text-destructive [overflow-wrap:anywhere]">{message}</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="min-h-11 sm:min-h-8"
                              aria-label={`Descartar el aviso: ${message}`}
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

              {pendingKeys.length > 1 && (
                <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl bg-muted/50 p-4">
                  <legend className="float-left text-sm font-medium">Para todos</legend>
                  <p className="clear-left text-sm text-muted-foreground">
                    Se copia a los archivos que no tienen una propia; después puedes cambiar la de cualquiera.
                    La fecha de un papel es la que tiene escrita; si abarca varios años, la de su última anotación.
                  </p>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
                    <form.AppField
                      name="allCategory"
                      listeners={{ onChange: ({ value }) => applyToAll("category", value) }}
                    >
                      {(field) => (
                        <field.SelectField
                          label="Categoría de todos"
                          placeholder="Elige la categoría"
                          options={UPLOAD_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                        />
                      )}
                    </form.AppField>
                    <form.AppField
                      name="allCapturedAt"
                      listeners={{ onChange: ({ value }) => applyToAll("capturedAt", value) }}
                    >
                      {(field) => (
                        <field.Control label="Fecha de todos">
                          {(control) => (
                            <DatePickerButton
                              {...control.props}
                              className="w-full"
                              value={field.state.value}
                              disabled={uploading}
                              min="1900-01-01"
                              max={regionToday()}
                              emptyLabel="La de subida"
                              onChange={(next) => field.handleChange(next)}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  </div>
                </fieldset>
              )}

              {sharedError ? (
                <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {sharedError}
                </p>
              ) : null}
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
                        several={pendingKeys.length > 1}
                        sharedError={sharedError}
                      />
                    ) : null
                  })}
                </ol>
              )}
            </>
          )}
        </form.AppField>
      </fieldset>
    </FormDrawer>
  )
}

/**
 * Lo que falta se pide de una vez: si ya se intentó subir y se elige una categoría que lleva tipo
 * de imagen (foto, radiografía), el tipo aparece ya marcado como lo que falta, en vez de enterarse
 * en otro envío. El aviso se va al elegirlo, como los demás.
 */
function askImageTypeNow(form: AnyFormApi, index: number, category: string) {
  if (form.state.submissionAttempts === 0 || imageTypesFor(category).length === 0) return
  // El campo aparece en el render siguiente: el aviso se pone cuando ya está.
  requestAnimationFrame(() => {
    if (form.getFieldValue(`rows[${index}].imageType`)) return
    addSubmitErrors(form, { [`rows[${index}].imageType`]: "Elige el tipo de imagen." })
  })
}

/** El motivo que comparten dos o más filas que fallaron, para decirlo una sola vez; si difieren, ninguno. */
export function sharedRowError(errors: ReadonlyArray<string | null>): string | null {
  const failed = errors.filter((error): error is string => Boolean(error))
  return failed.length > 1 && failed.every((error) => error === failed[0]) ? (failed[0] ?? null) : null
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
  /** Varios archivos: la ayuda de la fecha va una vez, en «Para todos», no en cada fila. */
  several: boolean
  /** El motivo que comparten varias filas: va una vez, arriba, y la fila no lo repite. */
  sharedError: string | null
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
    several,
    sharedError,
  }) {
    const id = useId()
    const row = useStore(form.store, (state) => state.values.rows[index])
    // El calendario de una fila abre en la fecha de «Para todos», no en el mes de hoy.
    const commonDate = useStore(form.store, (state) => state.values.allCapturedAt)
    if (!row) return null
    const name = meta.file.name
    const forFile = <span className="sr-only"> de {name}</span>
    const types = imageTypesFor(row.category)
    // Una foto o un DICOM sin categoría todavía ya es una toma: su fecha no es «la del documento».
    const image = types.length > 0 || (!row.category && (meta.previewUrl !== null || isDicomFile(meta.file)))
    const removable = meta.status === "pending" || meta.status === "error" || meta.status === "unconfirmed"
    const at = `rows[${index}]` as const
    /** «Tomada del archivo», «De la atención»…: mientras el campo siga con lo que se llenó solo. */
    const note = (field: FilledField): string | undefined => {
      const filled = row.filled[field]
      const value = field === "teeth" ? row.teeth.join(",") : row[field]
      return filled && value === filled.value ? FILLED_WORDS[field][filled.from] : undefined
    }
    const withExtras =
      row.teeth.length > 0 ||
      row.planItemId ||
      Object.values(row.links).some(Boolean) ||
      row.tags.length > 0
    return (
      <li
        className={cn(
          "flex flex-col gap-3 rounded-xl border p-3",
          (meta.status === "error" || meta.status === "unconfirmed") && "border-destructive/30",
        )}
      >
        <Attachment
          state={
            meta.status === "uploading"
              ? "uploading"
              : meta.status === "error" || meta.status === "unconfirmed"
                ? "error"
                : "done"
          }
          orientation="horizontal"
          className="w-full border-0 bg-transparent px-0"
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
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              <form.AppField name={`${at}.title`}>
                {(field) => (
                  <field.TextField
                    id={`${id}-title`}
                    label={<>Título{forFile}</>}
                    description={note("title")}
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
                    askImageTypeNow(form as unknown as AnyFormApi, index, value)
                  },
                }}
              >
                {(field) => (
                  <field.SelectField
                    id={`${id}-category`}
                    label={<>Categoría{forFile}</>}
                    description={note("category")}
                    placeholder="Elige la categoría"
                    options={UPLOAD_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                  />
                )}
              </form.AppField>
            </div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              {types.length > 0 && (
                <form.AppField name={`${at}.imageType`}>
                  {(field) => (
                    <field.SelectField
                      id={`${id}-type`}
                      label={<>Tipo de imagen{forFile}</>}
                      description={note("imageType")}
                      placeholder="Elige el tipo"
                      options={types.map((t) => ({ value: t, label: imageTypeLabel(t) ?? t }))}
                    />
                  )}
                </form.AppField>
              )}
              <form.AppField name={`${at}.capturedAt`}>
                {(field) => (
                  <field.Control
                    id={`${id}-taken`}
                    label={
                      <>
                        {documentDateLabel(row.category, image)}
                        {forFile}
                      </>
                    }
                    description={
                      note("capturedAt") ??
                      (image || several
                        ? "Si queda vacía se usa la fecha de subida."
                        : "La que tiene el papel; si abarca varios años, la de su última anotación. Vacía, vale la de subida.")
                    }
                  >
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        className="w-full"
                        value={field.state.value}
                        disabled={busy}
                        openAt={commonDate || undefined}
                        min="1900-01-01"
                        max={regionToday()}
                        emptyLabel="La de subida"
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>

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
                      <field.Group
                        id={`${id}-teeth`}
                        legend={`${productUi().site?.placesLabel} (opcional)`}
                        description={note("teeth")}
                      >
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
              <div className="flex flex-wrap items-center justify-end gap-2">
                {meta.error !== sharedError ? (
                  <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
                    {meta.error}
                  </p>
                ) : null}
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
