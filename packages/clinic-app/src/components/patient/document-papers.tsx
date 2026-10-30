import { medicalLeaveWords } from "@odentia/clinical"
import { Button, Field, FieldLabel, Textarea, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, FormDrawer, type RowActionItem } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useId, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  BUDGET_SENDABLE_STATUSES,
  budgetNumberLabel,
  type BudgetWithTotals,
} from "../../lib/budgets"
import {
  cancelConsent,
  type ClinicalOrder,
  CONSENT_STATUS_LABELS,
  type ConsentDocument,
  consentSignatureWords,
  fetchConsentHistory,
  ORDER_KIND_TITLES,
  ORDER_STATUS_LABELS,
} from "../../lib/clinical-forms"
import {
  cancelPrescriptionApi,
  formatDate,
  mutationMessage,
  type Prescription,
  PRESCRIPTION_STATUS_LABELS,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { cancelMedicalLeaveApi, type MedicalLeave } from "../../lib/medical-leaves"
import { appWords } from "../../lib/product-words"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import { ConsentSigningScreen, PaperSignDrawer } from "./consent-signing"
import { CONSENT_EVENT_LABELS, RevokeForm } from "./consentimientos-tab"
import { DocumentPaperPanel } from "./document-paper-panel"
import { HealthDocumentSendDrawer } from "./health-document-send"
import { OrderCancelDrawer, OrderResultDrawer } from "./ordenes-tab"
import { BudgetReviewDrawer } from "./plan/budget-review"

/** Lo que todo papel recibe: en la superficie lateral o en su propia dirección. */
interface PaperSurface {
  page?: boolean
  onClose?: () => void
  /** Avisa a quien lo abrió (su lista) además de lo que el papel refresca solo. */
  onChanged?: () => void | Promise<void>
}

/** Lo que se refresca cuando un papel cambia de estado. */
function useRefreshPapers(patientId: string, onChanged?: () => void | Promise<void>) {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all(
      [
        ["prescriptions", patientId],
        ["prescription", patientId],
        ["medical-leaves", patientId],
        ["clinical-orders", patientId],
        ["consents", patientId],
        ["treatment-journey", patientId],
        ["timeline", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
    await onChanged?.()
  }
}

/** Anular con motivo: la receta o el descanso conservan su contenido y quedan con sello. */
function CancelWithReason({
  title,
  description,
  mutationFn,
  onClose,
  onDone,
}: {
  title: string
  description: string
  mutationFn: (reason: string) => Promise<unknown>
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const uid = useId()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const cancel = useMutation({
    mutationFn: () => mutationFn(reason.trim()),
    onSuccess: async () => {
      await onDone()
      onClose()
    },
    onError: (cause) => setError(mutationMessage(cause)),
  })
  return (
    <FormDrawer
      dock={false}
      open
      title={title}
      description={description}
      error={error}
      isSubmitting={cancel.isPending}
      submitLabel={title}
      onClose={() => {
        if (!cancel.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setError("Indica el motivo de la anulación.")
          return
        }
        setError(null)
        cancel.mutate()
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${uid}-reason`}>Motivo de anulación</FieldLabel>
        <Textarea
          id={`${uid}-reason`}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </FormDrawer>
  )
}

export function PrescriptionPaper({
  patientId,
  prescription,
  page,
  onClose,
  onChanged,
}: PaperSurface & { patientId: string; prescription: Prescription }) {
  const canWrite = usePermission("clinical.write")
  const refresh = useRefreshPapers(patientId, onChanged)
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const issued = prescription.status === "emitida"
  const menu: RowActionItem[] =
    canWrite && issued
      ? [{ key: "anular", label: "Anular receta", tone: "danger", onSelect: () => setCancelling(true) }]
      : []
  return (
    <DocumentPaperPanel
      patientId={patientId}
      type="prescription"
      documentId={prescription.id}
      title={`Receta N.º ${prescription.prescriptionNumber}`}
      status={`${PRESCRIPTION_STATUS_LABELS[prescription.status] ?? prescription.status} · ${formatDate(prescription.issuedAt)}`}
      send={
        !canWrite
          ? null
          : issued
            ? { kind: "open", onOpen: () => setSending(true) }
            : { kind: "blocked", reason: "Está anulada: ya no se envía." }
      }
      menu={menu}
      revision={prescription.status}
      page={page}
      onClose={onClose}
      notice={
        prescription.cancelReason || prescription.allergyOverrideReason ? (
          <>
            {prescription.cancelReason ? (
              <p className="text-muted-foreground">Anulada: {prescription.cancelReason}</p>
            ) : null}
            {prescription.allergyOverrideReason ? (
              <p className="text-muted-foreground">
                Recetada pese al aviso de alergia: {prescription.allergyOverrideReason}
              </p>
            ) : null}
          </>
        ) : undefined
      }
    >
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={patientId}
          documentType="prescription"
          documentId={prescription.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      {cancelling ? (
        <CancelWithReason
          title="Anular receta"
          description="La receta conserva su contenido original y el motivo de anulación."
          mutationFn={(reason) => cancelPrescriptionApi(patientId, prescription.id, { reason })}
          onClose={() => setCancelling(false)}
          onDone={refresh}
        />
      ) : null}
    </DocumentPaperPanel>
  )
}

export function MedicalLeavePaper({
  patientId,
  leave,
  page,
  onClose,
  onChanged,
}: PaperSurface & { patientId: string; leave: MedicalLeave }) {
  const canWrite = usePermission("clinical.write")
  const refresh = useRefreshPapers(patientId, onChanged)
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const issued = leave.status === "emitido"
  return (
    <DocumentPaperPanel
      patientId={patientId}
      type="medical_leave"
      documentId={leave.id}
      title={`Descanso médico N.º ${leave.leaveNumber}`}
      status={`${issued ? "Emitido" : "Anulado"} · ${formatDate(leave.issuedAt)} · ${medicalLeaveWords(leave.startsOn, leave.days)}`}
      send={
        !canWrite
          ? null
          : issued
            ? { kind: "open", onOpen: () => setSending(true) }
            : { kind: "blocked", reason: "Está anulado: ya no se envía." }
      }
      menu={
        canWrite && issued
          ? [{ key: "anular", label: "Anular descanso médico", tone: "danger", onSelect: () => setCancelling(true) }]
          : []
      }
      revision={leave.status}
      page={page}
      onClose={onClose}
      notice={
        <>
          <p className="text-muted-foreground">
            {leave.showDiagnosis && leave.diagnosisCode
              ? `Con el diagnóstico ${leave.diagnosisCode}: la persona lo autorizó.`
              : "Sin diagnóstico: la persona no autorizó que figure."}
          </p>
          {leave.cancelReason ? <p className="text-muted-foreground">Anulado: {leave.cancelReason}</p> : null}
        </>
      }
    >
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={patientId}
          documentType="medical_leave"
          documentId={leave.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      {cancelling ? (
        <CancelWithReason
          title="Anular descanso médico"
          description="La constancia conserva su contenido original y el motivo de anulación."
          mutationFn={(reason) => cancelMedicalLeaveApi(patientId, leave.id, { reason })}
          onClose={() => setCancelling(false)}
          onDone={refresh}
        />
      ) : null}
    </DocumentPaperPanel>
  )
}

export function OrderPaper({ order, page, onClose, onChanged }: PaperSurface & { order: ClinicalOrder }) {
  const canWrite = usePermission("clinical.write")
  const refresh = useRefreshPapers(order.patientId, onChanged)
  const [sending, setSending] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const open = order.status === "solicitado" || order.status === "en_proceso"
  const menu: RowActionItem[] =
    canWrite && open
      ? [
          { key: "resultado", label: "Subir el resultado", onSelect: () => setResultOpen(true) },
          { key: "cancelar", label: "Cancelar…", tone: "danger", onSelect: () => setCancelOpen(true) },
        ]
      : []
  return (
    <DocumentPaperPanel
      patientId={order.patientId}
      type="order"
      documentId={order.id}
      title={`${ORDER_KIND_TITLES[order.kind]} · ${order.title}`}
      status={`${ORDER_STATUS_LABELS[order.status]} · ${formatDate(order.createdAt)} · para ${order.recipient}`}
      send={
        !canWrite
          ? null
          : order.status === "cancelado"
            ? { kind: "blocked", reason: "Está cancelada: ya no se envía." }
            : { kind: "open", onOpen: () => setSending(true) }
      }
      menu={menu}
      revision={order.status}
      page={page}
      onClose={onClose}
      notice={
        (order.status === "completado" && (order.resultText || order.resultDocumentId)) ||
        (order.status === "cancelado" && order.cancelReason) ? (
          <>
            {order.status === "completado" && order.resultText ? (
              <p>
                <strong>Resultado:</strong> {order.resultText}
              </p>
            ) : null}
            {order.status === "completado" && order.resultDocumentId ? (
              <p className="text-muted-foreground">El resultado quedó en Documentos.</p>
            ) : null}
            {order.status === "cancelado" && order.cancelReason ? (
              <p className="text-muted-foreground">Cancelada: {order.cancelReason}</p>
            ) : null}
          </>
        ) : undefined
      }
    >
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={order.patientId}
          documentType="order"
          documentId={order.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      {resultOpen ? (
        <OrderResultDrawer order={order} onClose={() => setResultOpen(false)} onSaved={() => void refresh()} />
      ) : null}
      {cancelOpen ? (
        <OrderCancelDrawer order={order} onClose={() => setCancelOpen(false)} onSaved={() => void refresh()} />
      ) : null}
    </DocumentPaperPanel>
  )
}

/** La historia del consentimiento: quién lo creó, lo firmó, lo revocó. */
function ConsentHistoryDrawer({ document, onClose }: { document: ConsentDocument; onClose: () => void }) {
  const history = useQuery({
    queryKey: ["consent-history", document.id, document.status],
    queryFn: () => fetchConsentHistory(document.id),
  })
  return (
    <DetailDrawer open title="Historia del documento" description={document.titleSnapshot} onClose={onClose}>
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {(history.data?.data ?? []).map((event) => (
          <li key={event.id}>
            {new Date(event.createdAt).toLocaleString(activeOrgLocale(), { dateStyle: "medium", timeStyle: "short" })} ·{" "}
            {CONSENT_EVENT_LABELS[event.toStatus] ?? event.toStatus}
            {event.reason && event.reason !== "Documento creado" ? ` · ${event.reason}` : ""}
          </li>
        ))}
      </ol>
    </DetailDrawer>
  )
}

export function ConsentPaper({ document, page, onClose, onChanged }: PaperSurface & { document: ConsentDocument }) {
  const canWrite = usePermission("clinical.write")
  const refresh = useRefreshPapers(document.patientId, onChanged)
  const cancelId = useId()
  const [sending, setSending] = useState(false)
  const [signing, setSigning] = useState(false)
  const [paperOpen, setPaperOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = document.status === "pendiente"
  const signed = document.status === "firmado"
  const cancel = useMutation({
    mutationFn: () => cancelConsent(document.id, cancelReason.trim()),
    onSuccess: async () => {
      setCancelOpen(false)
      toast.success("Consentimiento anulado")
      await refresh()
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? (cause.shape.message ?? "No se pudo anular") : "No se pudo anular"),
  })
  const menu: RowActionItem[] = [
    // Si ya lo firmó desde su enlace, solo falta confirmarlo: no se firma dos veces.
    ...(canWrite && pending && !document.personSignedAt
      ? [
          { key: "firmar", label: "Firmar ahora", onSelect: () => setSigning(true) },
          { key: "papel", label: "Firmado en papel", onSelect: () => setPaperOpen(true) },
        ]
      : []),
    { key: "historia", label: "Historia del documento", onSelect: () => setHistoryOpen(true) },
    ...(canWrite && pending
      ? [
          {
            key: "anular",
            label: "Anular pendiente…",
            tone: "danger" as const,
            onSelect: () => {
              setCancelReason("")
              setError(null)
              setCancelOpen(true)
            },
          },
        ]
      : []),
    ...(canWrite && signed
      ? [{ key: "revocar", label: "Revocar…", tone: "danger" as const, onSelect: () => setRevokeOpen(true) }]
      : []),
  ]
  const signatureWords = consentSignatureWords(document)
  return (
    <DocumentPaperPanel
      patientId={document.patientId}
      type="consent"
      documentId={document.id}
      title={`Consentimiento · ${document.titleSnapshot}`}
      status={`${CONSENT_STATUS_LABELS[document.status]} · ${formatDate(document.signedAt ?? document.createdAt)}`}
      send={
        !canWrite
          ? null
          : signed
            ? { kind: "open", onOpen: () => setSending(true) }
            : pending
              ? { kind: "blocked", reason: "Se envía cuando esté firmado. Esta hoja es para firmar en papel." }
              : { kind: "blocked", reason: `Está ${CONSENT_STATUS_LABELS[document.status].toLowerCase()}: ya no se envía.` }
      }
      menu={menu}
      revision={`${document.status}-${document.pdfDocumentId ?? ""}-${document.revokePdfDocumentId ?? ""}`}
      page={page}
      onClose={onClose}
      notice={
        canWrite && pending ? (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <p>
              {consentLinkWords(document) ??
                `Falta la firma. En la ${appWords().room.one}, la persona firma con el dedo en pantalla completa y tú confirmas con tu perfil; si la firmó en papel, sube la foto de la hoja. También puedes enviárselo para que lo firme desde su teléfono.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {document.personSignedAt ? null : (
                <Button type="button" size="sm" onClick={() => setSigning(true)}>
                  Firmar ahora
                </Button>
              )}
              <ConsentLinkActions document={document} onChanged={refresh} />
            </div>
          </div>
        ) : signatureWords ? (
          <p className="text-muted-foreground">{signatureWords}</p>
        ) : undefined
      }
    >
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={document.patientId}
          documentType="consent"
          documentId={document.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      <ConsentSigningScreen
        open={signing}
        documents={[document]}
        patientId={document.patientId}
        onClose={() => setSigning(false)}
        onSigned={refresh}
      />
      <PaperSignDrawer
        open={paperOpen}
        document={document}
        patientId={document.patientId}
        encounterId={document.encounterId}
        onClose={() => setPaperOpen(false)}
        onSigned={refresh}
      />
      {revokeOpen ? (
        <DetailDrawer open size="lg" title="Revocar consentimiento" onClose={() => setRevokeOpen(false)}>
          <RevokeForm
            document={document}
            onCancel={() => setRevokeOpen(false)}
            onChanged={async () => {
              setRevokeOpen(false)
              await refresh()
            }}
          />
        </DetailDrawer>
      ) : null}
      {historyOpen ? <ConsentHistoryDrawer document={document} onClose={() => setHistoryOpen(false)} /> : null}
      <ConfirmDialog
        open={cancelOpen}
        title="Anular consentimiento pendiente"
        description="Desaparece de los pendientes y no cuenta como consentimiento. Queda en la historia con el motivo."
        confirmLabel="Anular"
        pending={cancel.isPending}
        confirmDisabled={!cancelReason.trim()}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => cancel.mutate()}
      >
        <Field>
          <FieldLabel htmlFor={cancelId}>Motivo</FieldLabel>
          <Textarea
            id={cancelId}
            aria-required="true"
            value={cancelReason}
            maxLength={2000}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="p. ej. Plantilla equivocada"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </Field>
      </ConfirmDialog>
    </DocumentPaperPanel>
  )
}

/**
 * Un presupuesto como papel: se ve igual que los demás, y lo que se trabaja de él
 * sigue en el Plan. Un borrador se revisa antes de enviarlo; lo entregado se reenvía.
 */
export function BudgetPaper({
  patientId,
  budget,
  page,
  onClose,
}: PaperSurface & { patientId: string; budget: BudgetWithTotals }) {
  const canSend = usePermission("budgets.send")
  const navigate = useNavigate()
  const [reviewing, setReviewing] = useState(false)
  const draft = budget.status === "borrador"
  return (
    <DocumentPaperPanel
      patientId={patientId}
      type="budget"
      documentId={budget.id}
      title={budgetNumberLabel(budget.budgetNumber)}
      status={`${budget.stateText} · ${formatDate(budget.presentedAt ?? budget.createdAt)}`}
      send={
        !canSend
          ? null
          : draft
            ? { kind: "open", label: "Revisar y enviar", onOpen: () => setReviewing(true) }
            : BUDGET_SENDABLE_STATUSES.includes(budget.status)
              ? {
                  kind: "node",
                  node: (
                    <SendFinancialDocument
                      patientId={patientId}
                      documentType="budget"
                      documentId={budget.id}
                      trigger={<Button type="button">Enviar</Button>}
                    />
                  ),
                }
              : { kind: "blocked", reason: `${budget.stateText}: ya no se envía.` }
      }
      menu={[
        ...(draft
          ? []
          : [{ key: "explica", label: "Lo que se le explicó", onSelect: () => setReviewing(true) }]),
        {
          key: "plan",
          label: "Abrir en su Plan",
          onSelect: () =>
            void navigate({ to: "/patients/$patientId", params: { patientId }, search: { tab: "plan", budgetId: budget.id } }),
        },
      ]}
      revision={`${budget.status}-${budget.updatedAt ?? ""}`}
      page={page}
      onClose={onClose}
    >
      {reviewing ? (
        <BudgetReviewDrawer patientId={patientId} budgetId={budget.id} onClose={() => setReviewing(false)} />
      ) : null}
    </DocumentPaperPanel>
  )
}
