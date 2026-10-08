import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { IMAGE_TYPES } from "@odentia/clinical"
import {
  ConfirmDialog,
  EmptyState,
  FilterBar,
  type FilterDef,
  FormDrawer,
  type SortOption,
  useListSearch,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { FileText, Image as ImageIcon } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { timeAgo, usePermission } from "../../lib/crm"
import type {
  Encounter,
  PatientDocument,
  PatientDocumentContext,
  PlanItem,
} from "../../lib/patients"
import {
  categoryLabel,
  encounterLabel,
  formatTakenAt,
  imageTypeLabel,
  planItemLabel,
  reportStatusLabel,
  takenAt,
  UPLOAD_CATEGORIES,
} from "./document-labels"
import { DocumentLinkSelects, type DocumentLinkValue } from "./document-link-selects"
import { DocumentUploadDialog } from "./document-upload-dialog"
import {
  AdjustedImage,
  DEFAULT_ADJUSTMENTS,
  ImageAdjustControls,
  type ImageAdjustments,
  ImageCompare,
} from "./image-viewer"
import { TagsInput } from "./tags-input"
import { ToothSelector } from "./tooth-selector"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000
type SortKey = "recientes" | "antiguos" | "titulo"

/** Alias local: el listado ya trae el contexto vigente fusionado (tipos comunes de Main). */
type DocView = PatientDocument

function isImageDoc(doc: PatientDocument): boolean {
  return doc.contentType.startsWith("image/")
}

function isPdfDoc(doc: PatientDocument): boolean {
  return doc.contentType === "application/pdf"
}

function isDicomDoc(doc: PatientDocument): boolean {
  return doc.contentType === "application/dicom"
}

/** Periodos del filtro, en días hacia atrás desde hoy. */
const PERIODS: Record<string, { label: string; days: number }> = {
  "30d": { label: "Últimos 30 días", days: 30 },
  "6m": { label: "Últimos 6 meses", days: 183 },
  "12m": { label: "Últimos 12 meses", days: 365 },
  "24m": { label: "Últimos 24 meses", days: 730 },
}

function monthHeading(iso: string): string {
  const text = new Date(iso).toLocaleDateString("es-PE", { month: "long", year: "numeric" })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function useSignedUrl(patientId: string, documentId: string) {
  const canRead = usePermission("clinical.read")
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    enabled: canRead,
  })
}

export interface ImagenesTabProps {
  patientId: string
  encounterId?: string
  initialTooth?: number
  initialDocumentId?: string
  readOnly?: boolean
  onUploaded?: () => void | Promise<void>
  disabled?: boolean
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
}

export function ImagenesTab({
  patientId,
  encounterId,
  initialTooth,
  initialDocumentId,
  readOnly,
  onUploaded,
  disabled,
  beforeWrite,
  onPendingChange,
}: ImagenesTabProps) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")

  const listSearch = useListSearch()
  const [teeth, setTeeth] = useState<number[]>(initialTooth != null ? [initialTooth] : [])
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [contextDoc, setContextDoc] = useState<DocView | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (initialTooth != null) setTeeth([initialTooth])
  }, [initialTooth])

  // Los retirados no están en la galería; se consultan aparte con su motivo.
  const showRetired = listSearch.get("estado") === "retirados"
  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId, showRetired ? "con-retirados" : "activos"],
    queryFn: () =>
      apiFetch<{ data: DocView[] }>(
        `/api/patients/${patientId}/documents${showRetired ? "?includeRetired=true" : ""}`,
      ),
    enabled: canRead,
  })

  const encountersQuery = useQuery({
    queryKey: ["encounters", patientId],
    queryFn: async () => {
      const all: Encounter[] = []
      let cursor: string | null = null
      do {
        const query: string = cursor
          ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
          : "?limit=100"
        const page: { data: Encounter[]; nextCursor: string | null } = await apiFetch(
          `/api/patients/${patientId}/encounters${query}`,
        )
        all.push(...page.data)
        cursor = page.nextCursor ?? null
      } while (cursor)
      return all
    },
    enabled: canRead,
  })
  const planQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canRead,
  })

  const allDocs = docsQuery.data?.data ?? []
  const encounters = encountersQuery.data ?? []
  const planItems = planQuery.data?.data ?? []
  const planById = useMemo(() => new Map(planItems.map((p) => [p.id, p])), [planItems])
  const encounterById = useMemo(() => new Map(encounters.map((e) => [e.id, e])), [encounters])
  const allTags = useMemo(
    () => [...new Set(allDocs.flatMap((d) => d.tags))].sort((a, b) => a.localeCompare(b, "es")),
    [allDocs],
  )
  useEffect(() => {
    if (initialDocumentId && docsQuery.data?.data.some((d) => d.id === initialDocumentId)) {
      setViewingId(initialDocumentId)
    }
  }, [initialDocumentId, docsQuery.data])

  const searchText = (listSearch.get("q") ?? "").trim().toLowerCase()
  const categoryParam = listSearch.get("categoria")
  const atencionParam = listSearch.get("atencion")
  const planParam = listSearch.get("tratamiento")
  const etiquetaParam = listSearch.get("etiqueta")
  const tipoParam = listSearch.get("tipo")
  const periodoParam = listSearch.get("periodo")
  const sortParam = listSearch.get("sort")
  const sort: SortKey = sortParam === "antiguos" || sortParam === "titulo" ? sortParam : "recientes"
  // En una atención, el filtro prefiere esa atención salvo "todas" explícito.
  const atencion = atencionParam === "todas" ? undefined : (atencionParam ?? encounterId)

  const filters: FilterDef[] = useMemo(
    () => [
      {
        key: "categoria",
        label: "Categoría",
        type: "select",
        options: UPLOAD_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })),
      },
      {
        key: "tipo",
        label: "Tipo",
        type: "select",
        options: IMAGE_TYPES.map((t) => ({ value: t, label: imageTypeLabel(t) ?? t })),
      },
      {
        key: "periodo",
        label: "Periodo",
        type: "select",
        options: Object.entries(PERIODS).map(([value, p]) => ({ value, label: p.label })),
      },
      {
        key: "atencion",
        label: "Atención",
        type: "select",
        options: [
          ...(encounterId ? [{ value: "todas", label: "Todas" }] : []),
          { value: "ninguna", label: "Sin atención (generales)" },
          ...encounters.map((e) => ({ value: e.id, label: encounterLabel(e) })),
        ],
      },
      {
        key: "tratamiento",
        label: "Tratamiento",
        type: "select",
        placement: "overflow",
        options: [
          { value: "ninguno", label: "Sin tratamiento" },
          ...planItems.map((p) => ({ value: p.id, label: planItemLabel(p) })),
        ],
      },
      {
        key: "etiqueta",
        label: "Etiqueta",
        type: "select",
        placement: "overflow",
        options: allTags.map((t) => ({ value: t, label: t })),
      },
      {
        key: "estado",
        label: "Estado",
        type: "select",
        placement: "overflow",
        options: [{ value: "retirados", label: "Retirados" }],
      },
    ],
    [encounterId, encounters, planItems, allTags],
  )

  const sortOptions: SortOption[] = useMemo(
    () => [
      { value: "recientes", label: "Toma más reciente" },
      { value: "antiguos", label: "Toma más antigua" },
      { value: "titulo", label: "Título A–Z" },
    ],
    [],
  )

  const filtered = useMemo(() => {
    const teethSet = new Set(teeth)
    const since =
      periodoParam && PERIODS[periodoParam]
        ? Date.now() - PERIODS[periodoParam]!.days * 86_400_000
        : null
    const list = allDocs.filter((d) => {
      if (showRetired !== Boolean(d.retiredAt)) return false
      if (searchText && !d.label.toLowerCase().includes(searchText)) return false
      if (categoryParam && d.category !== categoryParam) return false
      if (tipoParam && d.imageType !== tipoParam) return false
      if (since != null && new Date(takenAt(d)).getTime() < since) return false
      if (teeth.length > 0 && !d.toothNumbers.some((t) => teethSet.has(t))) return false
      if (atencion === "ninguna") {
        if (d.encounterId) return false
      } else if (atencion && d.encounterId !== atencion) {
        return false
      }
      if (planParam === "ninguno") {
        if (d.planItemId) return false
      } else if (planParam && d.planItemId !== planParam) {
        return false
      }
      if (etiquetaParam && !d.tags.includes(etiquetaParam)) return false
      return true
    })
    return [...list].sort((a, b) => {
      if (sort === "antiguos") return takenAt(a).localeCompare(takenAt(b))
      if (sort === "titulo") return a.label.localeCompare(b.label, "es")
      return takenAt(b).localeCompare(takenAt(a))
    })
  }, [
    allDocs,
    showRetired,
    searchText,
    categoryParam,
    tipoParam,
    periodoParam,
    teeth,
    atencion,
    planParam,
    etiquetaParam,
    sort,
  ])

  // Por fecha de toma, agrupado por mes; por título, lista única.
  const groups = useMemo(() => {
    if (sort === "titulo") return [{ heading: null as string | null, docs: filtered }]
    const out: Array<{ heading: string | null; docs: DocView[] }> = []
    for (const doc of filtered) {
      const heading = monthHeading(takenAt(doc))
      const last = out[out.length - 1]
      if (last && last.heading === heading) last.docs.push(doc)
      else out.push({ heading, docs: [doc] })
    }
    return out
  }, [filtered, sort])

  const viewing = viewingId ? (allDocs.find((d) => d.id === viewingId) ?? null) : null
  const viewingIndex = viewing ? filtered.findIndex((d) => d.id === viewing.id) : -1
  const openViewing = (id: string) => {
    if (document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement
    setViewingId(id)
  }

  const listError =
    docsQuery.error instanceof ApiError
      ? (docsQuery.error.shape.message ?? "No se pudieron cargar los documentos.")
      : docsQuery.error
        ? "No se pudieron cargar los documentos."
        : null

  const invalidateAfterChange = async () => {
    await Promise.all(
      [
        "patient-documents",
        "patient-document-context",
        "timeline",
        "patient",
        "patient-summary",
        "encounter",
      ].map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
    )
    await onUploaded?.()
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section
        aria-label="Archivo clínico"
        className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {showRetired ? "Archivos retirados" : "Imágenes y archivos"} ({filtered.length})
          </h2>
          {!readOnly && canWrite && (
            <Button size="sm" disabled={disabled} onClick={() => setUploadOpen(true)}>
              Subir imagen o documento
            </Button>
          )}
        </div>

        <FilterBar
          filters={filters}
          sortOptions={sortOptions}
          searchPlaceholder="Buscar por título"
        />

        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Filtrar por piezas{teeth.length > 0 ? ` (${teeth.length})` : ""}
          </summary>
          <div className="pt-2">
            <ToothSelector value={teeth} onChange={setTeeth} label="Piezas del filtro" />
          </div>
        </details>

        {docsQuery.isPending && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {listError && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-destructive">{listError}</p>
            <Button size="sm" variant="outline" onClick={() => void docsQuery.refetch()}>
              Reintentar
            </Button>
          </div>
        )}
        {!docsQuery.isPending && !listError && filtered.length === 0 && (
          <EmptyState
            title="Sin archivos"
            description={
              allDocs.length === 0
                ? encounterId
                  ? "Esta atención aún no tiene archivos vinculados."
                  : "Aún no hay radiografías, fotos ni documentos."
                : "Ningún archivo coincide con los filtros actuales."
            }
          />
        )}
        {groups.map((group) =>
          group.docs.length === 0 ? null : (
            <section
              key={group.heading ?? "todos"}
              aria-label={group.heading ?? "Archivos"}
              className="flex flex-col gap-2"
            >
              {group.heading && (
                <h3 className="text-xs font-medium text-muted-foreground">{group.heading}</h3>
              )}
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {group.docs.map((doc) => (
                  <DocCard
                    key={doc.id}
                    patientId={patientId}
                    doc={doc}
                    planItem={doc.planItemId ? planById.get(doc.planItemId) : undefined}
                    encounter={doc.encounterId ? encounterById.get(doc.encounterId) : undefined}
                    onOpen={() => openViewing(doc.id)}
                  />
                ))}
              </ul>
            </section>
          ),
        )}
        <p className="text-xs text-muted-foreground">
          Los archivos forman parte de la historia clínica: no se borran. Uno subido por error se
          retira con motivo y queda en «Estado: Retirados».
        </p>
      </section>

      <Dialog
        open={viewing !== null && contextDoc === null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingId(null)
            openerRef.current?.focus()
          }
        }}
      >
        {viewing && (
          <DialogContent
            aria-label={`Ver ${viewing.label}`}
            className="max-h-[92dvh] overflow-y-auto sm:max-w-[min(90vw,80rem)]"
          >
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <DialogTitle>{viewing.label}</DialogTitle>
                  <DialogDescription>
                    {imageTypeLabel(viewing.imageType) ?? categoryLabel(viewing.category)} ·{" "}
                    {formatTakenAt(viewing)}
                    {viewing.toothNumbers.length > 0 ? ` · Pieza ${viewing.toothNumbers.join(", ")}` : ""}
                    {filtered.length > 1 ? ` · ${viewingIndex + 1} de ${filtered.length}` : ""}
                  </DialogDescription>
                </div>
                {viewingIndex > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setViewingId(filtered[viewingIndex - 1]!.id)}
                  >
                    Anterior
                  </Button>
                )}
                {viewingIndex >= 0 && viewingIndex < filtered.length - 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setViewingId(filtered[viewingIndex + 1]!.id)}
                  >
                    Siguiente
                  </Button>
                )}
              </div>
            </DialogHeader>
            <DocumentViewer
              patientId={patientId}
              doc={viewing}
              planItem={viewing.planItemId ? planById.get(viewing.planItemId) : undefined}
              encounter={viewing.encounterId ? encounterById.get(viewing.encounterId) : undefined}
              canEdit={!readOnly && canWrite && !disabled && !viewing.retiredAt}
              onEditContext={() => {
                setResumeId(viewingId)
                setContextDoc(viewing)
              }}
              compareCandidates={allDocs.filter(
                (d) => d.id !== viewing.id && !d.retiredAt && isImageDoc(d),
              )}
              onChanged={invalidateAfterChange}
              onRetired={async () => {
                setViewingId(null)
                await invalidateAfterChange()
              }}
            />
          </DialogContent>
        )}
      </Dialog>
      <DocumentUploadDialog
        patientId={patientId}
        defaultEncounterId={encounterId}
        defaultPlanItemId={planParam || undefined}
        initialTeeth={initialTooth != null ? [initialTooth] : undefined}
        encounters={encounters}
        planItems={planItems}
        suggestions={allTags}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={invalidateAfterChange}
        beforeWrite={beforeWrite}
        onPendingChange={onPendingChange}
        disabled={disabled}
      />

      {contextDoc && (
        <ContextDrawer
          patientId={patientId}
          doc={contextDoc}
          encounters={encounters}
          planItems={planItems}
          suggestions={allTags}
          open={contextDoc !== null}
          onOpenChange={(open) => {
            if (!open) {
              setContextDoc(null)
              if (resumeId) {
                setViewingId(resumeId)
                setResumeId(null)
              }
            }
          }}
          onSaved={async (updated) => {
            setContextDoc(null)
            setResumeId(null)
            await invalidateAfterChange()
            if (updated?.id) setViewingId(updated.id)
          }}
          beforeWrite={beforeWrite}
          onPendingChange={onPendingChange}
          disabled={disabled}
        />
      )}
    </div>
  )
}

function DocCard({
  patientId,
  doc,
  planItem,
  encounter,
  onOpen,
}: {
  patientId: string
  doc: DocView
  planItem?: PlanItem
  encounter?: Encounter
  onOpen: () => void
}) {
  const urlQuery = useSignedUrl(patientId, doc.id)
  const url = urlQuery.data?.data.url ?? null
  const teeth = doc.toothNumbers
  const tags = doc.tags

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver ${doc.label}`}
        className="flex w-full min-w-0 flex-col gap-2 rounded-lg border p-2 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="relative block aspect-square w-full overflow-hidden rounded-md bg-muted">
          {url && isImageDoc(doc) ? (
            // URL firmada directa: sin object URLs, sin fugas de recursos multimedia.
            // object-contain: la radiografía se ve completa, sin recortes.
            <img src={url} alt="" loading="lazy" className="h-full w-full object-contain" />
          ) : urlQuery.isPending ? (
            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Cargando…
            </span>
          ) : (
            <span className="flex h-full items-center justify-center">
              {isPdfDoc(doc) ? (
                <FileText className="size-10 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ImageIcon className="size-10 text-muted-foreground" aria-hidden="true" />
              )}
            </span>
          )}
          <Badge variant="secondary" className="absolute top-1.5 left-1.5 max-w-[90%] truncate">
            {imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)}
          </Badge>
          {doc.retiredAt ? (
            <Badge variant="destructive" className="absolute right-1.5 bottom-1.5">
              Retirado
            </Badge>
          ) : doc.reportStatus === "pendiente" ? (
            <Badge variant="outline" className="absolute right-1.5 bottom-1.5 bg-background">
              Sin informar
            </Badge>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-col gap-1 px-0.5 pb-0.5">
          <span className="truncate text-sm font-medium">{doc.label}</span>
          <span className="text-xs text-muted-foreground">
            {formatTakenAt(doc)}
            {teeth.length > 0 &&
              ` · ${teeth.length === 1 ? `Pieza ${teeth[0]}` : `${teeth.length} piezas`}`}
          </span>
          {teeth.length > 1 && (
            <span className="flex flex-wrap gap-1" aria-label={`Piezas: ${teeth.join(", ")}`}>
              {teeth.slice(0, 4).map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
              {teeth.length > 4 && <Badge variant="outline">+{teeth.length - 4}</Badge>}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {encounter ? `Atención · ${timeAgo(encounter.createdAt)}` : "Sin atención"}
            {planItem ? ` · ${planItem.title}` : ""}
            {doc.source ? ` · ${doc.source}` : ""}
          </span>
          {tags.length > 0 && (
            <span className="flex flex-wrap gap-1" aria-label={`Etiquetas: ${tags.join(", ")}`}>
              {tags.slice(0, 3).map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
              {tags.length > 3 && <Badge variant="secondary">+{tags.length - 3}</Badge>}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

function DocumentViewer({
  patientId,
  doc,
  planItem,
  encounter,
  canEdit,
  onEditContext,
  compareCandidates,
  onChanged,
  onRetired,
}: {
  patientId: string
  doc: DocView
  planItem?: PlanItem
  encounter?: Encounter
  canEdit: boolean
  onEditContext: () => void
  /** Otras imágenes activas del paciente para comparar. */
  compareCandidates: DocView[]
  onChanged: () => Promise<void>
  onRetired: () => Promise<void>
}) {
  const canRead = usePermission("clinical.read")
  const urlQuery = useSignedUrl(patientId, doc.id)
  const url = urlQuery.data?.data.url ?? null
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(DEFAULT_ADJUSTMENTS)
  const [compareId, setCompareId] = useState<string>("")
  const [retireOpen, setRetireOpen] = useState(false)
  const [retireReason, setRetireReason] = useState("")
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const retireId = useId()
  const compareSelectId = useId()
  useEffect(() => {
    setAdjustments(DEFAULT_ADJUSTMENTS)
    setCompareId("")
    setActionError(null)
  }, [doc.id])
  // Primero las del mismo tipo y que comparten pieza: es la comparación útil.
  const rankedCandidates = useMemo(() => {
    const score = (d: DocView) =>
      (d.imageType && d.imageType === doc.imageType ? 2 : 0) +
      (d.toothNumbers.some((t) => doc.toothNumbers.includes(t)) ? 1 : 0)
    return [...compareCandidates].sort(
      (a, b) => score(b) - score(a) || takenAt(b).localeCompare(takenAt(a)),
    )
  }, [compareCandidates, doc.imageType, doc.toothNumbers])
  const compareDoc = compareId ? rankedCandidates.find((d) => d.id === compareId) : undefined
  const compareUrlQuery = useSignedUrl(patientId, compareId || doc.id)
  const compareUrl = compareId ? (compareUrlQuery.data?.data.url ?? null) : null

  const runAction = async (fn: () => Promise<unknown>, after: () => Promise<void>) => {
    setActionPending(true)
    setActionError(null)
    try {
      await fn()
      await after()
      return true
    } catch (e) {
      setActionError(e instanceof ApiError ? (e.shape.message ?? e.message) : "No se pudo guardar.")
      return false
    } finally {
      setActionPending(false)
    }
  }
  const setReport = (reportStatus: string) =>
    runAction(
      () =>
        apiFetch(`/api/patients/${patientId}/documents/${doc.id}/report`, {
          method: "PATCH",
          body: JSON.stringify({ reportStatus }),
        }),
      onChanged,
    )
  const error =
    urlQuery.error instanceof ApiError
      ? (urlQuery.error.shape.message ?? "No se pudo obtener el documento.")
      : urlQuery.error
        ? "No se pudo obtener el documento."
        : null

  const historyQuery = useQuery({
    queryKey: ["patient-document-context", patientId, doc.id],
    queryFn: async () => {
      const body = await apiFetch<{
        data: { document: PatientDocument; history: PatientDocumentContext[] }
      }>(`/api/patients/${patientId}/documents/${doc.id}/context`)
      return body.data.history
    },
    enabled: canRead,
  })

  const teeth = doc.toothNumbers
  const tags = doc.tags

  const planSearch = planItem
    ? {
        tab: "plan" as const,
        planId: planItem.planId,
        ...(planItem.budgetId ? { budgetId: planItem.budgetId } : {}),
      }
    : { tab: "plan" as const }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {urlQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : error || !url ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{error ?? "No se pudo obtener el documento."}</p>
          <Button size="sm" variant="outline" onClick={() => void urlQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : isImageDoc(doc) && compareDoc && compareUrl ? (
        <ImageCompare
          before={
            takenAt(compareDoc) <= takenAt(doc)
              ? { url: compareUrl, label: compareDoc.label, caption: formatTakenAt(compareDoc) }
              : { url, label: doc.label, caption: formatTakenAt(doc) }
          }
          after={
            takenAt(compareDoc) <= takenAt(doc)
              ? { url, label: doc.label, caption: formatTakenAt(doc) }
              : { url: compareUrl, label: compareDoc.label, caption: formatTakenAt(compareDoc) }
          }
        />
      ) : isImageDoc(doc) ? (
        <div className="flex min-w-0 flex-col gap-3">
          <AdjustedImage src={url} alt={doc.label} adjustments={adjustments} className="max-h-[65vh]" />
          <ImageAdjustControls value={adjustments} onChange={setAdjustments} />
        </div>
      ) : isPdfDoc(doc) ? (
        <embed src={url} type="application/pdf" className="h-[70vh] w-full rounded-md border" />
      ) : isDicomDoc(doc) ? (
        <div className="flex flex-col gap-2 rounded-md border p-4 text-sm">
          <p className="font-medium">Archivo DICOM</p>
          <p className="text-muted-foreground">
            Se conserva como archivo externo. Descárgalo para abrirlo en el visor del equipo
            radiológico; aquí no hay visor volumétrico.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Vista previa no disponible para este tipo de archivo.
        </p>
      )}
      {/* Visor arriba; columna de metadata (plegable en móvil) debajo/al lado. */}
      <div className="flex min-w-0 flex-col gap-3">
        {doc.retiredAt && (
          <div role="status" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">Retirado {timeAgo(doc.retiredAt)}</p>
            <p className="text-muted-foreground">Motivo: {doc.retireReason}</p>
          </div>
        )}
        {isImageDoc(doc) && rankedCandidates.length > 0 && (
          <Field>
            <FieldLabel htmlFor={compareSelectId}>Comparar con</FieldLabel>
            <Select
              items={Object.fromEntries([
                ["", "Sin comparar"],
                ...rankedCandidates.map((d) => [
                  d.id,
                  `${imageTypeLabel(d.imageType) ?? d.label} · ${formatTakenAt(d)}`,
                ]),
              ])}
              value={compareId}
              onValueChange={(v) => setCompareId(v ?? "")}
            >
              <SelectTrigger id={compareSelectId}>
                <SelectValue placeholder="Sin comparar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Sin comparar</SelectItem>
                {rankedCandidates.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {imageTypeLabel(d.imageType) ?? d.label} · {formatTakenAt(d)}
                    {d.toothNumbers.length > 0 ? ` · ${d.toothNumbers.join(", ")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <details open className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Detalles del archivo</summary>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 pt-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Tipo</dt>
              <dd>{imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Fecha de toma</dt>
              <dd>
                {doc.capturedAt
                  ? new Date(doc.capturedAt).toLocaleString("es-PE", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "No registrada"}{" "}
                <span className="text-muted-foreground">
                  (subida{" "}
                  {new Date(doc.createdAt).toLocaleString("es-PE", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  )
                </span>
              </dd>
            </div>
            {doc.source && (
              <div>
                <dt className="text-xs text-muted-foreground">Origen</dt>
                <dd>{doc.source}</dd>
              </div>
            )}
            {doc.reportStatus && (
              <div>
                <dt className="text-xs text-muted-foreground">Informe</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {reportStatusLabel(doc.reportStatus)}
                  {canEdit && doc.reportStatus === "pendiente" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionPending}
                      onClick={() => void setReport("informado")}
                    >
                      Marcar como informada
                    </Button>
                  )}
                  {canEdit && doc.reportStatus === "informado" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={actionPending}
                      onClick={() => void setReport("pendiente")}
                    >
                      Volver a pendiente
                    </Button>
                  )}
                </dd>
                {doc.reportStatus === "pendiente" && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    El informe se escribe en la atención, en «Exámenes auxiliares».
                  </p>
                )}
              </div>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">Piezas</dt>
              <dd>{teeth.length > 0 ? teeth.join(", ") : "Sin piezas vinculadas"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Etiquetas</dt>
              <dd>
                {tags.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {tags.map((t) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "Sin etiquetas"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Atención</dt>
              <dd>
                {doc.encounterId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link
                        to="/patients/$patientId/encounters/$encounterId"
                        params={{ patientId, encounterId: doc.encounterId }}
                      />
                    }
                  >
                    {encounter
                      ? `Abrir atención (${timeAgo(encounter.createdAt)})`
                      : "Abrir atención"}
                  </Button>
                ) : (
                  "Archivo general (sin atención)"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Tratamiento</dt>
              <dd>
                {doc.planItemId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={<Link to="/patients/$patientId" params={{ patientId }} search={planSearch} />}
                  >
                    {planItem ? `Ver plan: ${planItem.title}` : "Ver plan"}
                  </Button>
                ) : (
                  "Sin tratamiento vinculado"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Revisión de contexto</dt>
              <dd className="flex items-center gap-2">
                v{doc.contextVersion}
                {canEdit && (
                  <Button size="sm" variant="outline" onClick={onEditContext}>
                    Editar contexto
                  </Button>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Presupuesto</dt>
              <dd>
                {doc.budgetId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link
                        to="/patients/$patientId"
                        params={{ patientId }}
                        search={{ tab: "plan", budgetId: doc.budgetId }}
                      />
                    }
                  >
                    Ver la propuesta
                  </Button>
                ) : (
                  "Sin presupuesto vinculado"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Procedimiento</dt>
              <dd>
                {doc.encounterProcedureId
                  ? "Vinculado a un procedimiento"
                  : "Sin procedimiento vinculado"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Control</dt>
              <dd>
                {doc.followUpId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link to="/patients/$patientId" params={{ patientId }} search={{ tab: "controles" }} />
                    }
                  >
                    Ver controles
                  </Button>
                ) : (
                  "Sin control vinculado"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Receta</dt>
              <dd>
                {doc.prescriptionId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link to="/patients/$patientId" params={{ patientId }} search={{ tab: "recetas" }} />
                    }
                  >
                    Ver recetas
                  </Button>
                ) : (
                  "Sin receta vinculada"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pago</dt>
              <dd>
                {doc.paymentId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link to="/patients/$patientId" params={{ patientId }} search={{ tab: "cuenta" }} />
                    }
                  >
                    Ver cuenta
                  </Button>
                ) : (
                  "Sin pago vinculado"
                )}
              </dd>
            </div>
          </dl>
        </details>
        {historyQuery.data && historyQuery.data.length > 1 && (
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Historial de contexto ({historyQuery.data.length} revisiones)
            </summary>
            <ul className="flex flex-col gap-2 pt-2">
              {[...historyQuery.data]
                .sort((a, b) => b.version - a.version)
                .map((rev) => (
                  <li key={rev.version} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">v{rev.version}</span> ·{" "}
                    {timeAgo(rev.createdAt)}
                    {rev.toothNumbers.length > 0 && ` · Piezas ${rev.toothNumbers.join(", ")}`}
                    {rev.tags.length > 0 && ` · ${rev.tags.join(", ")}`}
                    {rev.encounterId && " · Atención"}
                    {rev.planItemId && " · Tratamiento"}
                    {rev.encounterProcedureId && " · Procedimiento"}
                    {rev.budgetId && " · Presupuesto"}
                    {rev.followUpId && " · Control"}
                    {rev.prescriptionId && " · Receta"}
                    {rev.paymentId && " · Pago"}
                  </li>
                ))}
            </ul>
          </details>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const link = `${window.location.origin}/patients/${patientId}?tab=imagenes&documentId=${doc.id}`
              void navigator.clipboard
                ?.writeText(link)
                .catch(() => window.prompt("Copia el enlace:", link))
            }}
          >
            Copiar enlace
          </Button>
          {url && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(url, "_blank", "noopener")}
              >
                Abrir en pestaña nueva
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const anchor = document.createElement("a")
                  anchor.href = url
                  anchor.download = doc.label
                  document.body.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                }}
              >
                Descargar
              </Button>
            </>
          )}
          {canEdit && !doc.retiredAt && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => {
                setRetireReason("")
                setRetireOpen(true)
              }}
            >
              Retirar…
            </Button>
          )}
        </div>
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={retireOpen}
        title="Retirar archivo"
        description="Sale de la galería, de la historia por pieza y del resumen. No se borra: queda en «Retirados» con tu nombre, la fecha y el motivo. No se puede deshacer."
        confirmLabel="Retirar"
        pending={actionPending}
        confirmDisabled={!retireReason.trim()}
        onClose={() => setRetireOpen(false)}
        onConfirm={() =>
          void runAction(
            () =>
              apiFetch(`/api/patients/${patientId}/documents/${doc.id}/retire`, {
                method: "POST",
                body: JSON.stringify({ reason: retireReason.trim() }),
              }),
            async () => {
              setRetireOpen(false)
              await onRetired()
            },
          )
        }
      >
        <Field>
          <FieldLabel htmlFor={retireId}>Motivo</FieldLabel>
          <Textarea
            id={retireId}
            aria-required="true"
            value={retireReason}
            maxLength={2000}
            placeholder="p. ej. Subida al paciente equivocado"
            onChange={(e) => setRetireReason(e.currentTarget.value)}
          />
        </Field>
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}

function ContextDrawer({
  patientId,
  doc,
  encounters,
  planItems,
  suggestions,
  open,
  onOpenChange,
  onSaved,
  beforeWrite,
  onPendingChange,
  disabled,
}: {
  patientId: string
  doc: DocView
  encounters: Encounter[]
  planItems: PlanItem[]
  suggestions: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (updated: DocView | null) => Promise<void>
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
  disabled?: boolean
}) {
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const previewQuery = useSignedUrl(patientId, doc.id)
  const [encounterChoice, setEncounterChoice] = useState<string>(doc.encounterId ?? "")
  const [planChoice, setPlanChoice] = useState<string>(doc.planItemId ?? "")
  const [links, setLinks] = useState<DocumentLinkValue>({
    budgetId: doc.budgetId ?? "",
    followUpId: doc.followUpId ?? "",
    prescriptionId: doc.prescriptionId ?? "",
    paymentId: doc.paymentId ?? "",
    encounterProcedureId: doc.encounterProcedureId ?? "",
  })
  const procedureQuery = useQuery({
    queryKey: ["encounter-procedures", patientId, doc.encounterId, encounterChoice],
    queryFn: () =>
      apiFetch<{ data: { procedures: Array<{ id: string; description: string }> } }>(
        `/api/patients/${patientId}/encounters/${encounterChoice}`,
      ),
    enabled: open && encounterChoice !== "" && canRead,
  })
  const procedures = procedureQuery.data?.data.procedures ?? []
  const [teeth, setTeeth] = useState<number[]>(doc.toothNumbers)
  const [tags, setTags] = useState<string[]>(doc.tags)
  const [expectedVersion, setExpectedVersion] = useState(doc.contextVersion)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [pending, setPending] = useState(false)
  const encounterChoiceId = useId()
  const planChoiceId = useId()

  const reloadRevision = async () => {
    setPending(true)
    onPendingChange?.(true)
    try {
      await queryClient.invalidateQueries({ queryKey: ["patient-documents", patientId] })
      await queryClient.invalidateQueries({
        queryKey: ["patient-document-context", patientId, doc.id],
      })
      const body = await apiFetch<{ data: DocView[] }>(`/api/patients/${patientId}/documents`)
      queryClient.setQueryData(["patient-documents", patientId], body)
      const fresh = body.data.find((d) => d.id === doc.id)
      if (!fresh) throw new Error("El archivo ya no está disponible.")
      setEncounterChoice(fresh.encounterId ?? "")
      setPlanChoice(fresh.planItemId ?? "")
      setLinks({
        budgetId: fresh.budgetId ?? "",
        followUpId: fresh.followUpId ?? "",
        prescriptionId: fresh.prescriptionId ?? "",
        paymentId: fresh.paymentId ?? "",
        encounterProcedureId: fresh.encounterProcedureId ?? "",
      })
      setTeeth(fresh.toothNumbers)
      setTags(fresh.tags)
      setExpectedVersion(fresh.contextVersion)
      setConflict(false)
      setServerError(null)
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : "No se pudo recargar la revisión vigente.",
      )
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending || disabled) return
    setServerError(null)
    setPending(true)
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      const updated = await apiFetch<{ data: DocView }>(
        `/api/patients/${patientId}/documents/${doc.id}/context`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion,
            encounterId: encounterChoice || null,
            planItemId: planChoice || null,
            budgetId: links.budgetId || null,
            encounterProcedureId: links.encounterProcedureId || null,
            followUpId: links.followUpId || null,
            prescriptionId: links.prescriptionId || null,
            paymentId: links.paymentId || null,
            toothNumbers: teeth,
            tags,
          }),
        },
      )
      await onSaved(updated.data)
    } catch (err) {
      if (err instanceof ApiError && (err.shape.code === "STALE_VERSION" || err.status === 409)) {
        setConflict(true)
        setServerError(
          "Otro usuario actualizó el contexto mientras editabas. Tus cambios se conservan: recarga la revisión vigente y vuelve a guardar.",
        )
        await queryClient.invalidateQueries({ queryKey: ["patient-documents", patientId] })
        await queryClient.invalidateQueries({
          queryKey: ["patient-document-context", patientId, doc.id],
        })
      } else {
        setServerError(
          err instanceof ApiError
            ? (err.shape.message ?? "No se pudo guardar la revisión de contexto.")
            : "No se pudo guardar la revisión de contexto.",
        )
      }
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }

  return (
    <FormDrawer
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(72rem,calc(100vw-2rem))]"
      open={open}
      onClose={() => {
        if (!pending) onOpenChange(false)
      }}
      title={`Editar contexto · ${doc.label}`}
      description={`Crea una nueva revisión (actual v${expectedVersion}). El archivo original no se modifica.`}
      onSubmit={(e) => void onSubmit(e)}
      isSubmitting={pending}
      submitDisabled={disabled}
      submitLabel="Guardar revisión"
      error={serverError}
    >
      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="sticky top-0 rounded-md border bg-background p-3">
        <p className="mb-2 text-sm font-medium">{doc.label}</p>
        {previewQuery.isPending ? <p>Cargando imagen…</p> : previewQuery.isError ? (
          <Button type="button" variant="outline" onClick={() => void previewQuery.refetch()}>Reintentar vista previa</Button>
        ) : previewQuery.data && (isImageDoc(doc) ?
          <img src={previewQuery.data.data.url} alt={doc.label} className="max-h-[60vh] w-full object-contain" /> :
          isPdfDoc(doc) ? <embed src={previewQuery.data.data.url} type="application/pdf" className="h-[60vh] w-full" /> :
          <a href={previewQuery.data.data.url} target="_blank" rel="noreferrer">Abrir archivo original</a>)}
      </div>
      <fieldset disabled={pending || disabled} className="flex flex-col gap-3">
        {conflict && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2">
            <p className="text-xs text-muted-foreground">
              La revisión vigente cambió (ahora v{doc.contextVersion} o superior). Recargarla
              reemplaza este formulario.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void reloadRevision()}
            >
              Recargar revisión
            </Button>
          </div>
        )}
        <Field>
          <FieldLabel htmlFor={encounterChoiceId}>Atención</FieldLabel>
          <Select
            items={Object.fromEntries(encounters.map((e) => [e.id, encounterLabel(e)] as const))}
            value={encounterChoice}
            onValueChange={(v) => setEncounterChoice(v ?? "")}
          >
            <SelectTrigger id={encounterChoiceId} aria-label="Atención vinculada">
              <SelectValue placeholder="General (sin atención)" />
            </SelectTrigger>
            <SelectContent>
              {encounters.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {encounterLabel(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {encounterChoice && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEncounterChoice("")}>
              Quitar vínculo a atención
            </Button>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor={planChoiceId}>Tratamiento</FieldLabel>
          <Select
            items={Object.fromEntries(planItems.map((p) => [p.id, planItemLabel(p)] as const))}
            value={planChoice}
            onValueChange={(v) => setPlanChoice(v ?? "")}
          >
            <SelectTrigger id={planChoiceId} aria-label="Tratamiento vinculado">
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
          {planChoice && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setPlanChoice("")}>
              Quitar vínculo a tratamiento
            </Button>
          )}
        </Field>
        <DocumentLinkSelects
          patientId={patientId}
          value={links}
          idPrefix={`${planChoiceId}-links`}
          procedures={procedures}
          onChange={(patch) => setLinks((current) => ({ ...current, ...patch }))}
        />
        <ToothSelector value={teeth} onChange={setTeeth} label="Piezas" />
        <TagsInput value={tags} onChange={setTags} suggestions={suggestions} />
      </fieldset>
      </div>
    </FormDrawer>
  )
}
