import { FDI_ADULT, FDI_CHILD, SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/clinical"
import {
  Badge,
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  DataRefreshMarker,
  DetailDrawer,
  EmptyState,
  LoadingState,
  SearchInput,
  useListSearch,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouter } from "@tanstack/react-router"
import {
  ChevronDown,
  ClipboardList,
  FileStack,
  FileText,
  Image as ImageIcon,
  ListChecks,
  type LucideIcon,
  Pill,
  Signature,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import {
  type ClinicalOrder,
  CONSENT_STATUS_LABELS,
  type ConsentDocument,
  type FormResponse,
  fetchConsents,
  fetchFormResponses,
  fetchFormTemplates,
  fetchOrders,
  ORDER_KIND_TITLES,
  ORDER_STATUS_LABELS,
} from "../../lib/clinical-forms"
import {
  fetchPrescriptions,
  fetchResponsibilities,
  formatDate,
  type Prescription,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  countWords,
  fileFilter,
  filesShownElsewhere,
  groupByMonth,
  isImageCategory,
  matchesSearch,
  teethWords,
  visibleDocumentFilters,
} from "../../lib/document-list"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { fetchSignedOdontograms } from "../../lib/odontogram"
import { useClinicalProfile } from "../../lib/org"
import { DOCUMENT_FILTERS, type DocumentFilter } from "../../lib/patient-areas"
import {
  ageFrom,
  type Encounter,
  type PatientDocument,
  type PatientFull,
  type PlanItem,
} from "../../lib/patients"
import { PrescriptionEntry, RecetasPanel } from "./clinical-panels"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import { ConsentSigningScreen } from "./consent-signing"
import { ConsentDetail, NewConsentDrawer } from "./consentimientos-tab"
import { categoryLabel, formatTakenAt, imageTypeLabel, takenAt } from "./document-labels"
import { DocumentUploadDialog } from "./document-upload-dialog"
import {
  DocumentViewerHost,
  isImageDoc,
  usePatientEncounters,
  useSignedUrl,
} from "./document-viewer"
import type { NewDocumentKind } from "./encounter-documents"
import { NewResponseDrawer, ResponseDetail } from "./formularios-tab"
import { NewOrderDrawer, OrderResultDrawer, OrderRow } from "./ordenes-tab"
import { imagingFacts, useImagingState } from "./tomography-detail"

type Kind = "archivo" | "receta" | "orden" | "formulario" | "consentimiento" | "odontograma"
type Tone = "success" | "warning" | "outline" | "secondary"

/** El filtro de tipo de cada papel; el de un archivo depende de qué es (`fileFilter`). */
const FILTER_OF_KIND: Record<Exclude<Kind, "archivo">, DocumentFilter> = {
  receta: "recetas",
  orden: "ordenes",
  formulario: "formularios",
  consentimiento: "consentimientos",
  odontograma: "odontogramas",
}

/** El icono de cada clase de papel, en el lugar de la miniatura de una imagen. */
const ICON_OF_KIND: Record<Exclude<Kind, "archivo">, LucideIcon> = {
  receta: Pill,
  orden: ClipboardList,
  formulario: ListChecks,
  consentimiento: Signature,
  odontograma: FileText,
}

/** «Nuevo ▾»: abre directo el formulario de creación de cada papel. */
const NEW_OPTIONS: Array<{ kind: NewDocumentKind; label: string }> = [
  { kind: "receta", label: "Receta" },
  { kind: "consentimiento", label: "Consentimiento" },
  { kind: "orden", label: "Orden" },
  { kind: "formulario", label: "Formulario" },
  { kind: "archivo", label: "Imagen o archivo" },
]

/** La acción de una fila: la única que se ofrece a la vista. */
type RowAction =
  | { type: "firmar"; consent: ConsentDocument }
  | { type: "resultado"; order: ClinicalOrder }
  | { type: "imprimir"; prescriptionId: string }
  | { type: "imprimir-odontograma"; assessmentId: string }
  | { type: "completar" }
  | { type: "ver" }

interface Row {
  key: string
  kind: Kind
  /** El filtro de tipo que lo muestra. */
  filter: DocumentFilter
  /** Sus piezas: las de la imagen o las del tratamiento al que pertenece. */
  teeth: number[]
  /** Un archivo retirado: no sale en la lista, sino en «Ver retirados». */
  retired: boolean
  title: string
  /** La segunda línea completa: fecha y lo que dice del papel. */
  detail: string
  /** La fecha que ordena la lista; en una imagen, la de toma (decisión 5). */
  date: string
  status: { label: string; tone: Tone } | null
  /** Queda algo por hacer sobre el papel (firmar, completar, recibir resultado). */
  needsAction: boolean
  action: RowAction
  /** Lo que se abre al lado. */
  open:
    | { kind: "consentimiento"; consent: ConsentDocument }
    | { kind: "orden"; order: ClinicalOrder }
    | { kind: "receta"; prescription: Prescription }
    | { kind: "formulario"; response: FormResponse }
    | { kind: "archivo"; document: PatientDocument }
    | { kind: "odontograma"; assessmentId: string }
}

/** «Octubre de 2026», en el idioma y la zona de la clínica. */
function monthHeading(iso: string): string {
  const text = new Date(iso).toLocaleDateString(activeOrgLocale(), {
    month: "long",
    year: "numeric",
    timeZone: activeOrgTimeZone(),
  })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** La segunda línea de una imagen o archivo: tipo, toma, forma, piezas, atención y origen. */
function fileDetail(doc: PatientDocument, encounter: Encounter | undefined): string {
  const today = formatDate(new Date().toISOString())
  const encounterDay = encounter ? formatDate(encounter.createdAt) : null
  return [
    imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category),
    formatTakenAt(doc),
    doc.imaging?.completedAt ? imagingFacts(doc.imaging) : null,
    teethWords(doc.toothNumbers),
    doc.encounterId
      ? encounterDay === today
        ? "Atención de hoy"
        : encounterDay
          ? `Atención del ${encounterDay}`
          : "De una atención"
      : null,
    // El origen no se repite cuando ya está en el nombre.
    doc.source && !doc.label.toLowerCase().includes(doc.source.toLowerCase()) ? doc.source : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Clínica › Documentos, «buscar un papel» (ADR 0035 y lienzo del issue 149):
 * una sola lista de lo que la atención emite o adjunta, separada por mes, con
 * un buscador para todos los papeles y el filtro «Pieza» de Historia. Los
 * filtros por tipo («Todo» primero, como en Historia) acortan la misma lista y
 * solo aparecen si filtran algo; las imágenes son una fila más, con su tipo,
 * su fecha de toma y su miniatura, y se abren de una vez en su visor. «Nuevo ▾»
 * abre directo el formulario y cada fila lleva su única acción. Lo retirado se
 * consulta al pie. Todo vive en la dirección (`tipo`, `q`, `tooth`, `estado`,
 * `documentId`).
 */
export function DocumentosSection({
  patientId,
  filter: requestedFilter,
  encounterId,
  tooth,
  documentId,
}: {
  patientId: string
  filter?: DocumentFilter
  /** La atención en curso: lo que se crea aquí queda unido a ella. */
  encounterId?: string
  /** La pieza del filtro «Pieza» (`?tooth=`). */
  tooth?: number
  /** El archivo abierto en el visor (`?documentId=`). */
  documentId?: string
}) {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const router = useRouter()
  const canWrite = usePermission("clinical.write")
  // El odontograma firmado es de las clínicas de Perú (NTS 188; ADR 0036).
  const signsOdontogram = useClinicalProfile().odontogram?.signedOdontogram === true
  // Fuera de Perú no hay filtro «Odontogramas»: un enlace con él abre todo.
  const filter =
    requestedFilter === "odontogramas" && !signsOdontogram ? undefined : requestedFilter
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState<Exclude<NewDocumentKind, "archivo"> | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [opened, setOpened] = useState<Row["open"] | null>(null)
  const [signing, setSigning] = useState<ConsentDocument[] | null>(null)
  const [resultFor, setResultFor] = useState<ClinicalOrder | null>(null)
  // El control que abrió el visor recupera el foco al cerrarlo.
  const openerRef = useRef<HTMLElement | null>(null)
  const activeChipRef = useRef<HTMLButtonElement | null>(null)

  // Con los retirados: no salen en la lista, pero el pie dice cuántos hay.
  const files = useQuery({
    queryKey: ["patient-documents", patientId, "con-retirados"],
    queryFn: () =>
      apiFetch<{ data: PatientDocument[] }>(
        `/api/patients/${patientId}/documents?includeRetired=true`,
      ),
  })
  const prescriptions = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
  })
  const orders = useQuery({
    queryKey: ["clinical-orders", patientId, "indice"],
    queryFn: () => fetchOrders({ patientId }),
  })
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
  })
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
  })
  const odontograms = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () => fetchSignedOdontograms(patientId),
    enabled: signsOdontogram,
  })
  // Quién firma un consentimiento pendiente: la persona o, si es menor, su
  // representante legal. Son las mismas consultas que ya hizo la página.
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  const responsibilities = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
  })
  // Los tratamientos: la receta los ofrece y el visor y la subida los nombran.
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  })
  // Las atenciones: la fila dice de cuál es una imagen y la subida las ofrece.
  const encounters = usePatientEncounters(patientId)
  const templates = useQuery({
    queryKey: ["form-templates-published", encounterId ? "mine-first" : "all"],
    queryFn: () =>
      fetchFormTemplates({ status: "publicado", ...(encounterId ? { forUser: "me" } : {}) }),
    enabled: creating === "formulario",
  })

  const refresh = async () => {
    await Promise.all(
      [
        ["patient-documents", patientId],
        ["patient-document-context", patientId],
        ["prescriptions", patientId],
        ["clinical-orders", patientId],
        ["form-responses", patientId],
        ["consents", patientId],
        ["odontogram-assessments", patientId],
        ["patient-summary", patientId],
        ["timeline", patientId],
        ["encounter", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
  }

  const query = listSearch.get("q") ?? ""
  const showRetired = listSearch.get("estado") === "retirados"
  const setFilter = (next: DocumentFilter | undefined) =>
    listSearch.setParams({ tipo: next, documentId: undefined })
  const clearFilters = () =>
    listSearch.setParams({
      tipo: undefined,
      q: undefined,
      tooth: undefined,
      estado: undefined,
      documentId: undefined,
    })
  const setRetired = (retired: boolean) =>
    listSearch.setParams({ estado: retired ? "retirados" : undefined, documentId: undefined })

  // Abrir el visor agrega una entrada al historial: cerrarlo es volver atrás,
  // y «Atrás» del navegador también lo cierra.
  const pushedRef = useRef(false)
  const closingRef = useRef(false)
  const openDocument = (id: string) => {
    if (document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement
    pushedRef.current = true
    listSearch.setParams({ documentId: id })
  }
  const closeDocument = () => {
    // El diálogo puede avisar el cierre más de una vez: se cierra una sola.
    if (!documentId || closingRef.current) return
    closingRef.current = true
    if (pushedRef.current) {
      pushedRef.current = false
      router.history.back()
    } else listSearch.setParams({ documentId: undefined }, { replace: true })
  }
  // Al cerrarse el visor (con su botón, Esc o «Atrás»), el foco vuelve a la fila.
  const hadDocument = useRef(Boolean(documentId))
  useEffect(() => {
    closingRef.current = false
    if (hadDocument.current && !documentId) {
      pushedRef.current = false
      window.setTimeout(() => openerRef.current?.focus(), 0)
    }
    hadDocument.current = Boolean(documentId)
  }, [documentId])

  const startNew = (kind: NewDocumentKind) => {
    setMenuOpen(false)
    // La imagen o el archivo se suben encima de la lista, sin cambiar el filtro.
    if (kind === "archivo") setUploadOpen(true)
    else setCreating(kind)
  }

  const newMenu = canWrite ? (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="sm">
            Nuevo <ChevronDown aria-hidden className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {NEW_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.kind} onClick={() => startNew(option.kind)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const sources = [
    { name: "imágenes y archivos", query: files },
    { name: "recetas", query: prescriptions },
    { name: "órdenes", query: orders },
    { name: "formularios", query: forms },
    { name: "consentimientos", query: consents },
    ...(signsOdontogram ? [{ name: "odontogramas", query: odontograms }] : []),
  ]
  const allPending = sources.every((source) => source.query.isPending)
  const failed = sources.filter((source) => source.query.isError)
  const loading = sources.some((source) => source.query.isPending)

  const allFiles = files.data?.data ?? []
  const encounterById = useMemo(
    () => new Map((encounters.data ?? []).map((e) => [e.id, e])),
    [encounters.data],
  )
  const tagSuggestions = useMemo(
    () => [...new Set(allFiles.flatMap((d) => d.tags))].sort((a, b) => a.localeCompare(b, "es")),
    [allFiles],
  )

  // Las piezas de un papel unido a un tratamiento: «Pieza 36» encuentra el
  // consentimiento y la receta de la endodoncia de la 36.
  const planById = useMemo(
    () => new Map((planItems.data?.data ?? []).map((item) => [item.id, item])),
    [planItems.data],
  )
  const teethOf = (planItemId: string | null): number[] => {
    const toothNumber = planItemId ? planById.get(planItemId)?.toothNumber : null
    return toothNumber != null ? [toothNumber] : []
  }

  // Cada papel sale una vez (decisión 11): el PDF firmado y la hoja de un
  // consentimiento viven en su consentimiento, y el informe de una orden, en su orden.
  const shownElsewhere = filesShownElsewhere(
    consents.data?.data ?? [],
    orders.data?.data ?? [],
    allFiles,
  )
  // Mientras no se sabe qué vive en un consentimiento o en una orden, esos
  // archivos no salen sueltos: así no aparecen y desaparecen.
  const settledFile = (doc: PatientDocument) =>
    isImageCategory(doc.category) ||
    (doc.category === "consentimiento" ? consents.isSuccess : orders.isSuccess)
  const pendingSigner = signerWords(patient.data?.data, responsibilities.data?.data)
  const rows: Row[] = [
    ...allFiles
      .filter((doc) => settledFile(doc) && !shownElsewhere.has(doc.id))
      .map((doc): Row => {
        const detail = fileDetail(
          doc,
          doc.encounterId ? encounterById.get(doc.encounterId) : undefined,
        )
        return {
          key: `archivo-${doc.id}`,
          kind: "archivo",
          filter: fileFilter(doc.category),
          teeth: doc.toothNumbers,
          retired: Boolean(doc.retiredAt),
          title: doc.label,
          detail: doc.retiredAt
            ? [
                `Retirado el ${formatDate(doc.retiredAt)}`,
                doc.retireReason ? `Motivo: ${doc.retireReason}` : null,
                detail,
              ]
                .filter(Boolean)
                .join(" · ")
            : detail,
          date: takenAt(doc),
          // Toda radiografía nace sin informar: se dice, pero no cuenta como
          // pendiente (decisión 9); el informe va en la evolución o en la orden.
          status: doc.retiredAt
            ? { label: "Retirado", tone: "outline" }
            : doc.reportStatus === "pendiente"
              ? { label: "Sin informar", tone: "warning" }
              : null,
          needsAction: false,
          action: { type: "ver" },
          open: { kind: "archivo", document: doc },
        }
      }),
    ...(prescriptions.data?.data ?? []).map(
      (item): Row => ({
        key: `receta-${item.id}`,
        kind: "receta",
        filter: FILTER_OF_KIND.receta,
        teeth: teethOf(item.planItemId),
        retired: false,
        title: `Receta N.º ${item.prescriptionNumber}`,
        detail: `${formatDate(item.issuedAt)} · ${item.status === "anulada" ? (item.cancelReason ?? "Anulada") : "Emitida"}`,
        date: item.issuedAt,
        status:
          item.status === "anulada"
            ? { label: "Anulada", tone: "outline" }
            : { label: "Vigente", tone: "success" },
        needsAction: false,
        action:
          item.status === "anulada"
            ? { type: "ver" }
            : { type: "imprimir", prescriptionId: item.id },
        open: { kind: "receta", prescription: item },
      }),
    ),
    ...(orders.data?.data ?? []).map((order): Row => {
      const open = order.status === "solicitado" || order.status === "en_proceso"
      return {
        key: `orden-${order.id}`,
        kind: "orden",
        filter: FILTER_OF_KIND.orden,
        teeth: [],
        retired: false,
        title: `${ORDER_KIND_TITLES[order.kind]} · ${order.title}`,
        detail: `${formatDate(order.createdAt)} · ${
          order.status === "solicitado" ? "Pedida · sin resultado" : `Para ${order.recipient}`
        }`,
        date: order.createdAt,
        status: {
          label: ORDER_STATUS_LABELS[order.status],
          tone:
            order.status === "completado"
              ? "success"
              : order.status === "cancelado"
                ? "outline"
                : "warning",
        },
        needsAction: open,
        action: open && canWrite ? { type: "resultado", order } : { type: "ver" },
        open: { kind: "orden", order },
      }
    }),
    ...(forms.data?.data ?? [])
      .filter((response) => response.status !== "descartado")
      .map((response): Row => {
        const date = response.finalizedAt ?? response.createdAt
        return {
          key: `formulario-${response.id}`,
          kind: "formulario",
          filter: FILTER_OF_KIND.formulario,
          teeth: [],
          retired: false,
          title: `Formulario · ${response.templateTitle ?? "Formulario clínico"}`,
          detail: `${formatDate(date)} · ${
            response.status === "finalizado"
              ? "Finalizado"
              : response.submittedAt
                ? "Lo declaró la persona · por revisar"
                : "Sin finalizar"
          }`,
          date,
          status:
            response.status === "finalizado"
              ? { label: "Finalizado", tone: "success" }
              : { label: "Borrador", tone: "warning" },
          needsAction: response.status === "borrador",
          action:
            response.status === "borrador" && canWrite ? { type: "completar" } : { type: "ver" },
          open: { kind: "formulario", response },
        }
      }),
    ...(consents.data?.data ?? []).map((consent): Row => {
      const date = consent.signedAt ?? consent.createdAt
      return {
        key: `consentimiento-${consent.id}`,
        kind: "consentimiento",
        filter: FILTER_OF_KIND.consentimiento,
        teeth: teethOf(consent.planItemId),
        retired: false,
        title: `Consentimiento · ${consent.titleSnapshot}`,
        detail: `${formatDate(date)} · ${
          consent.status === "pendiente"
            ? (consentLinkWords(consent) ??
              (pendingSigner ? `Falta la firma de ${pendingSigner}` : "Falta la firma"))
            : `Firma: ${consent.signerName}`
        }`,
        date,
        status: {
          label: CONSENT_STATUS_LABELS[consent.status],
          tone:
            consent.status === "firmado"
              ? "success"
              : consent.status === "pendiente"
                ? "warning"
                : "outline",
        },
        needsAction: consent.status === "pendiente",
        action:
          consent.status === "pendiente" && canWrite
            ? { type: "firmar", consent }
            : { type: "ver" },
        open: { kind: "consentimiento", consent },
      }
    }),
    // El odontograma firmado: se ve e imprime con el gráfico de la norma.
    ...(signsOdontogram ? (odontograms.data?.data ?? []) : []).map(
      (item): Row => ({
        key: `odontograma-${item.id}`,
        kind: "odontograma",
        filter: FILTER_OF_KIND.odontograma,
        teeth: [],
        retired: false,
        title: `Odontograma firmado · ${SIGNED_ODONTOGRAM_PURPOSE_LABELS[item.purpose]}`,
        detail: `${formatDate(item.createdAt)} · ${item.examinerName} · ${item.registrationNumber}`,
        date: item.createdAt,
        status: null,
        needsAction: false,
        action: { type: "imprimir-odontograma", assessmentId: item.id },
        open: { kind: "odontograma", assessmentId: item.id },
      }),
    ),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const current = rows.filter((row) => !row.retired)
  const retiredCount = rows.length - current.length
  const pendingCount = current.filter((row) => row.needsAction).length
  // Un solo buscador para todos los papeles (decisión 2) y la pieza de Historia
  // (decisión 7), sumados al filtro de tipo. Lo retirado se ve aparte.
  const visible = showRetired
    ? rows.filter((row) => row.retired)
    : current.filter(
        (row) =>
          (!filter || (filter === "requieren" ? row.needsAction : row.filter === filter)) &&
          (tooth == null || row.teeth.includes(tooth)) &&
          matchesSearch(
            [
              row.title,
              row.detail,
              row.status?.label,
              ...(row.open.kind === "archivo" ? row.open.document.tags : []),
            ]
              .filter(Boolean)
              .join(" "),
            query,
          ),
      )
  const groups = groupByMonth(visible, (row) => row.date, monthHeading)
  // «Anterior» y «Siguiente» del visor recorren los archivos a la vista.
  // La tomografía completa abre su propio visor: no entra en el recorrido.
  const sequence = visible.flatMap((row) =>
    row.open.kind === "archivo" && !row.open.document.imaging?.completedAt
      ? [row.open.document]
      : [],
  )
  const viewing = documentId ? allFiles.find((doc) => doc.id === documentId) : undefined

  const actionButton = (row: Row) => {
    const { action } = row
    switch (action.type) {
      case "firmar":
        // Firmado desde «Su enlace»: solo falta que el profesional lo confirme.
        if (action.consent.personSignedAt)
          return (
            <ConsentLinkActions
              document={action.consent}
              onChanged={() => void consents.refetch()}
            />
          )
        return (
          <Button
            type="button"
            size="sm"
            aria-label={`Firmar ${row.title}`}
            onClick={() => setSigning([action.consent])}
          >
            Firmar
          </Button>
        )
      case "resultado":
        return (
          <Button
            type="button"
            size="sm"
            aria-label={`Subir resultado de ${row.title}`}
            onClick={() => setResultFor(action.order)}
          >
            Subir resultado
          </Button>
        )
      case "imprimir":
        return (
          <Link
            to="/patients/$patientId/prescriptions/$prescriptionId/print"
            params={{ patientId, prescriptionId: action.prescriptionId }}
            target="_blank"
            aria-label={`Imprimir ${row.title}`}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir
          </Link>
        )
      case "imprimir-odontograma":
        return (
          <Link
            to="/patients/$patientId/odontogram/$assessmentId/print"
            params={{ patientId, assessmentId: action.assessmentId }}
            target="_blank"
            aria-label={`Imprimir ${row.title}`}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir
          </Link>
        )
      case "completar":
        return (
          <Button
            type="button"
            size="sm"
            aria-label={`Completar ${row.title}`}
            onClick={() => setOpened(row.open)}
          >
            Completar
          </Button>
        )
      case "ver":
        return (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Ver ${row.title}`}
            onClick={() =>
              row.open.kind === "archivo" ? openDocument(row.open.document.id) : setOpened(row.open)
            }
          >
            Ver
          </Button>
        )
    }
  }

  // Solo los filtros que filtran algo (decisión 8); sin ninguno, tampoco «Todo».
  const chipIds = visibleDocumentFilters(
    DOCUMENT_FILTERS.filter((option) => option.id !== "odontogramas" || signsOdontogram).map(
      (option) => option.id,
    ),
    new Set(current.map((row) => row.filter)),
    pendingCount,
    current.length,
    filter,
  )
  const chipOptions = DOCUMENT_FILTERS.filter((option) => chipIds.includes(option.id))
  // En el teléfono la fila de filtros se desliza: el filtro puesto queda a la
  // vista. Solo se mueve la fila, nunca la página.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se recoloca al cambiar el filtro o al llegar los papeles.
  useEffect(() => {
    const chip = activeChipRef.current
    const row = chip?.parentElement
    if (!chip || !row || row.scrollWidth <= row.clientWidth) return
    row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2
  }, [filter, chipOptions.length])
  const filterName = (id: DocumentFilter) =>
    id === "requieren"
      ? "lo que requiere acción"
      : (DOCUMENT_FILTERS.find((option) => option.id === id)?.label ?? id)
  // Sin resultados se dice qué filtros están puestos: nunca hay uno que no se vea.
  const noResults = [
    query ? `Buscaste «${query}»` : "No hay papeles",
    filter ? `en ${filterName(filter)}` : null,
    tooth != null ? `de la pieza ${tooth}` : null,
  ]
    .filter(Boolean)
    .join(" ")
  const narrowed = Boolean(query) || tooth != null
  const chips =
    chipOptions.length === 0 ? null : (
      <fieldset className="m-0 max-w-full min-w-0 border-0 p-0">
        <legend className="sr-only">Filtrar documentos</legend>
        <div className="relative flex gap-2 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden">
          {/* «Todo» va primero y, en el teléfono, queda fijo mientras la fila se desliza. */}
          <Button
            ref={!filter ? activeChipRef : undefined}
            type="button"
            size="sm"
            variant={!filter ? "default" : "outline"}
            aria-pressed={!filter}
            className="sticky left-0 z-10 shrink-0 max-sm:shadow-[6px_0_8px_-6px_rgb(0_0_0/0.35)] sm:static"
            onClick={() => setFilter(undefined)}
          >
            Todo
          </Button>
          {chipOptions.map((option) => {
            const active = filter === option.id
            return (
              <Button
                key={option.id}
                ref={active ? activeChipRef : undefined}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                className="shrink-0"
                onClick={() => setFilter(active ? undefined : option.id)}
              >
                {option.id === "requieren" ? `${option.label} · ${pendingCount}` : option.label}
              </Button>
            )
          })}
        </div>
      </fieldset>
    )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {showRetired ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3 text-sm"
        >
          <span>Retirados: no se borran. Quedan con la fecha y el motivo de su retiro.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setRetired(false)}>
            Volver a la lista
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {current.length > 0 || narrowed || filter ? (
              <>
                <SearchInput placeholder="Buscar un papel" className="min-w-0 flex-1 basis-56" />
                <ToothFilter
                  value={tooth}
                  onChange={(next) =>
                    listSearch.setParams({
                      tooth: next != null ? String(next) : undefined,
                      documentId: undefined,
                    })
                  }
                />
              </>
            ) : null}
            <div className="ml-auto">{newMenu}</div>
          </div>
          {chips}
          {current.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <p aria-live="polite" className="tabular-nums">
                {countWords(visible.length, filter, tooth)}
              </p>
              {narrowed ? (
                <Button type="button" size="sm" variant="link" onClick={clearFilters}>
                  Quitar filtros
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {allPending ? (
        <LoadingState message="Cargando documentos…" />
      ) : (
        <>
          {failed.length > 0 ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm"
            >
              <span>
                No se pudieron cargar: {failed.map((source) => source.name).join(", ")}. La lista
                está incompleta.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  for (const source of failed) void source.query.refetch()
                }}
              >
                Reintentar
              </Button>
            </div>
          ) : null}

          {current.length === 0 && !showRetired && !loading && failed.length === 0 ? (
            <EmptyState
              icon={FileStack}
              title="Todavía no tiene documentos"
              description="Recetas, órdenes, consentimientos, formularios e imágenes de esta persona."
              actionLabel={canWrite ? "Nuevo" : undefined}
              onAction={canWrite ? () => setMenuOpen(true) : undefined}
            />
          ) : visible.length === 0 && !loading ? (
            <EmptyState
              icon={FileStack}
              title="Ningún papel coincide"
              description={`${noResults}.`}
              actionLabel="Quitar filtros"
              onAction={clearFilters}
            />
          ) : (
            <div className="elevated rounded-xl border bg-card px-4 sm:px-6">
              <h2 className="sr-only">Documentos</h2>
              {groups.map((group) => (
                <section key={group.heading} aria-label={group.heading}>
                  <h3 className="pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.heading}
                  </h3>
                  <ul className="flex flex-col divide-y">
                    {group.items.map((row) =>
                      row.open.kind === "archivo" ? (
                        <FileRow
                          key={row.key}
                          patientId={patientId}
                          row={row}
                          doc={row.open.document}
                          canWrite={canWrite}
                          onOpen={() =>
                            row.open.kind === "archivo" && openDocument(row.open.document.id)
                          }
                        />
                      ) : (
                        <RowShell
                          key={row.key}
                          media={
                            <KindIcon icon={ICON_OF_KIND[row.kind as Exclude<Kind, "archivo">]} />
                          }
                          title={row.title}
                          detail={row.detail}
                          // El odontograma firmado se ve con su hoja: «Imprimir».
                          onOpen={
                            row.open.kind === "odontograma" ? undefined : () => setOpened(row.open)
                          }
                          status={row.status}
                          action={actionButton(row)}
                        />
                      ),
                    )}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {loading ? <DataRefreshMarker message="Cargando el resto de los papeles…" /> : null}
          {retiredCount > 0 && !showRetired ? (
            <div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRetired(true)}>
                {retiredCount === 1 ? "Ver 1 retirado" : `Ver ${retiredCount} retirados`}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <OpenedDocument
        patientId={patientId}
        opened={opened}
        canWrite={canWrite}
        onClose={() => setOpened(null)}
        onChanged={refresh}
      />

      {viewing ? (
        <DocumentViewerHost
          patientId={patientId}
          doc={viewing}
          sequence={sequence}
          allDocs={allFiles}
          encounters={encounters.data ?? []}
          planItems={planItems.data?.data ?? []}
          tagSuggestions={tagSuggestions}
          canWrite={canWrite}
          onNavigate={(id) => listSearch.setParams({ documentId: id }, { replace: true })}
          onClose={closeDocument}
          onChanged={refresh}
        />
      ) : null}

      <DocumentUploadDialog
        patientId={patientId}
        defaultEncounterId={encounterId}
        initialTeeth={tooth != null ? [tooth] : undefined}
        encounters={encounters.data ?? []}
        planItems={planItems.data?.data ?? []}
        suggestions={tagSuggestions}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={refresh}
        onOpenDocument={openDocument}
      />

      {/* Lo que se crea desde «Nuevo», unido a la atención en curso si la hay. */}
      {creating === "receta" ? (
        <RecetasPanel
          patientId={patientId}
          encounterId={encounterId}
          items={planItems.data?.data ?? []}
          drawerOnly
          createOpen
          onCreateOpenChange={(open) => {
            if (!open) {
              setCreating(null)
              void refresh()
            }
          }}
        />
      ) : null}
      {creating === "consentimiento" ? (
        <NewConsentDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            setCreating(null)
            await refresh()
          }}
        />
      ) : null}
      {creating === "orden" ? (
        <NewOrderDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null)
            void refresh()
          }}
        />
      ) : null}
      {creating === "formulario" ? (
        <NewResponseDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          templates={(templates.data?.data ?? []).filter((t) => t.respondent !== "portal")}
          onClose={() => setCreating(null)}
          onCreated={async (id) => {
            setCreating(null)
            await refresh()
            const created = await fetchFormResponses({ patientId })
            const response = created.data.find((row) => row.id === id)
            if (response) setOpened({ kind: "formulario", response })
          }}
        />
      ) : null}

      <ConsentSigningScreen
        open={signing !== null}
        documents={signing ?? []}
        patientId={patientId}
        onClose={() => setSigning(null)}
        onSigned={refresh}
      />
      {resultFor ? (
        <OrderResultDrawer
          order={resultFor}
          onClose={() => setResultFor(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  )
}

/** Una fila de la lista: miniatura o icono, nombre que abre el papel, estado y su acción. */
function RowShell({
  media,
  title,
  detail,
  onOpen,
  status,
  action,
  children,
}: {
  media: React.ReactNode
  title: string
  detail: string
  onOpen?: () => void
  status: { label: string; tone: Tone } | null
  action: React.ReactNode
  children?: React.ReactNode
}) {
  const text = (
    <>
      <span className="break-words font-medium">{title}</span>
      <span className="break-words text-muted-foreground">{detail}</span>
    </>
  )
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 text-sm">
      {media}
      {onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 basis-48 flex-col rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onOpen}
        >
          {text}
          {children}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          {text}
          {children}
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {status ? <Badge variant={status.tone}>{status.label}</Badge> : null}
        {action}
      </div>
    </li>
  )
}

const ALL_TEETH = "todas"
const TOOTH_ITEMS: Record<string, string> = {
  [ALL_TEETH]: "Todas las piezas",
  ...Object.fromEntries([...FDI_ADULT, ...FDI_CHILD].map((n) => [String(n), `Pieza ${n}`])),
}

/** «Todas las piezas ▾»: el mismo filtro de pieza que Historia (decisión 7). */
function ToothFilter({
  value,
  onChange,
}: {
  value: number | undefined
  onChange: (tooth: number | undefined) => void
}) {
  return (
    <Select
      items={TOOTH_ITEMS}
      value={value != null ? String(value) : ALL_TEETH}
      onValueChange={(next) => onChange(next && next !== ALL_TEETH ? Number(next) : undefined)}
    >
      <SelectTrigger aria-label="Pieza" className="w-auto min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_TEETH}>Todas las piezas</SelectItem>
        <SelectGroup>
          <SelectLabel>Permanentes</SelectLabel>
          {FDI_ADULT.map((n) => (
            <SelectItem key={n} value={String(n)}>
              Pieza {n}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Temporales</SelectLabel>
          {FDI_CHILD.map((n) => (
            <SelectItem key={n} value={String(n)}>
              Pieza {n}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function KindIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-5" />
    </span>
  )
}

/**
 * La fila de una imagen o archivo (decisiones 3 y 4): su miniatura, su tipo y
 * su fecha de toma; «Ver» la abre de una vez. Una tomografía a medio subir dice
 * cuánto falta y no se abre en el visor hasta estar completa.
 */
function FileRow({
  patientId,
  row,
  doc,
  canWrite,
  onOpen,
}: {
  patientId: string
  row: Row
  doc: PatientDocument
  canWrite: boolean
  onOpen: () => void
}) {
  const imaging = doc.imaging ?? null
  // Solo una imagen o una tomografía con miniatura tienen qué dibujar.
  const wantsThumb = imaging ? Boolean(imaging.thumbnailKey) : isImageDoc(doc)
  const thumb = useSignedUrl(patientId, doc.id, "thumb", wantsThumb)
  const [broken, setBroken] = useState(false)
  const url = wantsThumb && !broken ? (thumb.data?.data.url ?? null) : null
  const upload = useImagingState(patientId, doc)

  const media = url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="size-10 shrink-0 rounded-md bg-muted object-cover"
    />
  ) : (
    <KindIcon icon={isImageCategory(doc.category) ? ImageIcon : FileText} />
  )

  const status = upload ? { label: upload.text, tone: "warning" as const } : row.status
  const action = upload ? (
    canWrite && !upload.active ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Subir lo que falta de ${row.title}`}
        onClick={onOpen}
      >
        Subir lo que falta
      </Button>
    ) : null
  ) : (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={`Ver ${row.title}`}
      onClick={onOpen}
    >
      Ver
    </Button>
  )

  return (
    <RowShell
      media={media}
      title={row.title}
      detail={row.detail}
      onOpen={onOpen}
      status={status}
      action={action}
    >
      {upload?.active ? (
        <span
          role="progressbar"
          aria-label="Avance de la subida"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={upload.percent}
          className="mt-1 block h-1.5 max-w-64 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${upload.percent}%` }}
          />
        </span>
      ) : null}
    </RowShell>
  )
}

/** Un papel abierto al lado: su detalle con lo que se puede hacer con él. */
function OpenedDocument({
  patientId,
  opened,
  canWrite,
  onClose,
  onChanged,
}: {
  patientId: string
  opened: Row["open"] | null
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  // Lo abierto se relee de su lista: tras firmar o completar, el detalle cambia.
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: opened?.kind === "consentimiento",
  })
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: opened?.kind === "formulario",
  })
  const orders = useQuery({
    queryKey: ["clinical-orders", patientId, "indice"],
    queryFn: () => fetchOrders({ patientId }),
    enabled: opened?.kind === "orden",
  })
  if (!opened || opened.kind === "archivo" || opened.kind === "odontograma") return null
  const title =
    opened.kind === "consentimiento"
      ? opened.consent.titleSnapshot
      : opened.kind === "orden"
        ? opened.order.title
        : opened.kind === "receta"
          ? `Receta N.º ${opened.prescription.prescriptionNumber}`
          : (opened.response.templateTitle ?? "Formulario")
  return (
    <DetailDrawer open title={title} onClose={onClose}>
      {opened.kind === "consentimiento" ? (
        <ConsentDetail
          document={
            (consents.data?.data ?? []).find((row) => row.id === opened.consent.id) ??
            opened.consent
          }
          canWrite={canWrite}
          onChanged={onChanged}
        />
      ) : opened.kind === "orden" ? (
        <OrderRow
          order={
            (orders.data?.data ?? []).find((row) => row.id === opened.order.id) ?? opened.order
          }
          canWrite={canWrite}
          onChanged={() => void onChanged()}
        />
      ) : opened.kind === "receta" ? (
        <PrescriptionEntry patientId={patientId} prescription={opened.prescription} defaultOpen />
      ) : (
        <ResponseDetail
          key={opened.response.id}
          response={
            (forms.data?.data ?? []).find((row) => row.id === opened.response.id) ?? opened.response
          }
          canWrite={canWrite}
          onChanged={onChanged}
        />
      )}
    </DetailDrawer>
  )
}

/**
 * A quién le falta firmar, con su nombre: la propia persona si es mayor de
 * edad o, si es menor, su representante legal vigente (la regla del servidor).
 */
function signerWords(
  detail: PatientFull | undefined,
  responsibilities:
    | Array<{ isCurrent: boolean; kind: string; contact: { displayName: string } }>
    | undefined,
): string | null {
  if (!detail) return null
  const age = ageFrom(detail.patient.birthDate)
  const minor = age !== "" && Number(age) < 18
  if (!minor) {
    const first = (detail.patient.givenNames ?? detail.patient.displayName).trim().split(/\s+/)[0]
    return first || detail.patient.displayName
  }
  const representatives = (responsibilities ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  if (representatives.length === 1) {
    const name = representatives[0]?.contact.displayName.trim().split(/\s+/)[0]
    return name ? `${name}, su representante legal` : "su representante legal"
  }
  return "su representante legal"
}
