import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { FileStack } from "lucide-react"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import {
  CONSENT_STATUS_LABELS,
  fetchConsents,
  fetchFormResponses,
  fetchFormTemplates,
  fetchOrders,
  ORDER_STATUS_LABELS,
} from "../../lib/clinical-forms"
import { fetchPrescriptions, formatDate } from "../../lib/clinical-journey"
import type { PatientSectionId } from "../../lib/patient-areas"
import { documentCategoryLabel } from "../../lib/patient-overview"
import type { PatientDocument } from "../../lib/patients"

type Kind = "archivo" | "receta" | "orden" | "formulario" | "consentimiento"
type Tone = "success" | "warning" | "outline" | "secondary"

const KINDS: Array<{ id: Kind; label: string; plural: string; section: PatientSectionId; create: string }> = [
  { id: "archivo", label: "Archivo", plural: "Imágenes y archivos", section: "imagenes", create: "Subir imagen o archivo" },
  { id: "receta", label: "Receta", plural: "Recetas", section: "recetas", create: "Emitir receta" },
  { id: "orden", label: "Orden", plural: "Órdenes", section: "ordenes", create: "Crear orden" },
  { id: "formulario", label: "Formulario", plural: "Formularios", section: "formularios", create: "Llenar formulario" },
  { id: "consentimiento", label: "Consentimiento", plural: "Consentimientos", section: "consentimientos", create: "Crear consentimiento" },
]

interface Row {
  key: string
  kind: Kind
  title: string
  detail: string
  date: string
  status: { label: string; tone: Tone } | null
  /** Queda algo por hacer sobre el documento (firmar, completar, recibir resultado). */
  needsAction: boolean
  documentId?: string
}

/**
 * Índice único de lo que la atención emite o adjunta. Cada tipo conserva su
 * panel para crear y gestionar (pestañas contiguas); aquí se encuentra todo en
 * una sola lista cronológica, filtrable por lo que aún requiere acción.
 */
export function DocumentosPanel({
  patientId,
  onOpen,
}: {
  patientId: string
  onOpen: (section: PatientSectionId, documentId?: string) => void
}) {
  const [onlyPending, setOnlyPending] = useState(false)

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
  const templates = useQuery({
    queryKey: ["form-templates-all"],
    queryFn: () => fetchFormTemplates(),
  })
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
  })

  const sources = [
    { name: "archivos", query: files },
    { name: "recetas", query: prescriptions },
    { name: "órdenes", query: orders },
    { name: "formularios", query: forms },
    { name: "consentimientos", query: consents },
  ]
  if (sources.every((source) => source.query.isPending))
    return <LoadingState message="Cargando documentos…" />
  const failed = sources.filter((source) => source.query.isError)
  const loading = sources.some((source) => source.query.isPending)

  const templateTitle = new Map(
    (templates.data?.data ?? []).map((template) => [template.id, template.title]),
  )
  const rows: Row[] = [
    ...(files.data?.data ?? []).map(
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
        documentId: doc.id,
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
      }),
    ),
    ...(orders.data?.data ?? []).map(
      (order): Row => ({
        key: `orden-${order.id}`,
        kind: "orden",
        title: order.title,
        detail: `${order.kind === "laboratorio" ? "Laboratorio" : "Interconsulta"} · ${order.recipient}`,
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
        needsAction: order.status === "solicitado" || order.status === "en_proceso",
      }),
    ),
    ...(forms.data?.data ?? []).map(
      (response): Row => ({
        key: `formulario-${response.id}`,
        kind: "formulario",
        title: templateTitle.get(response.templateId) ?? "Formulario clínico",
        detail: response.status === "finalizado" ? "Finalizado" : "Borrador sin finalizar",
        date: response.finalizedAt ?? response.createdAt,
        status:
          response.status === "finalizado"
            ? { label: "Finalizado", tone: "success" }
            : { label: "Borrador", tone: "warning" },
        needsAction: response.status === "borrador",
      }),
    ),
    ...(consents.data?.data ?? []).map(
      (consent): Row => ({
        key: `consentimiento-${consent.id}`,
        kind: "consentimiento",
        title: consent.titleSnapshot,
        detail:
          consent.status === "pendiente"
            ? `Falta la firma de ${consent.signerKind === "representante" ? "la persona representante" : "el paciente"}`
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
      }),
    ),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const pendingCount = rows.filter((row) => row.needsAction).length
  const visible = rows.filter((row) => !onlyPending || row.needsAction)
  const kindOf = (id: Kind) => KINDS.find((item) => item.id === id) as (typeof KINDS)[number]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows.length} documento{rows.length === 1 ? "" : "s"} en total. Las pestañas de arriba
          abren la gestión de cada tipo.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={onlyPending ? "default" : "outline"}
            aria-pressed={onlyPending}
            disabled={pendingCount === 0 && !onlyPending}
            onClick={() => setOnlyPending((value) => !value)}
          >
            Requieren acción ({pendingCount})
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" />}>Nuevo</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {KINDS.map((item) => (
                <DropdownMenuItem key={item.id} onClick={() => onOpen(item.section)}>
                  {item.create}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {failed.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm"
        >
          <span>
            No se pudieron cargar: {failed.map((source) => source.name).join(", ")}. La lista está
            incompleta.
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

      {visible.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title={rows.length === 0 ? "Sin documentos" : "Sin resultados"}
          description={
            rows.length === 0
              ? "Aún no hay recetas, órdenes, formularios, consentimientos ni archivos de este paciente."
              : "Ningún documento coincide con el filtro elegido."
          }
        />
      ) : (
        <ul className="flex flex-col divide-y elevated rounded-xl border bg-card px-6">
          {visible.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="break-words font-medium">{row.title}</span>
                <span className="break-words text-muted-foreground">
                  {kindOf(row.kind).label} · {formatDate(row.date)}
                  {row.detail ? ` · ${row.detail}` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {row.status ? <Badge variant={row.status.tone}>{row.status.label}</Badge> : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onOpen(kindOf(row.kind).section, row.documentId)}
                >
                  Abrir en {kindOf(row.kind).plural.toLowerCase()}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {loading ? <p className="text-sm text-muted-foreground">Cargando el resto…</p> : null}
    </div>
  )
}
