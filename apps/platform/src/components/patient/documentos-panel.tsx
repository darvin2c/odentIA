import {
  Badge,
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { DetailDrawer, EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, FileStack } from "lucide-react"
import { useCallback, useState } from "react"
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
import { DOCUMENT_FILTERS, type DocumentFilter } from "../../lib/patient-areas"
import { documentCategoryLabel } from "../../lib/patient-overview"
import { ageFrom, type PatientDocument, type PatientFull, type PlanItem } from "../../lib/patients"
import { PrescriptionEntry, RecetasPanel } from "./clinical-panels"
import { ConsentSigningScreen } from "./consent-signing"
import { ConsentDetail, NewConsentDrawer } from "./consentimientos-tab"
import { DocumentOpenButton } from "./document-open-button"
import type { NewDocumentKind } from "./encounter-documents"
import { NewResponseDrawer, ResponseDetail } from "./formularios-tab"
import { ImagenesTab } from "./imagenes-tab"
import { NewOrderDrawer, OrderResultDrawer, OrderRow } from "./ordenes-tab"

type Kind = "archivo" | "receta" | "orden" | "formulario" | "consentimiento"
type Tone = "success" | "warning" | "outline" | "secondary"

/** El filtro de tipo de cada papel (las imágenes tienen su galería). */
const FILTER_OF_KIND: Record<Kind, DocumentFilter> = {
  archivo: "imagenes",
  receta: "recetas",
  orden: "ordenes",
  formulario: "formularios",
  consentimiento: "consentimientos",
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
  | { type: "completar" }
  | { type: "ver" }

interface Row {
  key: string
  kind: Kind
  title: string
  detail: string
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
}

const IMAGE_CATEGORIES = new Set(["radiografia", "foto_clinica"])

/**
 * Clínica › Documentos, «buscar un papel» (ADR 0035): una sola lista de lo que
 * la atención emite o adjunta, con filtros por tipo y «Requieren acción».
 * «Nuevo ▾» abre directo el formulario de creación; cada fila lleva su única
 * acción (firmar, subir el resultado, imprimir, completar) y se abre al lado.
 * Las imágenes se ven en su galería, con la comparación.
 */
export function DocumentosSection({
  patientId,
  filter,
  encounterId,
  initialTooth,
  initialDocumentId,
  onFilter,
}: {
  patientId: string
  filter?: DocumentFilter
  /** La atención en curso: lo que se crea aquí queda unido a ella. */
  encounterId?: string
  initialTooth?: number
  initialDocumentId?: string
  /** Cambia el filtro; con una imagen, la abre en su galería. */
  onFilter: (filter: DocumentFilter | undefined, documentId?: string) => void
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState<Exclude<NewDocumentKind, "archivo"> | null>(null)
  const [uploadRequested, setUploadRequested] = useState(false)
  const [opened, setOpened] = useState<Row["open"] | null>(null)
  const [signing, setSigning] = useState<ConsentDocument[] | null>(null)
  const [resultFor, setResultFor] = useState<ClinicalOrder | null>(null)
  const uploadHandled = useCallback(() => setUploadRequested(false), [])

  const files = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
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
  // Para crear: los tratamientos (la receta los ofrece) y los formularios publicados.
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: creating === "receta",
  })
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
        ["prescriptions", patientId],
        ["clinical-orders", patientId],
        ["form-responses", patientId],
        ["consents", patientId],
        ["patient-summary", patientId],
        ["timeline", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
  }

  const startNew = (kind: NewDocumentKind) => {
    setMenuOpen(false)
    if (kind === "archivo") {
      // Las imágenes y los archivos se suben desde su galería, ya filtrada.
      setUploadRequested(true)
      if (filter !== "imagenes") onFilter("imagenes")
      return
    }
    setCreating(kind)
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
    { name: "archivos", query: files },
    { name: "recetas", query: prescriptions },
    { name: "órdenes", query: orders },
    { name: "formularios", query: forms },
    { name: "consentimientos", query: consents },
  ]
  const allPending = sources.every((source) => source.query.isPending)
  const failed = sources.filter((source) => source.query.isError)
  const loading = sources.some((source) => source.query.isPending)

  // El PDF de un consentimiento firmado y la foto de la hoja en papel ya están
  // en su consentimiento: no salen dos veces.
  const consentFileIds = new Set(
    (consents.data?.data ?? []).flatMap(
      (consent) => [consent.pdfDocumentId, consent.paperDocumentId].filter(Boolean) as string[],
    ),
  )
  const pendingSigner = signerWords(patient.data?.data, responsibilities.data?.data)
  const rows: Row[] = [
    ...(files.data?.data ?? [])
      .filter((doc) => !consentFileIds.has(doc.id))
      .map(
        (doc): Row => ({
          key: `archivo-${doc.id}`,
          kind: "archivo",
          title: doc.label,
          detail: [
            documentCategoryLabel(doc.category),
            doc.toothNumbers.length > 0 ? `Pieza ${doc.toothNumbers.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          date: doc.createdAt,
          status: null,
          needsAction: false,
          action: { type: "ver" },
          open: { kind: "archivo", document: doc },
        }),
      ),
    ...(prescriptions.data?.data ?? []).map(
      (item): Row => ({
        key: `receta-${item.id}`,
        kind: "receta",
        title: `Receta N.º ${item.prescriptionNumber}`,
        detail: item.status === "anulada" ? (item.cancelReason ?? "Anulada") : "Emitida",
        date: item.issuedAt,
        status:
          item.status === "anulada"
            ? { label: "Anulada", tone: "outline" }
            : { label: "Vigente", tone: "success" },
        needsAction: false,
        action: item.status === "anulada" ? { type: "ver" } : { type: "imprimir", prescriptionId: item.id },
        open: { kind: "receta", prescription: item },
      }),
    ),
    ...(orders.data?.data ?? []).map((order): Row => {
      const open = order.status === "solicitado" || order.status === "en_proceso"
      return {
        key: `orden-${order.id}`,
        kind: "orden",
        title: `${ORDER_KIND_TITLES[order.kind]} · ${order.title}`,
        detail:
          order.status === "solicitado"
            ? `Pedida el ${formatDate(order.createdAt)} · sin resultado`
            : `Para ${order.recipient}`,
        date: order.createdAt,
        status: {
          label: ORDER_STATUS_LABELS[order.status],
          tone: order.status === "completado" ? "success" : order.status === "cancelado" ? "outline" : "warning",
        },
        needsAction: open,
        action: open && canWrite ? { type: "resultado", order } : { type: "ver" },
        open: { kind: "orden", order },
      }
    }),
    ...(forms.data?.data ?? [])
      .filter((response) => response.status !== "descartado")
      .map(
        (response): Row => ({
          key: `formulario-${response.id}`,
          kind: "formulario",
          title: `Formulario · ${response.templateTitle ?? "Formulario clínico"}`,
          detail:
            response.status === "finalizado"
              ? "Finalizado"
              : response.submittedAt
                ? "Lo declaró la persona · por revisar"
                : "Sin finalizar",
          date: response.finalizedAt ?? response.createdAt,
          status:
            response.status === "finalizado"
              ? { label: "Finalizado", tone: "success" }
              : { label: "Borrador", tone: "warning" },
          needsAction: response.status === "borrador",
          action: response.status === "borrador" && canWrite ? { type: "completar" } : { type: "ver" },
          open: { kind: "formulario", response },
        }),
      ),
    ...(consents.data?.data ?? []).map(
      (consent): Row => ({
        key: `consentimiento-${consent.id}`,
        kind: "consentimiento",
        title: `Consentimiento · ${consent.titleSnapshot}`,
        detail:
          consent.status === "pendiente"
            ? pendingSigner
              ? `Falta la firma de ${pendingSigner}`
              : "Falta la firma"
            : `Firma: ${consent.signerName}`,
        date: consent.signedAt ?? consent.createdAt,
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
        action: consent.status === "pendiente" && canWrite ? { type: "firmar", consent } : { type: "ver" },
        open: { kind: "consentimiento", consent },
      }),
    ),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const pendingCount = rows.filter((row) => row.needsAction).length
  const visible = rows.filter((row) =>
    !filter ? true : filter === "requieren" ? row.needsAction : FILTER_OF_KIND[row.kind] === filter,
  )

  const actionButton = (row: Row) => {
    const { action } = row
    switch (action.type) {
      case "firmar":
        return (
          <Button type="button" size="sm" onClick={() => setSigning([action.consent])}>
            Firmar
          </Button>
        )
      case "resultado":
        return (
          <Button type="button" size="sm" onClick={() => setResultFor(action.order)}>
            Subir resultado
          </Button>
        )
      case "imprimir":
        return (
          <Link
            to="/patients/$patientId/prescriptions/$prescriptionId/print"
            params={{ patientId, prescriptionId: action.prescriptionId }}
            target="_blank"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir
          </Link>
        )
      case "completar":
        return (
          <Button type="button" size="sm" onClick={() => setOpened(row.open)}>
            Completar
          </Button>
        )
      case "ver":
        return row.open.kind === "archivo" ? (
          IMAGE_CATEGORIES.has(row.open.document.category) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onFilter("imagenes", row.open.kind === "archivo" ? row.open.document.id : undefined)}
            >
              Ver en la galería
            </Button>
          ) : (
            <DocumentOpenButton patientId={patientId} documentId={row.open.document.id} label="Ver" />
          )
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpened(row.open)}>
            Ver
          </Button>
        )
    }
  }

  const chips = (
    <fieldset className="m-0 flex max-w-full min-w-0 flex-wrap gap-2 border-0 p-0">
      <legend className="sr-only">Filtrar documentos</legend>
      {DOCUMENT_FILTERS.map((option) => {
        const active = filter === option.id
        return (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            aria-pressed={active}
            onClick={() => onFilter(active ? undefined : option.id)}
          >
            {option.id === "requieren" ? `${option.label} · ${pendingCount}` : option.label}
          </Button>
        )
      })}
    </fieldset>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Buscar un papel</p>
        {newMenu}
      </div>
      {chips}

      {filter === "imagenes" ? (
        <ImagenesTab
          patientId={patientId}
          encounterId={encounterId}
          initialTooth={initialTooth}
          initialDocumentId={initialDocumentId}
          openUpload={uploadRequested}
          onUploadHandled={uploadHandled}
          showUploadButton={false}
          onUploaded={refresh}
        />
      ) : allPending ? (
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

          {rows.length === 0 && !loading && failed.length === 0 ? (
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
              title="Sin resultados"
              description="Ningún papel coincide con el filtro elegido."
              actionLabel="Ver todos"
              onAction={() => onFilter(undefined)}
            />
          ) : (
            <ul className="flex flex-col divide-y elevated rounded-xl border bg-card px-4 sm:px-6">
              {visible.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  {row.open.kind === "archivo" ? (
                    // Un archivo se abre con su botón (la galería o el visor).
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="break-words font-medium">{row.title}</span>
                      <span className="break-words text-muted-foreground">
                        {formatDate(row.date)}
                        {row.detail ? ` · ${row.detail}` : ""}
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setOpened(row.open)}
                    >
                      <span className="break-words font-medium">{row.title}</span>
                      <span className="break-words text-muted-foreground">
                        {formatDate(row.date)}
                        {row.detail ? ` · ${row.detail}` : ""}
                      </span>
                    </button>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {row.status ? <Badge variant={row.status.tone}>{row.status.label}</Badge> : null}
                    {actionButton(row)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {loading ? <p className="text-sm text-muted-foreground">Cargando el resto…</p> : null}
        </>
      )}

      <OpenedDocument
        patientId={patientId}
        opened={opened}
        canWrite={canWrite}
        onClose={() => setOpened(null)}
        onChanged={refresh}
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
  if (!opened || opened.kind === "archivo") return null
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
            (consents.data?.data ?? []).find((row) => row.id === opened.consent.id) ?? opened.consent
          }
          canWrite={canWrite}
          onChanged={onChanged}
        />
      ) : opened.kind === "orden" ? (
        <OrderRow
          order={(orders.data?.data ?? []).find((row) => row.id === opened.order.id) ?? opened.order}
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
