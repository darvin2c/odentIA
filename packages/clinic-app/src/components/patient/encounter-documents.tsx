import { medicalLeaveWords } from "@odentia/clinical"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@odentia/ui"
import { DetailDrawer, RowActions } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  type ConsentDocument,
  consentSignatureWords,
  fetchConsents,
  fetchFormResponses,
  fetchFormTemplates,
  fetchOrders,
  FORM_RESPONSE_STATUS_LABELS,
} from "../../lib/clinical-forms"
import { fetchPrescriptionDetail, fetchPrescriptions, type Prescription } from "../../lib/clinical-journey"
import type { ClinicalOrder } from "../../lib/clinical-forms"
import type { MedicalLeave } from "../../lib/medical-leaves"
import { sendConsentByLink } from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import {
  type ConsentNeed,
  fetchConsentNeeds,
  prepareConsents,
} from "../../lib/encounter-documents"
import type { Encounter, EncounterDetail, PatientFull, PlanItem } from "../../lib/patients"
import { RecetasPanel } from "./clinical-panels"
import { ConsentSigningScreen, PaperSignDrawer } from "./consent-signing"
import { NewConsentDrawer } from "./consentimientos-tab"
import { DocumentOpenButton } from "./document-open-button"
import { DocumentUploadDialog } from "./document-upload-dialog"
import { NewResponseDrawer, ResponseDetail } from "./formularios-tab"
import { ConsentPaper, MedicalLeavePaper, OrderPaper, PrescriptionPaper } from "./document-papers"
import { NewOrderDrawer, OrderRow } from "./ordenes-tab"
import { NewMedicalLeaveDrawer } from "./medical-leave"
import { fetchMedicalLeaves } from "../../lib/medical-leaves"
import { productUi } from "../../product/product-ui"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"

const errorMessage = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (e.shape.message ?? fallback) : fallback

export type NewDocumentKind = "receta" | "descanso" | "consentimiento" | "orden" | "formulario" | "archivo"

const NEW_DOCUMENT_OPTIONS: Array<{ kind: NewDocumentKind; label: string }> = [
  { kind: "receta", label: "Receta" },
  { kind: "consentimiento", label: "Consentimiento" },
  { kind: "orden", label: "Orden" },
  { kind: "formulario", label: "Formulario" },
  { kind: "archivo", label: "Imagen o archivo" },
]

/** Lo que se crea desde «Nuevo»: con el descanso médico, junto a la receta, si el producto lo emite. */
export function newDocumentOptions(): Array<{ kind: NewDocumentKind; label: string }> {
  if (!productUi().documents.medicalLeave) return NEW_DOCUMENT_OPTIONS
  return NEW_DOCUMENT_OPTIONS.flatMap((option) =>
    option.kind === "receta" ? [option, { kind: "descanso" as const, label: "Descanso médico" }] : [option],
  )
}

/**
 * Todo lo que la atención emite o adjunta, en un solo lugar (ADR 0033): lo
 * que pide en consentimientos, sus consentimientos, órdenes, recetas,
 * formularios, imágenes y archivos. Una sola lectura para el bloque, su
 * resumen y el cierre: React Query comparte las consultas.
 */
export function useEncounterDocuments(patientId: string, encounterId: string, detail: EncounterDetail) {
  const canRead = usePermission("clinical.read")
  const needs = useQuery({
    queryKey: ["consent-needs", patientId, encounterId],
    queryFn: () => fetchConsentNeeds(patientId, encounterId),
    enabled: canRead,
  })
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canRead,
  })
  const orders = useQuery({
    queryKey: ["clinical-orders", patientId, "encounter", encounterId],
    queryFn: () => fetchOrders({ patientId, encounterId }),
    enabled: canRead,
  })
  const prescriptions = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
    enabled: canRead,
  })
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: canRead,
  })
  const leaves = useQuery({
    queryKey: ["medical-leaves", patientId],
    queryFn: () => fetchMedicalLeaves(patientId),
    enabled: canRead && productUi().documents.medicalLeave,
  })
  const ownConsents = (consents.data?.data ?? []).filter(
    (doc) => doc.encounterId === encounterId && (doc.status === "pendiente" || doc.status === "firmado"),
  )
  // El PDF de un consentimiento firmado y la foto de una hoja en papel ya están
  // en su consentimiento: no salen dos veces.
  const consentFileIds = new Set(
    (consents.data?.data ?? []).flatMap((doc) => [doc.pdfDocumentId, doc.revokePdfDocumentId, doc.paperDocumentId].filter(Boolean) as string[]),
  )
  const files = detail.documents.filter((doc) => !doc.retiredAt && !consentFileIds.has(doc.id))
  const ownOrders = (orders.data?.data ?? []).filter((order) => order.encounterId === encounterId)
  const ownPrescriptions = (prescriptions.data?.data ?? []).filter(
    (rx) => rx.encounterId === encounterId && rx.status === "emitida",
  )
  const ownForms = (forms.data?.data ?? []).filter(
    (form) => form.encounterId === encounterId && form.status !== "descartado",
  )
  const ownLeaves = (leaves.data?.data ?? []).filter(
    (leave) => leave.encounterId === encounterId && leave.status === "emitido",
  )
  const needList = needs.data?.data ?? []
  const pendingSignatures = ownConsents.filter((doc) => doc.status === "pendiente")
  return {
    needs: needList,
    toPrepare: needList.filter((need) => need.status === "sin_preparar"),
    unpublished: needList.filter((need) => need.status === "sin_publicar"),
    consents: ownConsents,
    pendingSignatures,
    orders: ownOrders,
    prescriptions: ownPrescriptions,
    forms: ownForms,
    leaves: ownLeaves,
    files,
    total:
      ownConsents.length + ownOrders.length + ownPrescriptions.length + ownLeaves.length + ownForms.length + files.length,
    isLoading: needs.isPending || consents.isPending,
  }
}

/** El papel que se abre al lado con «Ver»: su PDF, con «Enviar» e «Imprimir». */
type ViewedPaper =
  | { kind: "consent"; document: ConsentDocument }
  | { kind: "prescription"; prescription: Prescription }
  | { kind: "order"; order: ClinicalOrder }
  | { kind: "leave"; leave: MedicalLeave }

function firstName(patient: PatientFull): string {
  return (patient.patient.givenNames ?? patient.patient.displayName).trim().split(/\s+/)[0] ?? ""
}

export function EncounterDocumentsBlock({
  patientId,
  encounterId,
  patient,
  detail,
  encounters,
  attentionItems,
  disabled,
  beforeWrite,
  onChanged,
  onPendingChange,
  openMenu = false,
  onMenuHandled,
}: {
  patientId: string
  encounterId: string
  patient: PatientFull
  detail: EncounterDetail
  /** Atenciones de la persona (para subir un archivo unido a esta). */
  encounters: Encounter[]
  /** Tratamientos de la atención, para la receta. */
  attentionItems: PlanItem[]
  disabled: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  onPendingChange: (pending: boolean) => void
  /** Recién agregado: abre «Nuevo ▾» sin un clic de más. */
  openMenu?: boolean
  onMenuHandled?: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const docs = useEncounterDocuments(patientId, encounterId, detail)
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState<NewDocumentKind | null>(null)
  const [signing, setSigning] = useState<ConsentDocument[] | null>(null)
  const [paper, setPaper] = useState<ConsentDocument | null>(null)
  const [viewing, setViewing] = useState<ViewedPaper | null>(null)
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [paperFor, setPaperFor] = useState<ConsentNeed | null>(null)

  useEffect(() => {
    if (openMenu && !disabled) {
      setMenuOpen(true)
      onMenuHandled?.()
    }
  }, [openMenu, disabled, onMenuHandled])

  const formTemplates = useQuery({
    queryKey: ["form-templates-published", "mine-first"],
    queryFn: () => fetchFormTemplates({ status: "publicado", forUser: "me" }),
    enabled: creating === "formulario",
  })

  const refresh = async () => {
    await Promise.all(
      [
        ["consent-needs", patientId],
        ["consents", patientId],
        ["clinical-orders", patientId],
        ["prescriptions", patientId],
        ["medical-leaves", patientId],
        ["form-responses", patientId],
        ["encounter-closing", patientId, encounterId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
    await onChanged()
  }

  const prepare = useMutation({
    mutationFn: async (keys?: string[]) => {
      await beforeWrite()
      return prepareConsents(patientId, encounterId, keys)
    },
    onSuccess: async (result) => {
      await refresh()
      const created = result.data.created.map((row) => row.id)
      if (created.length > 0) toast.success(created.length === 1 ? "Consentimiento preparado" : `${created.length} consentimientos preparados`)
    },
    onError: (e) => toast.error(errorMessage(e, "No se pudo preparar el consentimiento")),
  })

  // Lo registrado y su diagnóstico, para llenar lo que se crea desde aquí.
  const activeProcedures = detail.procedures.filter((proc) => !proc.voidedAt)
  const procedureRef = activeProcedures
    .map((proc) => `${proc.description}${proc.toothNumber != null ? ` · pieza ${proc.toothNumber}` : ""}`)
    .join(", ")
    .slice(0, 500)
  const firstActive = (detail.diagnoses ?? []).find((dx) => !dx.voidedAt)
  const firstDiagnosis = firstActive?.diagnosisCode
  const firstDiagnosisSystem = firstActive?.diagnosisSystem
  const who = firstName(patient)

  const startNew = (kind: NewDocumentKind) => {
    setMenuOpen(false)
    // «Consentimiento» con algo por preparar lo prepara lleno, sin preguntar.
    if (kind === "consentimiento" && docs.toPrepare.length > 0) {
      prepare.mutate(undefined)
      return
    }
    setCreating(kind)
  }

  const pendingTitles = docs.pendingSignatures.map((doc) => doc.titleSnapshot)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Receta, consentimiento, orden, formulario o imagen, llenos con lo de esta atención.
        </p>
        {canWrite ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button type="button" size="sm" disabled={disabled}>
                  Nuevo <ChevronDown aria-hidden className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {newDocumentOptions().map((option) => (
                <DropdownMenuItem key={option.kind} onClick={() => startNew(option.kind)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {docs.toPrepare.length > 0 ? (
        <section
          aria-label="Necesita consentimiento"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3"
        >
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">
              Necesita consentimiento · {docs.toPrepare.map((need) => need.title).join(" y ")}
            </span>
            <span className="text-xs text-muted-foreground">
              Por {[...new Set(docs.toPrepare.flatMap((need) => need.services))].join(", ")}
            </span>
          </div>
          <Button type="button" size="sm" disabled={disabled || prepare.isPending} onClick={() => prepare.mutate(undefined)}>
            {prepare.isPending ? "Preparando…" : "Preparar"}
          </Button>
        </section>
      ) : null}

      {docs.unpublished.map((need) => (
        <section
          key={need.templateKey}
          aria-label="Consentimiento sin publicar"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">
              Esta clínica aún no publicó el consentimiento de «{need.title}»
            </span>
            <span className="text-xs text-muted-foreground">
              Fírmalo en papel y sube la foto; quien configura lo verá en «Te espera» para publicarlo.
            </span>
          </div>
          {canWrite ? (
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setPaperFor(need)}>
              Subir la hoja firmada
            </Button>
          ) : null}
        </section>
      ))}

      <ul className="flex flex-col divide-y rounded-lg border">
        {docs.pendingSignatures.length > 0 ? (
          <li className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">
                {pendingTitles.length === 1 ? "Consentimiento" : "Consentimientos"} · {pendingTitles.join(" y ")}
              </span>
              <span className="text-xs text-muted-foreground">
                {pendingTitles.length === 1 ? `Falta la firma de ${who}` : `Faltan las firmas de ${who}`}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" size="sm" disabled={disabled} onClick={() => setSigning(docs.pendingSignatures.filter((doc) => !doc.personSignedAt))}>
                Firmar ahora
              </Button>
              <RowActions
                label="Otras formas de firmar"
                items={docs.pendingSignatures.flatMap((doc) => [
                  ...(doc.linkSentAt || doc.personSignedAt
                    ? []
                    : [
                        {
                          key: `link-${doc.id}`,
                          label: `Enviar para firmar desde su teléfono: ${doc.titleSnapshot}`,
                          disabled,
                          onSelect: () =>
                            void sendConsentByLink(doc.id, crypto.randomUUID())
                              .then(() => {
                                toast.success("Se lo enviamos: aparece en «Su enlace»")
                                return refresh()
                              })
                              .catch((error: unknown) =>
                                toast.error(error instanceof ApiError ? (error.shape.message ?? "No se pudo enviar") : "No se pudo enviar"),
                              ),
                        },
                      ]),
                  {
                    key: `paper-${doc.id}`,
                    label: `Firmado en papel: ${doc.titleSnapshot}`,
                    disabled,
                    onSelect: () => setPaper(doc),
                  },
                  {
                    key: `print-${doc.id}`,
                    label: `Imprimir para firmar en papel: ${doc.titleSnapshot}`,
                    onSelect: () => setViewing({ kind: "consent", document: doc }),
                  },
                ])}
              />
            </div>
          </li>
        ) : null}
        {/* Lo que se le envió a firmar desde su enlace: espera su firma o tu confirmación. */}
        {docs.pendingSignatures
          .filter((doc) => doc.linkSentAt || doc.personSignedAt)
          .map((doc) => (
            <li key={`enlace-${doc.id}`} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Consentimiento · {doc.titleSnapshot}</span>
                <span className="text-xs text-muted-foreground">{consentLinkWords(doc)}</span>
              </div>
              {canWrite ? <ConsentLinkActions document={doc} onChanged={refresh} /> : null}
            </li>
          ))}
        {docs.consents
          .filter((doc) => doc.status === "firmado")
          .map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Consentimiento · {doc.titleSnapshot}</span>
                <span className="text-xs text-muted-foreground">Firmado · {consentSignatureWords(doc)}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Ver ${doc.titleSnapshot}`}
                onClick={() => setViewing({ kind: "consent", document: doc })}
              >
                Ver
              </Button>
            </li>
          ))}
        {docs.orders.map((order) => (
          <li key={order.id} className="p-3">
            <OrderRow order={order} onView={() => setViewing({ kind: "order", order })} />
          </li>
        ))}
        {docs.prescriptions.map((rx) => (
          <PrescriptionRow
            key={rx.id}
            patientId={patientId}
            prescription={rx}
            onView={() => setViewing({ kind: "prescription", prescription: rx })}
          />
        ))}
        {docs.leaves.map((leave) => (
          <li key={leave.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Descanso médico N.º {leave.leaveNumber}</span>
              <span className="text-xs text-muted-foreground">{medicalLeaveWords(leave.startsOn, leave.days)}</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Ver descanso médico N.º ${leave.leaveNumber}`}
              onClick={() => setViewing({ kind: "leave", leave })}
            >
              Ver
            </Button>
          </li>
        ))}
        {docs.forms.map((form) => (
          <li key={form.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Formulario · {form.templateTitle ?? "Formulario"}</span>
              <span className="text-xs text-muted-foreground">{FORM_RESPONSE_STATUS_LABELS[form.status]}</span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpenForm(form.id)}>
              {form.status === "borrador" ? "Completar" : "Ver"}
            </Button>
          </li>
        ))}
        {docs.files.map((file) => (
          <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="break-words text-sm font-medium">{file.label}</span>
              <span className="text-xs text-muted-foreground">Imagen o archivo de esta atención</span>
            </div>
            <DocumentOpenButton patientId={patientId} documentId={file.id} label="Ver" />
          </li>
        ))}
        {docs.total === 0 && docs.pendingSignatures.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">
            Aún no hay documentos en esta atención. Usa «Nuevo» para crear uno.
          </li>
        ) : null}
      </ul>

      {/* Lo que se crea desde «Nuevo», ya lleno con lo de la atención. */}
      {creating === "receta" ? (
        <RecetasPanel
          patientId={patientId}
          encounterId={encounterId}
          encounterOnly
          items={attentionItems}
          drawerOnly
          createOpen
          defaultDiagnosisCode={firstDiagnosis}
          defaultDiagnosisSystem={firstDiagnosisSystem}
          onCreateOpenChange={(open) => {
            if (!open) {
              setCreating(null)
              void refresh()
            }
          }}
        />
      ) : null}
      {creating === "descanso" ? (
        <NewMedicalLeaveDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          defaultDiagnosisCode={firstDiagnosis}
          defaultDiagnosisSystem={firstDiagnosisSystem}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null)
            void refresh()
          }}
        />
      ) : null}
      {creating === "consentimiento" ? (
        <NewConsentDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          defaultProcedureRef={procedureRef}
          defaultDiagnosisCode={firstDiagnosis}
          defaultDiagnosisSystem={firstDiagnosisSystem}
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
          defaultDiagnosisCode={firstDiagnosis}
          defaultDiagnosisSystem={firstDiagnosisSystem}
          onClose={() => setCreating(null)}
          onCreated={(order) => {
            setCreating(null)
            void refresh()
            // Al crearla se abre su papel: ahí se envía o se imprime.
            setViewing({ kind: "order", order })
          }}
        />
      ) : null}
      {creating === "formulario" ? (
        <NewResponseDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          defaultProfessionalUserId={detail.encounter.professionalUserId}
          templates={(formTemplates.data?.data ?? []).filter((t) => t.respondent !== "portal")}
          onClose={() => setCreating(null)}
          onCreated={async (id) => {
            setCreating(null)
            await refresh()
            setOpenForm(id)
          }}
        />
      ) : null}
      <DocumentUploadDialog
        patientId={patientId}
        defaultEncounterId={encounterId}
        encounters={encounters}
        planItems={attentionItems}
        suggestions={[]}
        open={creating === "archivo"}
        onOpenChange={(open) => {
          if (!open) setCreating(null)
        }}
        onSuccess={refresh}
        beforeWrite={beforeWrite}
        onPendingChange={onPendingChange}
        disabled={disabled}
      />
      <DocumentUploadDialog
        patientId={patientId}
        defaultEncounterId={encounterId}
        encounters={encounters}
        planItems={attentionItems}
        suggestions={paperFor ? [`Hoja firmada: ${paperFor.title}`] : []}
        open={paperFor !== null}
        onOpenChange={(open) => {
          if (!open) setPaperFor(null)
        }}
        onSuccess={refresh}
        beforeWrite={beforeWrite}
        onPendingChange={onPendingChange}
        disabled={disabled}
      />

      <ConsentSigningScreen
        open={signing !== null}
        documents={signing ?? []}
        patientId={patientId}
        onClose={() => setSigning(null)}
        onSigned={refresh}
      />
      <PaperSignDrawer
        open={paper !== null}
        document={paper}
        patientId={patientId}
        encounterId={encounterId}
        onClose={() => setPaper(null)}
        onSigned={refresh}
      />
      {viewing?.kind === "consent" ? (
        <ConsentPaper
          document={docs.consents.find((doc) => doc.id === viewing.document.id) ?? viewing.document}
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : viewing?.kind === "prescription" ? (
        <PrescriptionPaper
          patientId={patientId}
          prescription={docs.prescriptions.find((rx) => rx.id === viewing.prescription.id) ?? viewing.prescription}
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : viewing?.kind === "order" ? (
        <OrderPaper
          order={docs.orders.find((order) => order.id === viewing.order.id) ?? viewing.order}
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : viewing?.kind === "leave" ? (
        <MedicalLeavePaper
          patientId={patientId}
          leave={docs.leaves.find((leave) => leave.id === viewing.leave.id) ?? viewing.leave}
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : null}
      <FormDetail
        patientId={patientId}
        responseId={openForm}
        canWrite={canWrite && !disabled}
        onClose={() => setOpenForm(null)}
        onChanged={refresh}
      />
    </div>
  )
}

/** «Receta · Paracetamol 500 mg · Cada 8 h por 3 días», con «Ver». */
function PrescriptionRow({
  patientId,
  prescription,
  onView,
}: {
  patientId: string
  prescription: Prescription
  onView: () => void
}) {
  const detail = useQuery({
    queryKey: ["prescription", patientId, prescription.id],
    queryFn: () => fetchPrescriptionDetail(patientId, prescription.id),
  })
  const first = detail.data?.data.items?.[0]
  const more = (detail.data?.data.items?.length ?? 1) - 1
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">
          Receta ·{" "}
          {first
            ? `${first.genericName ?? first.medicationName}${first.strength ? ` ${first.strength}` : ""}${more > 0 ? ` y ${more} más` : ""}`
            : `N.º ${prescription.prescriptionNumber}`}
        </span>
        {first ? (
          <span className="text-xs text-muted-foreground">
            {first.frequency} por {first.duration}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Ver receta N.º ${prescription.prescriptionNumber}`}
        onClick={onView}
      >
        Ver
      </Button>
    </li>
  )
}

/** Un formulario de la atención se completa al lado, sin salir. */
function FormDetail({
  patientId,
  responseId,
  canWrite,
  onClose,
  onChanged,
}: {
  patientId: string
  responseId: string | null
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: responseId !== null,
  })
  const response = (forms.data?.data ?? []).find((row) => row.id === responseId) ?? null
  return (
    <DetailDrawer
      open={responseId !== null && response !== null}
      title={response?.templateTitle ?? "Formulario"}
      description="Se guarda solo mientras lo completas."
      onClose={onClose}
    >
      {response ? <ResponseDetail key={response.id} response={response} canWrite={canWrite} onChanged={onChanged} /> : null}
    </DetailDrawer>
  )
}
