import { productUi } from "../../product/product-ui"
import {
  Badge,
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useIsMobile,
} from "@odentia/ui"
import { ConfirmDialog, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { formatDate, formatDateTime } from "../../lib/clinical-journey"
import { timeAgo, usePermission } from "../../lib/crm"
import { isImageCategory } from "../../lib/document-list"
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
} from "./document-labels"
import { DocumentLinkSelects, type DocumentLinkValue } from "./document-link-selects"
import { DicomViewer } from "./dicom-viewer"
import {
  AdjustedImage,
  DEFAULT_ADJUSTMENTS,
  ImageAdjustControls,
  type ImageAdjustments,
  ImageCompare,
} from "./image-viewer"
import { TagsInput } from "./tags-input"
import { TomographyDetail } from "./tomography-detail"
import { TomographyViewer } from "./tomography-viewer"
import { PlacesField } from "../../product/site-fields"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000
/** Los vínculos del detalle llevan a otra pantalla: enlaces con aspecto de botón, no botones. */
const linkButton = buttonVariants({ size: "sm", variant: "outline" })

/** Alias local: el listado ya trae el contexto vigente fusionado (tipos comunes de Main). */
type DocView = PatientDocument

export function isImageDoc(doc: PatientDocument): boolean {
  return doc.contentType.startsWith("image/")
}

function isPdfDoc(doc: PatientDocument): boolean {
  return doc.contentType === "application/pdf"
}

function isDicomDoc(doc: PatientDocument): boolean {
  return doc.contentType === "application/dicom"
}

/** URL firmada del archivo; `thumb` pide la miniatura (o el original si no la hay). */
export function useSignedUrl(
  patientId: string,
  documentId: string,
  variant: "original" | "thumb" = "original",
  enabled = true,
) {
  const canRead = usePermission("clinical.read")
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId, variant],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(
        `/api/patients/${patientId}/documents/${documentId}/url${variant === "thumb" ? "?variant=thumb" : ""}`,
      ),
    staleTime: SIGNED_URL_STALE_MS,
    enabled: canRead && enabled,
  })
}

/** Todas las atenciones de la persona, página por página: el visor y la subida las nombran. */
export function usePatientEncounters(patientId: string, enabled = true) {
  const canRead = usePermission("clinical.read")
  return useQuery({
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
    enabled: canRead && enabled,
  })
}

/** Las flechas pasan de archivo salvo cuando el foco está en un control que las usa. */
function arrowsBelongToControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true
  const role = target.getAttribute("role")
  return role === "slider" || role === "combobox" || role === "listbox" || role === "option"
}

/**
 * Lo que abre una fila de Documentos (lienzo del issue 149, decisión 3): la
 * tomografía completa en su visor, de una vez; lo demás (radiografía, foto,
 * PDF, DICOM o una tomografía a medio subir) en el visor de archivos.
 * «Anterior» y «Siguiente» recorren los archivos de la lista a la vista, en su
 * orden; ahí mismo se compara (decisión 6).
 */
export function DocumentViewerHost({
  patientId,
  doc,
  sequence,
  allDocs,
  encounters,
  planItems,
  tagSuggestions,
  canWrite,
  onNavigate,
  onClose,
  onChanged,
}: {
  patientId: string
  doc: PatientDocument
  /** Los archivos de la lista a la vista, en su orden. */
  sequence: PatientDocument[]
  /** Todos los archivos activos de la persona: los candidatos a comparar. */
  allDocs: PatientDocument[]
  encounters: Encounter[]
  planItems: PlanItem[]
  tagSuggestions: string[]
  canWrite: boolean
  onNavigate: (documentId: string) => void
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  // La tomografía completa abre su visor; «Detalles» lleva a su ficha de archivo.
  const [details, setDetails] = useState(false)
  const [editing, setEditing] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: cada archivo abre en su vista.
  useEffect(() => {
    setDetails(false)
    setEditing(false)
  }, [doc.id])
  const planById = useMemo(() => new Map(planItems.map((p) => [p.id, p])), [planItems])
  const encounterById = useMemo(() => new Map(encounters.map((e) => [e.id, e])), [encounters])
  const index = sequence.findIndex((d) => d.id === doc.id)
  const previous = index > 0 ? sequence[index - 1] : undefined
  const next = index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : undefined

  if (doc.imaging?.completedAt && !details && !editing) {
    return (
      <TomographyViewer
        patientId={patientId}
        doc={doc}
        open
        canWrite={canWrite}
        onClose={onClose}
        onDetails={() => setDetails(true)}
      />
    )
  }

  return (
    <>
      <Dialog
        open={!editing}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent
          // En el teléfono ocupa toda la pantalla (tablero 5 del lienzo).
          scrollable
          contentClassName="max-md:pb-0"
          className="max-h-[92dvh] sm:max-w-[min(90vw,80rem)] max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-dvh max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none"
          onKeyDown={(event) => {
            if (arrowsBelongToControl(event.target)) return
            if (event.key === "ArrowLeft" && previous) {
              event.preventDefault()
              onNavigate(previous.id)
            } else if (event.key === "ArrowRight" && next) {
              event.preventDefault()
              onNavigate(next.id)
            }
          }}
        >
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <DialogTitle>{doc.label}</DialogTitle>
                <DialogDescription>
                  {imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)} ·{" "}
                  {formatTakenAt(doc)}
                  {doc.toothNumbers.length > 0
                    ? ` · ${doc.toothNumbers.length === 1 ? "Pieza" : "Piezas"} ${doc.toothNumbers.join(", ")}`
                    : ""}
                  {sequence.length > 1 && index >= 0 ? ` · ${index + 1} de ${sequence.length}` : ""}
                </DialogDescription>
              </div>
              <div className="flex gap-2 max-md:hidden">
                {previous && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-keyshortcuts="ArrowLeft"
                    onClick={() => onNavigate(previous.id)}
                  >
                    Anterior
                  </Button>
                )}
                {next && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-keyshortcuts="ArrowRight"
                    onClick={() => onNavigate(next.id)}
                  >
                    Siguiente
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>
          <DocumentViewer
            patientId={patientId}
            doc={doc}
            planItem={doc.planItemId ? planById.get(doc.planItemId) : undefined}
            encounter={doc.encounterId ? encounterById.get(doc.encounterId) : undefined}
            canEdit={canWrite && !doc.retiredAt}
            onEditContext={() => setEditing(true)}
            // Se compara con radiografías y fotos, no con la hoja escaneada de un consentimiento.
            compareCandidates={allDocs.filter(
              (d) =>
                d.id !== doc.id && !d.retiredAt && isImageDoc(d) && isImageCategory(d.category),
            )}
            onChanged={onChanged}
            onRetired={async () => {
              onClose()
              await onChanged()
            }}
          />
          {/* En el teléfono, pasar de una a otra queda fijo abajo, al alcance del pulgar. */}
          {sequence.length > 1 && index >= 0 ? (
            <div className="sticky bottom-0 -mx-6 flex items-center justify-between gap-2 border-t bg-popover px-4 py-3 md:hidden">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!previous}
                onClick={() => previous && onNavigate(previous.id)}
              >
                Anterior
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {index + 1} de {sequence.length}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!next}
                onClick={() => next && onNavigate(next.id)}
              >
                Siguiente
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      {editing && (
        <ContextDrawer
          patientId={patientId}
          doc={doc}
          encounters={encounters}
          planItems={planItems}
          suggestions={tagSuggestions}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
          onSaved={async (updated) => {
            setEditing(false)
            await onChanged()
            if (updated?.id && updated.id !== doc.id) onNavigate(updated.id)
          }}
        />
      )}
    </>
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
  // En el teléfono, los ajustes y los detalles empiezan plegados (tablero 5).
  const phone = useIsMobile()
  const canRead = usePermission("clinical.read")
  // La tomografía no tiene un solo archivo: se abre en su detalle, no por URL.
  const urlQuery = useSignedUrl(patientId, doc.id, "original", !doc.imaging)
  const url = urlQuery.data?.data.url ?? null
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(DEFAULT_ADJUSTMENTS)
  const [compareId, setCompareId] = useState<string>("")
  const [retireOpen, setRetireOpen] = useState(false)
  const [retireReason, setRetireReason] = useState("")
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const retireId = useId()
  const compareSelectId = useId()
  // biome-ignore lint/correctness/useExhaustiveDependencies: otro archivo empieza sin ajustes.
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
      {doc.imaging ? (
        <TomographyDetail
          patientId={patientId}
          doc={doc}
          canUpload={canEdit}
          onChanged={onChanged}
        />
      ) : urlQuery.isPending ? (
        <LoadingState message="Cargando…" />
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
          <AdjustedImage
            src={url}
            alt={doc.label}
            adjustments={adjustments}
            className="max-h-[65vh]"
          />
          {phone ? (
            <details className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">
                Acercar, brillo y contraste
              </summary>
              <div className="pt-2">
                <ImageAdjustControls value={adjustments} onChange={setAdjustments} />
              </div>
            </details>
          ) : (
            <ImageAdjustControls value={adjustments} onChange={setAdjustments} />
          )}
        </div>
      ) : isPdfDoc(doc) ? (
        <embed src={url} type="application/pdf" className="h-[70vh] w-full rounded-md border" />
      ) : isDicomDoc(doc) ? (
        <DicomViewer key={doc.id} patientId={patientId} documentId={doc.id} label={doc.label} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Vista previa no disponible para este tipo de archivo.
        </p>
      )}
      {/* Visor arriba; columna de metadata (plegable en móvil) debajo/al lado. */}
      <div className="flex min-w-0 flex-col gap-3">
        {doc.retiredAt && (
          <div
            role="status"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
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
        {/* Solo lo que la imagen tiene (decisión 10): lo vacío no ocupa lugar y
            se agrega con «Piezas y vínculos». */}
        <details open={!phone} className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Detalles del archivo</summary>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 pt-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Tipo</dt>
              <dd>{imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {doc.capturedAt ? "Tomada" : "Subida"}
              </dt>
              <dd>
                {formatDateTime(doc.capturedAt ?? doc.createdAt)}
                {doc.capturedAt ? (
                  <span className="text-muted-foreground">
                    {" "}
                    (subida {formatDateTime(doc.createdAt)})
                  </span>
                ) : null}
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
                    El informe va como resultado de su orden o en la evolución de la atención.
                  </p>
                )}
              </div>
            )}
            {teeth.length > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  {teeth.length === 1 ? "Pieza" : "Piezas"}
                </dt>
                <dd>{teeth.join(", ")}</dd>
              </div>
            )}
            {tags.length > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">Etiquetas</dt>
                <dd className="flex flex-wrap gap-1">
                  {tags.map((t) => (
                    <Badge key={t} variant="secondary">
                      {t}
                    </Badge>
                  ))}
                </dd>
              </div>
            )}
            {doc.encounterId && (
              <div>
                <dt className="text-xs text-muted-foreground">Atención</dt>
                <dd>
                  <Link
                    to="/patients/$patientId/encounters/$encounterId"
                    params={{ patientId, encounterId: doc.encounterId }}
                    className={linkButton}
                  >
                    {encounter
                      ? `Abrir la atención del ${formatDate(encounter.createdAt)}`
                      : "Abrir la atención"}
                  </Link>
                </dd>
              </div>
            )}
            {doc.planItemId && (
              <div>
                <dt className="text-xs text-muted-foreground">Tratamiento</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId }}
                    search={planSearch}
                    className={linkButton}
                  >
                    {planItem ? `Ver plan: ${planItem.title}` : "Ver plan"}
                  </Link>
                </dd>
              </div>
            )}
            {doc.budgetId && (
              <div>
                <dt className="text-xs text-muted-foreground">Presupuesto</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId }}
                    search={{ tab: "plan", budgetId: doc.budgetId }}
                    className={linkButton}
                  >
                    Ver la propuesta
                  </Link>
                </dd>
              </div>
            )}
            {doc.encounterProcedureId && (
              <div>
                <dt className="text-xs text-muted-foreground">Procedimiento</dt>
                <dd>Unido a un procedimiento de la atención</dd>
              </div>
            )}
            {doc.followUpId && (
              <div>
                <dt className="text-xs text-muted-foreground">Control</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId }}
                    search={{ tab: "plan" }}
                    className={linkButton}
                  >
                    Ver controles
                  </Link>
                </dd>
              </div>
            )}
            {doc.prescriptionId && (
              <div>
                <dt className="text-xs text-muted-foreground">Receta</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId }}
                    search={{ tab: "recetas" }}
                    className={linkButton}
                  >
                    Ver recetas
                  </Link>
                </dd>
              </div>
            )}
            {doc.paymentId && (
              <div>
                <dt className="text-xs text-muted-foreground">Pago</dt>
                <dd>
                  <Link
                    to="/patients/$patientId"
                    params={{ patientId }}
                    search={{ tab: "cuenta" }}
                    className={linkButton}
                  >
                    Ver cuenta
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </details>
        {historyQuery.data && historyQuery.data.length > 1 && (
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Cambios de piezas y vínculos ({historyQuery.data.length} versiones)
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
          {canEdit && (
            <Button size="sm" variant="outline" onClick={onEditContext}>
              {productUi().site ? "Piezas y vínculos" : "Vínculos"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const link = `${window.location.origin}/patients/${patientId}?tab=documentos&documentId=${doc.id}`
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
        description={`Sale de Documentos, ${productUi().site ? "de la historia por pieza" : "de la historia"} y del resumen. No se borra: queda en «Retirados» con tu nombre, la fecha y el motivo. No se puede deshacer.`}
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
  const previewQuery = useSignedUrl(patientId, doc.id, "thumb")
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
      title={`${productUi().site ? "Piezas y vínculos" : "Vínculos"} · ${doc.label}`}
      description={`Se guarda como una versión nueva (ahora v${expectedVersion}); el archivo no cambia.`}
      onSubmit={(e) => void onSubmit(e)}
      isSubmitting={pending}
      submitDisabled={disabled}
      submitLabel="Guardar"
      error={serverError}
    >
      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="sticky top-0 rounded-md border bg-background p-3">
          <p className="mb-2 text-sm font-medium">{doc.label}</p>
          {previewQuery.isPending ? (
            <p>Cargando imagen…</p>
          ) : previewQuery.isError ? (
            <Button type="button" variant="outline" onClick={() => void previewQuery.refetch()}>
              Reintentar vista previa
            </Button>
          ) : (
            previewQuery.data &&
            (isImageDoc(doc) ? (
              <img
                src={previewQuery.data.data.url}
                alt={doc.label}
                className="max-h-[60vh] w-full object-contain"
              />
            ) : isPdfDoc(doc) ? (
              <embed
                src={previewQuery.data.data.url}
                type="application/pdf"
                className="h-[60vh] w-full"
              />
            ) : (
              <a href={previewQuery.data.data.url} target="_blank" rel="noreferrer">
                Abrir archivo original
              </a>
            ))
          )}
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEncounterChoice("")}
              >
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
          <PlacesField value={teeth} onChange={setTeeth} />
          <TagsInput value={tags} onChange={setTags} suggestions={suggestions} />
        </fieldset>
      </div>
    </FormDrawer>
  )
}
