import { isLeftOut, medicalLeaveWords } from "@odentia/clinical"
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
import { Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { ApiError } from "../../lib/api"
import type { ClinicalOrder, FormResponse } from "../../lib/clinical-forms"
import {
  type ConsentDocument,
  canFillFormInAttention,
  consentSignatureWords,
  FORM_RESPONSE_STATUS_LABELS,
  fetchConsents,
  fetchFormResponses,
  fetchFormTemplates,
  fetchOrders,
  formStateWords,
  phoneSignBlockWords,
  teamFormsOfEncounter,
  unfinishedAfterSigning,
} from "../../lib/clinical-forms"
import {
  fetchPrescriptionDetail,
  fetchPrescriptions,
  type Prescription,
} from "../../lib/clinical-journey"
import { fetchFormOffers, formRowTitle, formsBelowOffers } from "../../lib/consultation-forms"
import { useMyUserId, usePermission } from "../../lib/crm"
import { teethWords } from "../../lib/document-list"
import { type ConsentNeed, fetchConsentNeeds, prepareConsents } from "../../lib/encounter-documents"
import type { MedicalLeave } from "../../lib/medical-leaves"
import { fetchMedicalLeaves } from "../../lib/medical-leaves"
import type { Encounter, EncounterDetail, PatientFull, PlanItem } from "../../lib/patients"
import { productUi } from "../../product/product-ui"
import { RecetasPanel } from "./clinical-panels"
import { ClioFormNotice, useClioFormProposals } from "./clio-form-proposals"
import {
  ConsentLinkActions,
  ConsentPhoneDrawer,
  consentLinkWords,
  SendToSignDialog,
} from "./consent-link-actions"
import {
  CompleteSigningData,
  ConsentSigningScreen,
  PaperSignDrawer,
  useConsentSignerWord,
} from "./consent-signing"
import { NewConsentDrawer } from "./consentimientos-tab"
import { categoryLabel, formatTakenAt, imageTypeLabel } from "./document-labels"
import { DocumentOpenButton } from "./document-open-button"
import {
  AttentionSheetPaper,
  ConsentPaper,
  MedicalLeavePaper,
  OrderPaper,
  PrescriptionPaper,
} from "./document-papers"
import { DocumentUploadDialog } from "./document-upload-dialog"
import { NewResponseDrawer, ResponseDetail } from "./formularios-tab"
import { NewMedicalLeaveDrawer } from "./medical-leave"
import { NewOrderDrawer, OrderRow } from "./ordenes-tab"
import { useOpenWide } from "./wide-section"

const errorMessage = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (e.shape.message ?? fallback) : fallback

export type NewDocumentKind =
  | "receta"
  | "descanso"
  | "consentimiento"
  | "orden"
  | "formulario"
  | "archivo"

const NEW_DOCUMENT_OPTIONS: Array<{ kind: NewDocumentKind; label: string }> = [
  { kind: "receta", label: "Receta" },
  { kind: "consentimiento", label: "Consentimiento" },
  { kind: "orden", label: "Orden" },
  { kind: "formulario", label: "Ficha" },
  { kind: "archivo", label: "Imagen o archivo" },
]

/** Lo que se crea desde «Nuevo»: con el descanso médico, junto a la receta, si el producto lo emite. */
export function newDocumentOptions(): Array<{ kind: NewDocumentKind; label: string }> {
  if (!productUi().documents.medicalLeave) return NEW_DOCUMENT_OPTIONS
  return NEW_DOCUMENT_OPTIONS.flatMap((option) =>
    option.kind === "receta"
      ? [option, { kind: "descanso" as const, label: "Descanso médico" }]
      : [option],
  )
}

/**
 * Todo lo que la atención emite o adjunta, en un solo lugar (ADR 0033): lo
 * que pide en consentimientos, sus consentimientos, órdenes, recetas,
 * formularios, imágenes y archivos. Una sola lectura para el bloque, su
 * resumen y el cierre: React Query comparte las consultas.
 */
/** Los estados de un tratamiento que todavía se hará: los que el servidor deja consentir. */
const ITEM_STILL_DONE = new Set(["pendiente", "programado", "en_curso"])

/**
 * Lo que falta firmar lo dice el servidor (lo que la atención pide): uno preparado
 * para lo que la persona dejó fuera (no lo aceptó o eligió otro camino) o para lo
 * anulado ya no se pide. Queda a la vista, sin «Firmar ahora». Lo que ya va por su
 * enlace sigue su curso. Mientras lo que pide se vuelve a leer, nada se da por «ya
 * no se pide», ni el recién preparado para un tratamiento que lo pide y que lo
 * pedido todavía no nombra: decía «Ya no se pide» de él (QA en pantalla del 17 nov, D3).
 *
 * El de un tratamiento de la atención que sigue en pie («Por decidir», aceptado o por
 * hacer) se sigue pidiendo aunque hoy no se haga: el Plan dice «falta firmarlo» de él,
 * y Documentos decía «Ya no se pide: no lo aceptó o eligió otra opción» (QA del 18 nov,
 * novato 1). Lo que pide la atención solo cuenta lo que se hace hoy, porque eso es lo
 * que se pide al cerrar; «ya no se pide» es otra cosa: lo dejado fuera o anulado
 * (`isLeftOut`, la misma regla del servidor).
 */
export function consentsStillAsked<
  T extends {
    id: string
    linkSentAt?: string | null
    personSignedAt?: string | null
    templateId?: string | null
    planItemId?: string | null
  },
>(
  pending: readonly T[],
  needs: {
    data?: {
      data: ReadonlyArray<{ documentId: string | null; templateId?: string | null; planItemId?: string | null }>
    }
    isFetching: boolean
  },
  /** Los tratamientos de la atención (los traídos y los indicados en ella). */
  items: ReadonlyArray<{ id: string; status: string; decisionStatus?: string | null }> = [],
): { pendingSignatures: T[]; notAsked: T[]; toSign: T[] } {
  const list = needs.data && !needs.isFetching ? needs.data.data : null
  const stillDone = (doc: T) => {
    const item = doc.planItemId ? items.find((candidate) => candidate.id === doc.planItemId) : undefined
    return !!item && ITEM_STILL_DONE.has(item.status) && !isLeftOut(item.decisionStatus)
  }
  const isAsked = (doc: T) =>
    list != null &&
    (stillDone(doc) ||
      list.some(
        (need) =>
          need.documentId === doc.id ||
          // Aún sin preparar en lo que se leyó, pero es el de ese tratamiento: el recién preparado.
          (need.documentId == null &&
            need.planItemId != null &&
            need.planItemId === doc.planItemId &&
            (need.templateId == null || need.templateId === doc.templateId)),
      ))
  const notAsked = list
    ? pending.filter((doc) => !isAsked(doc) && !doc.linkSentAt && !doc.personSignedAt)
    : []
  const pendingSignatures = pending.filter((doc) => !notAsked.includes(doc))
  return {
    pendingSignatures,
    notAsked,
    // Lo firmado en su enlace solo falta confirmarlo; lo enviado de algo que ya no se pide, no se ofrece aquí.
    toSign: pendingSignatures.filter((doc) => !doc.personSignedAt && (!list || isAsked(doc))),
  }
}

/**
 * Lo que de los pendientes agrupados ya tiene en su enlace: todos, o cuántos de ellos. Decía «lo
 * tiene en su enlace» de todos aunque solo uno se le mostró (QA del 18 nov, desarrollo).
 */
export function inLinkWords(docs: ReadonlyArray<{ linkSentAt?: string | null }>): string {
  const sent = docs.filter((doc) => doc.linkSentAt).length
  if (sent === 0) return ""
  if (sent < docs.length) return ` · ${sent} de ${docs.length} en su enlace`
  return docs.length === 1 ? " · lo tiene en su enlace" : " · los tiene en su enlace"
}

export function useEncounterDocuments(
  patientId: string,
  encounterId: string,
  detail: EncounterDetail,
) {
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
  // Los de esta atención y los de los tratamientos que se hacen hoy, aunque se prepararan en otra:
  // el pendiente va con el tratamiento (consentimientos, 10 nov).
  const neededDocs = new Set((needs.data?.data ?? []).flatMap((need) => (need.documentId ? [need.documentId] : [])))
  const ownConsents = (consents.data?.data ?? []).filter(
    (doc) =>
      (doc.encounterId === encounterId || neededDocs.has(doc.id)) &&
      (doc.status === "pendiente" || doc.status === "firmado"),
  )
  // El PDF de un consentimiento firmado y la foto de una hoja en papel ya están
  // en su consentimiento: no salen dos veces.
  const consentFileIds = new Set(
    (consents.data?.data ?? []).flatMap(
      (doc) =>
        [doc.pdfDocumentId, doc.revokePdfDocumentId, doc.paperDocumentId].filter(
          Boolean,
        ) as string[],
    ),
  )
  const files = detail.documents.filter((doc) => !doc.retiredAt && !consentFileIds.has(doc.id))
  const ownOrders = (orders.data?.data ?? []).filter((order) => order.encounterId === encounterId)
  const ownPrescriptions = (prescriptions.data?.data ?? []).filter(
    (rx) => rx.encounterId === encounterId && rx.status === "emitida",
  )
  // Lo que envió el paciente y se revisó en esta atención ya está arriba, entero, en su caja
  // (`DeclaredQuestionnaireNotice`): aquí van los formularios que llena el equipo, y no se repite.
  const ownForms = teamFormsOfEncounter(forms.data?.data ?? [], encounterId)
  const ownLeaves = (leaves.data?.data ?? []).filter(
    (leave) => leave.encounterId === encounterId && leave.status === "emitido",
  )
  const needList = needs.data?.data ?? []
  const { pendingSignatures, notAsked, toSign } = consentsStillAsked(
    ownConsents.filter((doc) => doc.status === "pendiente"),
    needs,
    [...detail.plannedItems, ...detail.indicatedItems],
  )
  return {
    needs: needList,
    /** Preparado para lo que dejó fuera o se anuló: ya no hace falta firmarlo. */
    notAsked,
    toPrepare: needList.filter((need) => need.status === "sin_preparar"),
    unpublished: needList.filter((need) => need.status === "sin_publicar"),
    consents: ownConsents,
    pendingSignatures,
    /** Lo que aún no firmó; lo firmado en su enlace solo falta confirmarlo. */
    toSign,
    orders: ownOrders,
    prescriptions: ownPrescriptions,
    forms: ownForms,
    leaves: ownLeaves,
    files,
    total:
      ownConsents.length +
      ownOrders.length +
      ownPrescriptions.length +
      ownLeaves.length +
      ownForms.length +
      files.length,
    isLoading: needs.isPending || consents.isPending,
  }
}

/** El papel que se abre al lado con «Ver»: su PDF, con «Enviar» e «Imprimir». */
type ViewedPaper =
  | { kind: "consent"; document: ConsentDocument }
  | { kind: "prescription"; prescription: Prescription }
  | { kind: "order"; order: ClinicalOrder }
  | { kind: "leave"; leave: MedicalLeave }
  | { kind: "attention" }

/**
 * La segunda línea de un archivo de la atención, como en Documentos: qué es (si el título no lo
 * dice ya), cuándo se tomó y sus piezas («Tomada 12/11/2026 · Pieza 46»).
 */
function fileDetail(file: EncounterDetail["documents"][number]): string {
  const what = (imageTypeLabel(file.imageType) ?? categoryLabel(file.category)).replace(/\s*\([^)]*\)$/, "")
  return [
    file.label.toLowerCase().includes(what.toLowerCase()) ? null : what,
    formatTakenAt(file),
    teethWords(file.toothNumbers),
  ]
    .filter(Boolean)
    .join(" · ")
}

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
  const me = useMyUserId()
  const openWide = useOpenWide()
  const docs = useEncounterDocuments(patientId, encounterId, detail)
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState<NewDocumentKind | null>(null)
  const [signing, setSigning] = useState<ConsentDocument[] | null>(null)
  const [paper, setPaper] = useState<ConsentDocument | null>(null)
  const [sendingDoc, setSendingDoc] = useState<ConsentDocument | null>(null)
  const [phoneDoc, setPhoneDoc] = useState<ConsentDocument | null>(null)
  const [viewing, setViewing] = useState<ViewedPaper | null>(null)
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [paperFor, setPaperFor] = useState<ConsentNeed | null>(null)

  useEffect(() => {
    if (openMenu && !disabled) {
      setMenuOpen(true)
      onMenuHandled?.()
    }
  }, [openMenu, disabled, onMenuHandled])

  // Lo que ya se ofrece arriba, en «Fichas para esta atención» (la misma consulta, compartida).
  const offers = useQuery({
    queryKey: ["form-offers", patientId, encounterId],
    queryFn: () => fetchFormOffers(patientId, encounterId),
    enabled: detail.encounter.status === "borrador",
  })
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
        ["form-offers", patientId, encounterId],
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
      if (created.length > 0)
        toast.success(
          created.length === 1
            ? "Consentimiento preparado"
            : `${created.length} consentimientos preparados`,
        )
    },
    onError: (e) => toast.error(errorMessage(e, "No se pudo preparar el consentimiento")),
  })

  // Lo registrado y su diagnóstico, para llenar lo que se crea desde aquí.
  const activeProcedures = detail.procedures.filter((proc) => !proc.voidedAt)
  // Como lo prepara el servidor: cada uno con su lugar en palabras del paciente, separados por «; ».
  const site = productUi().site
  const procedureRef = activeProcedures
    .map(
      (proc) =>
        `${proc.description}${proc.toothNumber != null && site ? ` · ${site.placeForPatient(proc.toothNumber)}` : ""}`,
    )
    .join("; ")
    .slice(0, 500)
  const firstActive = (detail.diagnoses ?? []).find((dx) => !dx.voidedAt)
  const firstDiagnosis = firstActive?.diagnosisCode
  const firstDiagnosisSystem = firstActive?.diagnosisSystem
  const who = useConsentSignerWord(patientId, firstName(patient))

  const startNew = (kind: NewDocumentKind) => {
    setMenuOpen(false)
    // «Consentimiento» con algo por preparar lo prepara lleno, sin preguntar.
    if (kind === "consentimiento" && docs.toPrepare.length > 0) {
      prepare.mutate(undefined)
      return
    }
    setCreating(kind)
  }

  const pendingTitles = docs.toSign.map((doc) => doc.titleSnapshot)
  const signed = detail.encounter.status === "finalizada"
  const unfinished = unfinishedAfterSigning(docs.forms, detail.encounter.status)
  // La ficha de la atención la llena quien la lleva; los demás la ven (`NOT_ATTENDING`).
  const fills = canFillFormInAttention(canWrite, disabled, detail.encounter.status, detail.encounter.professionalUserId === me)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {/* Firmada, la atención ya no crea documentos: se dice dónde, en vez de un «Nuevo» apagado. */}
          {signed && canWrite ? (
            <>
              Para un documento nuevo, créalo desde{" "}
              <Link
                to="/patients/$patientId"
                params={{ patientId }}
                search={{ tab: "documentos" }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                los Documentos de {firstName(patient)}
              </Link>
              .
            </>
          ) : docs.total === 0 && docs.needs.length === 0 ? (
            // La regla, solo con el bloque vacío (estándar E2): con algo dentro, el título basta.
            "Receta, consentimiento, orden, ficha o imagen, llenos con lo de esta atención."
          ) : null}
        </p>
        {canWrite && !signed ? (
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

      {/* Firmada con un formulario a medias: sigue a la vista como pendiente, y se termina desde aquí. */}
      <UnfinishedFormsBox
        forms={unfinished}
        canComplete={fills}
        onOpen={setOpenForm}
      />


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
          <Button
            type="button"
            size="sm"
            disabled={disabled || prepare.isPending}
            onClick={() => prepare.mutate(undefined)}
          >
            {prepare.isPending ? "Preparando…" : "Preparar"}
          </Button>
        </section>
      ) : null}

      {docs.unpublished.map((need) => (
        <section
          key={need.templateKey}
          aria-label="Consentimiento sin activar"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">
              Esta clínica aún no activó el consentimiento de «{need.title}»
            </span>
            <span className="text-xs text-muted-foreground">
              Fírmalo en papel y sube la foto; quien configura lo verá en «Te espera» para
              activarlo.
            </span>
          </div>
          {canWrite ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setPaperFor(need)}
            >
              Subir la hoja firmada
            </Button>
          ) : null}
        </section>
      ))}

      <ul className="flex flex-col divide-y rounded-lg border">
        {signed ? (
          <li className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Hoja de atención</span>
              <span className="text-xs text-muted-foreground">
                Para el seguro: diagnóstico, lo que se hizo, firma y sello
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Ver hoja de atención"
              onClick={() => setViewing({ kind: "attention" })}
            >
              Ver
            </Button>
          </li>
        ) : null}
        {docs.toSign.length > 0 ? (
          <li className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">
                {pendingTitles.length === 1 ? "Consentimiento" : "Consentimientos"} ·{" "}
                {pendingTitles.join(" y ")}
              </span>
              <span className="text-xs text-muted-foreground">
                {pendingTitles.length === 1
                  ? `Falta la firma de ${who}`
                  : `Faltan las firmas de ${who}`}
                {inLinkWords(docs.toSign)}
              </span>
              {(() => {
                const block = docs.toSign.find((doc) => doc.phoneSignBlock)?.phoneSignBlock
                if (!block) return null
                // Lo que falta (la fecha o el documento) se completa al lado: «Completar», o a quién
                // pedírselo si esta persona no puede guardar datos.
                const gap = block === "sin-fecha" || block === "sin-documento" ? block : null
                return (
                  <span className="text-xs text-muted-foreground">
                    {gap
                      ? gap === "sin-fecha"
                        ? `Para firmar desde su teléfono falta la fecha de nacimiento de ${firstName(patient)}. `
                        : `Para firmar desde su teléfono falta el documento de ${who}. `
                      : phoneSignBlockWords(block, who, firstName(patient))}
                    {gap ? (
                      <CompleteSigningData patientId={patientId} gap={gap} onDone={refresh} />
                    ) : null}
                  </span>
                )
              })()}
            </div>
            <div className="flex items-center gap-1">
              {/* «Ver» abre el documento tal como lo firmará el paciente, sin firmar nada. Con
                  varios por firmar, elige cuál. */}
              {docs.toSign.length === 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Ver ${docs.toSign[0]!.titleSnapshot}`}
                  onClick={() => setViewing({ kind: "consent", document: docs.toSign[0]! })}
                >
                  Ver
                </Button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="Ver los consentimientos por firmar"
                      >
                        Ver
                        <ChevronDown aria-hidden />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    {docs.toSign.map((doc) => (
                      <DropdownMenuItem
                        key={doc.id}
                        onClick={() => setViewing({ kind: "consent", document: doc })}
                      >
                        {doc.titleSnapshot}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => setSigning(docs.toSign)}
              >
                Firmar ahora
              </Button>
              <RowActions
                label="Otras formas de firmar"
                items={docs.toSign.flatMap((doc) => [
                  // Si su enlace no lo dejaría firmar (menor, sin fecha o sin documento), ni enviarlo
                  // ni mostrar el código: la fila dice por qué (QA del 10 nov, M2).
                  ...(doc.linkSentAt || doc.phoneSignBlock
                    ? []
                    : [
                        {
                          key: `link-${doc.id}`,
                          label: `Enviar para firmar desde su teléfono: ${doc.titleSnapshot}`,
                          disabled,
                          // Con su confirmación, como en la ficha: dice qué le llega.
                          onSelect: () => setSendingDoc(doc),
                        },
                      ]),
                  // Si su enlace no lo dejaría firmar (menor, sin fecha o sin documento), no se ofrece.
                  ...(doc.phoneSignBlock
                    ? []
                    : [
                        {
                          key: `phone-${doc.id}`,
                          label: `Mostrar el código para firmarlo en su teléfono: ${doc.titleSnapshot}`,
                          disabled,
                          onSelect: () => setPhoneDoc(doc),
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
          // Lo que solo tiene en su enlace y se pide hoy sigue en «Firmar ahora» (arriba): aquí, lo
          // que ya firmó allí y lo que tiene en su enlace sin pedirse hoy.
          .filter((doc) => doc.personSignedAt || (doc.linkSentAt && !docs.toSign.includes(doc)))
          .map((doc) => (
            <li
              key={`enlace-${doc.id}`}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Consentimiento · {doc.titleSnapshot}</span>
                <span className="text-xs text-muted-foreground">{consentLinkWords(doc)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Antes de confirmar se puede ver lo que firmó. */}
                {doc.personSignedAt ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Ver ${doc.titleSnapshot}`}
                    onClick={() => setViewing({ kind: "consent", document: doc })}
                  >
                    Ver
                  </Button>
                ) : null}
                {canWrite ? (
                  <ConsentLinkActions
                    document={doc}
                    onChanged={refresh}
                    // Lo firmado por enlace se confirma aquí, mientras la atención siga en curso.
                    encounterId={detail.encounter.status === "borrador" ? encounterId : null}
                  />
                ) : null}
              </div>
            </li>
          ))}
        {docs.notAsked.map((doc) => (
          <li key={`fuera-${doc.id}`} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Consentimiento · {doc.titleSnapshot}</span>
              <span className="text-xs text-muted-foreground">
                Ya no se pide: no lo aceptó, eligió otra opción o se anuló
              </span>
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
        {docs.consents
          .filter((doc) => doc.status === "firmado")
          .map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Consentimiento · {doc.titleSnapshot}</span>
                <span className="text-xs text-muted-foreground">
                  Firmado · {consentSignatureWords(doc)}
                </span>
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
              <span className="text-xs text-muted-foreground">
                {medicalLeaveWords(leave.startsOn, leave.days)}
              </span>
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
        {/* El que quedó a medias al firmar ya está arriba, con su «Completar»: aquí no se repite. */}
        {formsBelowOffers(docs.forms, offers.data?.data)
          .filter((form) => !unfinished.some((pending) => pending.id === form.id))
          .map((form) => (
          <li key={form.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">
                {formRowTitle(form)}
              </span>
              <span className="text-xs text-muted-foreground">
                {signed && form.status === "borrador"
                  ? formStateWords({ ...form, encounterStatus: "finalizada" })
                  : FORM_RESPONSE_STATUS_LABELS[form.status]}
              </span>
            </div>
            {(() => {
              const action =
                form.status === "borrador" && fills
                  ? "Completar"
                  : "Ver"
              return (
                // Con dos fichas, cada botón dice de cuál es.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`${action} ${formRowTitle(form)}`}
                  onClick={() => setOpenForm(form.id)}
                >
                  {action}
                </Button>
              )
            })()}
            {form.status === "borrador" ? (
              <ClioFormNotice responseId={form.id} title={formRowTitle(form)} onOpen={() => setOpenForm(form.id)} />
            ) : null}
          </li>
        ))}
        {docs.files.map((file) => (
          <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col">
              <span className="break-words text-sm font-medium">{file.label}</span>
              <span className="text-xs text-muted-foreground">{fileDetail(file)}</span>
            </div>
            {openWide ? (
              // Se ve en el visor de la ficha, como en Documentos, no como archivo suelto.
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Ver ${file.label}`}
                onClick={() => openWide({ id: "documentos", documentId: file.id })}
              >
                Ver
              </Button>
            ) : (
              <DocumentOpenButton patientId={patientId} documentId={file.id} label={file.label} />
            )}
          </li>
        ))}
        {docs.total === 0 && docs.pendingSignatures.length === 0 && !signed ? (
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
          todayPlanItemIds={activeProcedures.flatMap((proc) => (proc.planItemId ? [proc.planItemId] : []))}
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
          loading={!formTemplates.isSuccess}
          drafts={docs.forms}
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
        // Es la hoja de un consentimiento: un PDF no se propone como «Informe».
        defaultCategory="consentimiento"
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
      <SendToSignDialog document={sendingDoc} onClose={() => setSendingDoc(null)} onSent={refresh} />
      <ConsentPhoneDrawer document={phoneDoc} onClose={() => setPhoneDoc(null)} onShown={refresh} />
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
          prescription={
            docs.prescriptions.find((rx) => rx.id === viewing.prescription.id) ??
            viewing.prescription
          }
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : viewing?.kind === "order" ? (
        <OrderPaper
          order={docs.orders.find((order) => order.id === viewing.order.id) ?? viewing.order}
          onClose={() => setViewing(null)}
          onChanged={refresh}
        />
      ) : viewing?.kind === "attention" ? (
        <AttentionSheetPaper
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setViewing(null)}
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
        encounterId={encounterId}
        sex={patient.patient.sex ?? null}
        responseId={openForm}
        // Firmada la atención, su formulario a medias se termina igual desde aquí.
        canWrite={fills}
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

/**
 * Lo que dice el panel de un formulario bajo su título: el borrador se guarda solo; uno
 * finalizado ya no se cambia (decir «se guarda solo» ahí prometía algo que no pasa). Lo
 * que respondió el paciente no lleva frase: no lo escribe el equipo, y su vista ya dice
 * de quién es y qué se puede hacer («Agregar una corrección», «Marcar como revisado»).
 */
export function formDetailDescription(
  response: (Pick<FormResponse, "status"> & Partial<Pick<FormResponse, "source" | "encounterId" | "encounterStatus">>) | null,
  canWrite: boolean,
): string | undefined {
  if (response?.source === "portal") return undefined
  // En una atención en curso no hay «Finalizar…»: se cierra con la firma, y se dice aquí, a la vista.
  if (response?.status === "borrador" && canWrite)
    return response.encounterId && response.encounterStatus === "borrador"
      ? "Se guarda sola mientras la llenas y se finaliza al firmar la atención."
      : "Se guarda sola mientras la llenas."
  if (response?.status === "finalizado") return "Finalizada: ya no se cambia. Para corregir algo, agrega una adenda."
  return undefined
}

/**
 * Los formularios que la atención firmada dejó a medias, una sola vez y con su
 * única salida: «Completar». Lo usan Documentos de la atención firmada y
 * «Atención finalizada», el aviso que sale justo al firmar.
 */
export function UnfinishedFormsBox({
  forms,
  canComplete,
  onOpen,
}: {
  forms: ReadonlyArray<{ id: string; templateTitle: string | null }>
  /** Puede terminarlo; si no, lo abre para verlo. */
  canComplete: boolean
  onOpen: (formId: string) => void
}): React.JSX.Element | null {
  if (forms.length === 0) return null
  return (
    <section
      aria-label="Fichas a medias"
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">
          {forms.length === 1 ? "Una ficha quedó a medias" : `${forms.length} fichas quedaron a medias`}
        </span>
        <span className="text-xs text-muted-foreground">
          {forms.length === 1
            ? "No se finalizó con la firma. Al terminarla lleva su propia fecha y hora."
            : "No se finalizaron con la firma. Al terminarlas, cada una lleva su propia fecha y hora."}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {forms.map((form) => {
          const title = form.templateTitle ?? "Ficha"
          return (
            <li key={form.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm">{title}</span>
              <Button
                type="button"
                size="sm"
                // Con el título: con varios a medias, cada botón dice cuál abre.
                aria-label={`${canComplete ? "Completar" : "Ver"} ${title}`}
                onClick={() => onOpen(form.id)}
              >
                {canComplete ? "Completar" : "Ver"}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Un formulario de la atención se completa al lado, sin salir. */
export function FormDetail({
  patientId,
  encounterId,
  sex,
  responseId,
  canWrite,
  onClose,
  onChanged,
  dock,
}: {
  patientId: string
  encounterId: string
  sex: string | null
  responseId: string | null
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  /** `false`: como cajón encima de un diálogo abierto («Atención finalizada»). */
  dock?: boolean
}) {
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: responseId !== null,
  })
  const response = (forms.data?.data ?? []).find((row) => row.id === responseId) ?? null
  // Con la ficha abierta al lado, empezar a dictar no le pone «Lo dictado» encima (entrega 11).
  const clio = useClioFormProposals()
  const panelKey = useId()
  const shown = responseId !== null && response !== null
  useEffect(() => {
    clio?.setFormOpen(panelKey, shown, responseId)
    return () => clio?.setFormOpen(panelKey, false)
  }, [clio, panelKey, shown, responseId])
  // La anterior del mismo tipo, para leerla al lado de la de hoy (el control de ortodoncia).
  const previous = response?.previousId ? ((forms.data?.data ?? []).find((row) => row.id === response.previousId) ?? null) : null
  const first = response?.firstId ? ((forms.data?.data ?? []).find((row) => row.id === response.firstId) ?? null) : null
  return (
    <DetailDrawer
      open={responseId !== null && response !== null}
      title={response?.templateTitle ?? "Ficha"}
      description={formDetailDescription(response, canWrite)}
      // 512 px: lo corto de la ficha va de a pares y la atención de al lado conserva el odontograma
      // entero a 1440 (con 640 bajaba a una arcada a la vez). Quien la quiera más ancha, la estira.
      size="lg"
      onClose={onClose}
      {...(dock === undefined ? {} : { dock })}
    >
      {response ? (
        <ResponseDetail
          key={response.id}
          response={response}
          previous={previous}
          first={first}
          canWrite={canWrite}
          sex={sex}
          encounterId={encounterId}
          onChanged={onChanged}
        />
      ) : null}
    </DetailDrawer>
  )
}
