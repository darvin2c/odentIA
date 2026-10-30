/**
 * Recorrido clínico-económico de un tratamiento.
 *
 * Responde, en una sola pantalla y en orden clínico, qué se observó, qué se
 * indicó, qué se propuso, qué se aceptó, qué se ejecutó, qué falta y qué se pagó.
 * Cada sección enlaza con la superficie donde se actúa; nada se edita aquí que
 * no corresponda a este tratamiento.
 */

import { label } from "../../lib/glossary"
import { diagnosisCodeLabel } from "@odentia/clinical"
import { Badge, Button, Checkbox } from "@odentia/ui"
import {
  EmptyState,
  FormDrawer,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { useActiveBranch } from "../../lib/active-branch"
import { apiFetch } from "../../lib/api"
import { budgetStatusLabel, planDecisionLabel } from "../../lib/budgets"
import {
  cancelTreatmentApi,
  completeTreatmentApi,
  fetchTreatmentJourney,
  followUpAppointmentLabel,
  formatDate,
  formatDateTime,
  journeyBalances,
  NEXT_ACTION_LABELS,
  resumeTreatmentApi,
  reviseTreatmentApi,
  suspendTreatmentApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import type { Encounter, PatientSummary, PlanItem, TreatmentNextAction } from "../../lib/patients"
import { planStatusLabel } from "../../lib/patients"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import type { ServiceCatalogItem } from "../../lib/services"
import { ChoiceSelect } from "../ui/choice-select"
import { DiagnosisSearch } from "./diagnosis-search"
import { ControlesPanel, RecetasPanel } from "./clinical-panels"
import { DocumentOpenButton } from "./document-open-button"
import { PlanPhases } from "./plan-fases"
import { ServicePicker } from "./service-picker"
import { productUi } from "../../product/product-ui"

const MAX_TEXT = 2000
const QUADRANTS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const

export type RecorridoTarget =
  | "plan"
  | "imagenes"
  | "cuenta"
  | "historia"
  | "odontograma"
  | "controles"
  | "recetas"

/** Destino con el contexto necesario para no perder de vista qué se estaba mirando. */
export interface RecorridoNavigation {
  tooth?: number
  itemId?: string
  planId?: string
  budgetId?: string
}

function decisionBadge(status: string): "default" | "secondary" | "success" | "destructive" {
  if (status === "aceptado") return "success"
  if (status === "rechazado" || status === "reemplazado") return "destructive"
  if (status === "pospuesto") return "secondary"
  return "default"
}

function siteLabel(item: PlanItem): string {
  if (item.scope === "tooth" && item.toothNumber != null) return `Pieza ${item.toothNumber}`
  if (item.scope === "surfaces" && item.toothNumber != null) {
    const surfaces = item.surfaces.length > 0 ? ` (${item.surfaces.join(", ")})` : " · cara por definir"
    return `Pieza ${item.toothNumber}${surfaces}`
  }
  // Indicado sin decir la pieza: se define al hacerlo.
  if (item.scope === "tooth" || item.scope === "surfaces") return "Pieza por definir"
  if (item.scope === "quadrant" && item.quadrant != null) return `Cuadrante ${item.quadrant}`
  if (item.scope === "arch") return item.arch === "upper" ? "Arcada superior" : "Arcada inferior"
  return "General"
}

export function RecorridoClinicoTab({
  patientId,
  initialItemId,
  showPhases = true,
  onChangeItem,
  onTabChange,
}: {
  patientId: string
  initialItemId?: string
  /** `false`: solo el recorrido del tratamiento (la lista por fases ya está en el Plan). */
  showPhases?: boolean
  onChangeItem: (itemId: string) => void
  onTabChange: (tab: RecorridoTarget, target?: RecorridoNavigation) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const goToEncounter = (encounterId: string) =>
    void navigate({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId, encounterId },
    })
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  // Formato de la clínica para importes históricos (moneda congelada de cada registro).
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const money = (cents: number, currency: string): string =>
    orgLocale ? formatMoney(cents, currency, orgLocale) : "…"

  const itemsQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canRead,
  })
  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canRead,
  })
  // Lo registrado en cada lugar (odentIA: el odontograma), para los hallazgos de su pieza.
  const vigentes = productUi().useFindings(patientId, canRead)

  const items = itemsQuery.data?.data ?? []
  // Orden de trabajo: primero lo que está en curso, al final lo cerrado. Así el
  // recorrido abre en el tratamiento que hoy requiere atención y no en el primero alfabético.
  const statusWeight = (item: PlanItem) => {
    if (["realizado", "cancelado", "reemplazado"].includes(item.status)) return 4
    if (item.status === "en_curso") return 0
    if (item.status === "programado") return 1
    if (item.status === "pendiente") return 2
    return 3
  }
  const ordered = [...items].sort(
    (a, b) => statusWeight(a) - statusWeight(b) || a.title.localeCompare(b.title, "es"),
  )
  const selectedId =
    initialItemId && items.some((item) => item.id === initialItemId)
      ? initialItemId
      : (ordered[0]?.id ?? "")
  const item = items.find((candidate) => candidate.id === selectedId) ?? null

  const journeyQuery = useQuery({
    queryKey: ["treatment-journey", patientId, selectedId],
    queryFn: () => fetchTreatmentJourney(patientId, selectedId),
    enabled: canRead && selectedId !== "",
  })
  const journey = journeyQuery.data?.data ?? null
  const summaryRow = summaryQuery.data?.data.treatmentJourneys.find(
    (row) => row.item.id === selectedId,
  )
  const nextFollowUp = journey?.followUps.find(
    (control) => control.id === summaryRow?.nextFollowUp?.id,
  )

  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<"revise" | "suspend" | "cancel" | null>(null)
  // Cada apertura monta un borrador nuevo (valores iniciales una vez, al abrir).
  const [formKey, setFormKey] = useState(0)
  const openForm = (kind: "revise" | "suspend" | "cancel") => {
    setError(null)
    setFormKey((key) => key + 1)
    setForm(kind)
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId, selectedId] })
    void queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["follow-ups", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["prescriptions", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-account", patientId] })
  }
  const close = () => setForm(null)

  const completeMutation = useMutation({
    mutationFn: (encounterId: string) =>
      completeTreatmentApi(patientId, selectedId, { encounterId }),
    onSuccess: invalidate,
    onError: (mutationError) => setError(submitErrorMessage(mutationError)),
  })

  const summary = summaryQuery.data?.data ?? null
  const openEncounterId = summary?.openEncounterId ?? null
  const [startingSession, setStartingSession] = useState(false)

  if (itemsQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Cargando indicaciones…</p>
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          title="Sin tratamientos indicados"
          description="Los tratamientos se indican durante una atención abierta. Abre una atención para evaluar al paciente e indicar el tratamiento."
        />
        <div>
          <Button type="button" variant="outline" onClick={() => onTabChange("historia")}>
            Ver la historia del paciente
          </Button>
        </div>
      </div>
    )
  }

  // Caja del tratamiento: el servidor solo la entrega con `finance.read`.
  const finance = journey?.finance ?? null
  const balances = finance ? journeyBalances(finance) : []
  const activeFindings = vigentes.filter(
    (entry) => item?.toothNumber != null && entry.toothNumber === item.toothNumber,
  )
  const nextAction: TreatmentNextAction | null = journey?.nextAction ?? null
  /** Propuesta vigente del tratamiento: enlace directo desde el recorrido. */
  const currentBudgetId =
    journey?.item.budgetId ?? journey?.budgetHistory.at(-1)?.budget.id ?? undefined

  /**
   * Reanudar devuelve el tratamiento a su carril real: `en_curso` si ya tenía
   * sesiones, `programado` si está aceptado y `pendiente` si todavía no se
   * decidió (reanudar NUNCA inventa una aceptación).
   */
  const resumeTreatment = async () => {
    if (!item) return
    setError(null)
    setStartingSession(true)
    try {
      const hasSessions = (journey?.procedures.length ?? 0) > 0
      await resumeTreatmentApi(patientId, item.id, {
        status: hasSessions
          ? "en_curso"
          : journey?.item.decisionStatus === "aceptado"
            ? "programado"
            : "pendiente",
      })
      invalidate()
    } catch (mutationError) {
      setError(submitErrorMessage(mutationError))
    } finally {
      setStartingSession(false)
    }
  }

  const runPrimaryAction = async () => {
    if (!item) return
    setError(null)
    const openEncounter = goToEncounter
    if (nextAction === "iniciar") {
      setStartingSession(true)
      try {
        const created = await apiFetch<{ data: Encounter }>(
          `/api/patients/${patientId}/encounters`,
          {
            method: "POST",
            body: JSON.stringify({
              reason: item.title,
              teeth: item.toothNumber != null ? [item.toothNumber] : [],
              planItemIds: [item.id],
              // La sede en la que se trabaja: lo que quede por cobrar llega a su caja.
              ...(sede.branchId ? { branchId: sede.branchId } : {}),
            }),
          },
        )
        invalidate()
        openEncounter(created.data.id)
      } catch (mutationError) {
        setError(submitErrorMessage(mutationError))
      } finally {
        setStartingSession(false)
      }
      return
    }
    // Continuar o definir se resuelven en la atención abierta: navegar es la acción.
    if (nextAction === "continuar" || nextAction === "definir") {
      if (openEncounterId) {
        openEncounter(openEncounterId)
        return
      }
      onTabChange("historia")
      return
    }
    if (nextAction === "completar" && openEncounterId) {
      completeMutation.mutate(openEncounterId)
      return
    }
    if (nextAction === "presupuestar" || nextAction === "decidir") {
      onTabChange("plan", { itemId: item.id, planId: journey?.plan.id, budgetId: currentBudgetId })
      return
    }
    // Un tratamiento suspendido se reanuda donde quedó: en curso si ya tenía
    // sesiones, programado si estaba aceptado, pendiente si aún no se decidió.
    if (nextAction === "reanudar") {
      await resumeTreatment()
      return
    }
    if (nextAction === "controlar") {
      onTabChange("controles", { itemId: item.id })
    }
  }

  const primaryLabel: Record<TreatmentNextAction, string> = {
    definir: "Continuar en la atención abierta",
    presupuestar: "Ir al presupuesto",
    decidir: "Registrar la decisión",
    iniciar: "Iniciar sesión",
    reanudar: "Reanudar tratamiento",
    continuar: "Continuar en la atención",
    completar: "Completar tratamiento",
    controlar: "Ver los controles",
  }

  return (
    <div className="flex flex-col gap-6">
      {showPhases ? (
        <PlanPhases
          patientId={patientId}
          items={items}
          journeys={summary?.treatmentJourneys ?? []}
          selectedId={selectedId}
          onSelect={(itemId) => {
            setError(null)
            onChangeItem(itemId)
          }}
        />
      ) : null}

      {journey == null ? (
        <p className="text-sm text-muted-foreground">Cargando el recorrido del tratamiento…</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  {nextAction ? NEXT_ACTION_LABELS[nextAction] : "Sin acción pendiente"}
                </span>
                <span className="text-xs text-muted-foreground">
                  Decisión: {planDecisionLabel(journey.item.decisionStatus)} · Ejecución:{" "}
                  {planStatusLabel(journey.item.status)}
                  {journey.item.startedAt ? ` · desde ${formatDate(journey.item.startedAt)}` : ""}
                  {summaryRow?.nextFollowUp
                    ? ` · control previsto ${formatDate(summaryRow.nextFollowUp.dueAt)}`
                    : ""}
                </span>
                {nextFollowUp ? (
                  <span className="text-xs text-muted-foreground">
                    {followUpAppointmentLabel(nextFollowUp)}
                  </span>
                ) : null}
              </div>
              {canWrite && nextAction ? (
                <Button
                  type="button"
                  disabled={completeMutation.isPending || startingSession}
                  onClick={() => void runPrimaryAction()}
                >
                  {completeMutation.isPending || startingSession
                    ? "Procesando…"
                    : primaryLabel[nextAction]}
                </Button>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {nextAction == null ? (
              <p className="text-xs text-muted-foreground">
                Este tratamiento está cerrado: su historia queda como evidencia y no admite nuevas
                acciones.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">1. Qué se observó</div>
            <p className="text-sm text-muted-foreground">
              {journey.originEncounter
                ? `Indicado en la atención del ${formatDateTime(journey.originEncounter.createdAt)} · ${journey.originEncounter.reason ?? "Evaluación"}`
                : "Indicación histórica sin atención de origen."}
            </p>
            {journey.originEncounter?.evolution ? (
              <p className="whitespace-pre-wrap text-sm">
                Evolución: {journey.originEncounter.evolution}
              </p>
            ) : null}
            {journey.originEncounter?.indications ? (
              <p className="whitespace-pre-wrap text-sm">
                Indicaciones: {journey.originEncounter.indications}
              </p>
            ) : null}
            {journey.originFinding ? (
              <p className="text-sm">
                Motiva esta indicación el hallazgo «{journey.originFinding.condition}»
                {journey.originFinding.surface ? ` (${journey.originFinding.surface})` : ""} de{" "}
                {siteLabel(journey.item)}, registrado el{" "}
                {formatDate(journey.originFinding.createdAt)}.
              </p>
            ) : null}
            {activeFindings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Hallazgos registrados en {siteLabel(journey.item)}
                </span>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {activeFindings.map((entry) => (
                    <li key={entry.id}>
                      {formatDate(entry.createdAt)} · {entry.condition}
                      {entry.surface ? ` (${entry.surface})` : ""}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {journey.item.diagnosisCode ? (
              <p className="text-sm">
                Diagnóstico: {diagnosisCodeLabel(journey.item.diagnosisSystem, journey.item.diagnosisCode)}
              </p>
            ) : null}
            {journey.item.detail ? <p className="text-sm">{journey.item.detail}</p> : null}
            {productUi().site ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onTabChange("odontograma", { tooth: journey.item.toothNumber ?? undefined })
                  }
                >
                  Ver odontograma
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">2. Qué se propuso</div>
            {journey.budgetHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Este tratamiento aún no está en ninguna propuesta.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {journey.budgetHistory.map(({ budget, line }) => (
                  <li key={budget.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">
                      {budget.title} · revisión {budget.revisionNumber}
                    </span>
                    <Badge variant={budget.status === "cancelado" ? "destructive" : "secondary"}>
                      {budgetStatusLabel(budget.status)}
                    </Badge>
                    <span className="tabular-nums">
                      {line.priceCents == null
                        ? "sin precio"
                        : money(line.priceCents, line.currency)}
                    </span>
                    <span className="text-muted-foreground">
                      Decisión de esta línea: {planDecisionLabel(line.decision)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onTabChange("plan", {
                          itemId: journey.item.id,
                          planId: journey.plan.id,
                          budgetId: budget.id,
                        })
                      }
                    >
                      Ver el presupuesto
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {canWrite && journey.budgetHistory.length === 0 ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    onTabChange("plan", { itemId: journey.item.id, planId: journey.plan.id })
                  }
                >
                  Ir al presupuesto
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">3. Qué se decidió</div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={decisionBadge(journey.item.decisionStatus)}>
                {planDecisionLabel(journey.item.decisionStatus)}
              </Badge>
              <span className="text-muted-foreground">
                {journey.item.decidedAt ? formatDate(journey.item.decidedAt) : "sin fecha"} ·{" "}
                {journey.item.decidedByName ?? "sin responsable registrado"}
              </span>
            </div>
            {journey.item.decisionNote ? (
              <p className="text-sm">{journey.item.decisionNote}</p>
            ) : null}
            {journey.supersedes ? (
              <p className="text-sm text-muted-foreground">
                Reemplaza a{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => journey.supersedes && onChangeItem(journey.supersedes.id)}
                >
                  {journey.supersedes.title}
                </Button>
              </p>
            ) : null}
            {journey.replacedBy.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {journey.replacedBy.map((replacement) => (
                  <li key={replacement.id}>
                    Reemplazada por{" "}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onChangeItem(replacement.id)}
                    >
                      {replacement.title}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">4. Qué se ejecutó</div>
            {journey.procedures.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no hay sesiones registradas para este tratamiento.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {journey.procedures.map(({ procedure, encounter }) => (
                  <li key={procedure.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      {formatDateTime(encounter.createdAt)} · {procedure.description}
                    </span>
                    <Badge variant={encounter.status === "borrador" ? "default" : "secondary"}>
                      {encounter.status === "borrador" ? "En curso" : "Atención finalizada"}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => goToEncounter(encounter.id)}
                    >
                      Abrir la atención
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {canWrite ? (
              <div className="flex flex-wrap gap-2">
                {openEncounterId ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => goToEncounter(openEncounterId)}
                  >
                    Continuar en la atención abierta
                  </Button>
                ) : null}
                {!["realizado", "cancelado", "reemplazado"].includes(journey.item.status) ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!openEncounterId}
                      onClick={() => openForm("revise")}
                    >
                      Revisar indicación
                    </Button>
                    {/* Suspender y reanudar son excluyentes: ofrecer «Suspender» a un
                        tratamiento ya suspendido solo produce un 409. Cuando el próximo
                        paso ya es reanudar, la acción principal lo cubre. */}
                    {journey.item.status === "suspendido" ? (
                      nextAction === "reanudar" ? null : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={startingSession}
                          onClick={() => void resumeTreatment()}
                        >
                          Reanudar tratamiento
                        </Button>
                      )
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openForm("suspend")}
                      >
                        Suspender
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openForm("cancel")}
                    >
                      Cancelar tratamiento
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {canWrite &&
            !openEncounterId &&
            !["realizado", "cancelado", "reemplazado"].includes(journey.item.status) ? (
              <p className="text-xs text-muted-foreground">
                Revisar, suspender o cancelar requiere una atención abierta del paciente.
              </p>
            ) : null}
          </div>

          <ControlesPanel
            patientId={patientId}
            itemId={selectedId}
            encounterId={openEncounterId ?? undefined}
            items={items}
          />

          <RecetasPanel
            patientId={patientId}
            itemId={selectedId}
            encounterId={openEncounterId ?? undefined}
            items={items}
          />

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">Documentos del tratamiento</div>
            {journey.documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin documentos enlazados a este tratamiento.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {journey.documents.map((document) => (
                  <li key={document.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      {document.label} · {label("documento", document.category)}
                      {document.toothNumbers.length > 0
                        ? ` · piezas ${document.toothNumbers.join(", ")}`
                        : ""}
                      {document.tags.length > 0 ? ` · ${document.tags.join(", ")}` : ""}
                    </span>
                    <DocumentOpenButton
                      patientId={patientId}
                      documentId={document.id}
                      label={document.label}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onTabChange("imagenes", { itemId: journey.item.id })}
              >
                Subir o revisar documentos
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">5. Qué se pagó</div>
            {finance === null ? (
              <p className="text-sm text-muted-foreground">
                Los cobros de este tratamiento los gestiona caja: tu permiso no incluye cargos,
                pagos ni saldos.
              </p>
            ) : balances.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Este tratamiento no tiene cargos: aceptar la propuesta no genera cargos.
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {balances.map((balance) => (
                  <div key={balance.currency}>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Por cobrar ({balance.currency})
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {money(balance.outstandingCents, balance.currency)}
                    </dd>
                    <dd className="text-xs text-muted-foreground">
                      cargado {money(balance.chargedCents, balance.currency)} · aplicado{" "}
                      {money(balance.appliedCents, balance.currency)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {finance && finance.charges.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {finance.charges.map((charge) => (
                  <li key={charge.id}>
                    {charge.description} · {money(charge.amountCents, charge.currency)}
                    {charge.voidedAt ? " · anulado" : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {finance && finance.payments.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {finance.payments.map((payment) => {
                  const applied = finance.applications
                    .filter(
                      (application) =>
                        application.paymentId === payment.id && !application.voidedAt,
                    )
                    .reduce((sum, application) => sum + application.amountCents, 0)
                  return (
                    <li key={payment.id}>
                      Pago del {formatDate(payment.paidAt)} ·{" "}
                      {money(payment.amountCents, payment.currency)} · aplicado a este
                      tratamiento {money(applied, payment.currency)}
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {finance ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onTabChange("cuenta", { itemId: journey.item.id })}
                >
                  Gestionar la cuenta del paciente
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}

      <ReviseDrawer
        key={`revise-${formKey}`}
        open={form === "revise"}
        patientId={patientId}
        itemId={selectedId}
        encounterId={openEncounterId}
        initialTooth={journey?.item.toothNumber ?? null}
        onClose={close}
        onDone={() => {
          close()
          invalidate()
        }}
      />
      <StatusDrawer
        key={`status-${formKey}`}
        kind={form === "cancel" ? "cancel" : "suspend"}
        open={form === "suspend" || form === "cancel"}
        patientId={patientId}
        itemId={selectedId}
        encounterId={openEncounterId}
        onClose={close}
        onDone={() => {
          close()
          invalidate()
        }}
      />
    </div>
  )
}

const PIECE_TEXT = "Indica la pieza con un número entero, sin decimales."

interface ReviseValues {
  service: ServiceCatalogItem | null
  toothNumber: string
  surfaces: string[]
  quadrant: string
  arch: string
  diagnosis: string
  detail: string
  reason: string
}

/** Lo que antes se rechazaba al enviar, ahora en el campo que hay que corregir. */
function reviseSchema(hasSite: boolean) {
  return z
    .object({
      service: z.custom<ServiceCatalogItem | null>(),
      toothNumber: z.string(),
      surfaces: z.array(z.string()),
      quadrant: z.string(),
      arch: z.string(),
      diagnosis: z.string(),
      detail: z.string().max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
      reason: z
        .string()
        .trim()
        .min(1, "Indica el motivo de la revisión.")
        .max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
    })
    .superRefine((value, ctx) => {
      if (!value.service) {
        ctx.addIssue({ code: "custom", path: ["service"], message: "Elige la nueva prestación." })
        return
      }
      const scope = value.service.scope ?? "general"
      const tooth = value.toothNumber.trim()
      if (tooth !== "" && !/^\d+$/.test(tooth)) {
        ctx.addIssue({ code: "custom", path: ["toothNumber"], message: PIECE_TEXT })
      } else if (hasSite && tooth === "" && (scope === "tooth" || scope === "surfaces")) {
        ctx.addIssue({
          code: "custom",
          path: ["toothNumber"],
          message: "Indica la pieza de la nueva indicación.",
        })
      }
      if (scope === "surfaces" && value.surfaces.length === 0) {
        ctx.addIssue({ code: "custom", path: ["surfaces"], message: "Marca al menos una superficie." })
      }
      if (scope === "quadrant" && !value.quadrant) {
        ctx.addIssue({ code: "custom", path: ["quadrant"], message: "Elige el cuadrante." })
      }
      if (scope === "arch" && !value.arch) {
        ctx.addIssue({ code: "custom", path: ["arch"], message: "Elige la arcada." })
      }
    })
}

/** Revisar la indicación: la anterior queda reemplazada por la nueva. */
function ReviseDrawer({
  open,
  patientId,
  itemId,
  encounterId,
  initialTooth,
  onClose,
  onDone,
}: {
  open: boolean
  patientId: string
  itemId: string
  encounterId: string | null
  initialTooth: number | null
  onClose: () => void
  onDone: () => void
}) {
  const site = productUi().site
  const revise = useMutation({
    mutationFn: (body: Parameters<typeof reviseTreatmentApi>[2]) =>
      reviseTreatmentApi(patientId, itemId, body),
  })
  const defaultValues: ReviseValues = {
    service: null,
    toothNumber: initialTooth != null ? String(initialTooth) : "",
    surfaces: [],
    quadrant: "",
    arch: "",
    diagnosis: "",
    detail: "",
    reason: "",
  }
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: reviseSchema(site != null) },
    onSubmit: async ({ value }) => {
      if (!encounterId) throw new Error("Necesitas una atención abierta para revisar la indicación.")
      // El esquema ya exige la prestación.
      const service = value.service as ServiceCatalogItem
      const scope = service.scope ?? "general"
      const tooth = value.toothNumber.trim()
      const diagnosis = value.diagnosis.trim()
      const detail = value.detail.trim()
      await revise.mutateAsync({
        encounterId,
        reason: value.reason.trim(),
        serviceId: service.id,
        toothNumber: tooth === "" ? null : Number(tooth),
        surfaces: scope === "surfaces" ? value.surfaces : null,
        quadrant: scope === "quadrant" ? Number(value.quadrant) : null,
        arch: scope === "arch" ? (value.arch as "upper" | "lower") : null,
        detail: detail === "" ? null : detail,
        diagnosisCode: diagnosis === "" ? null : diagnosis,
      })
      onDone()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { serviceId: "service", diagnosisCode: "diagnosis" },
  })
  const scope = useStore(form.store, (state) => state.values.service?.scope ?? null)
  const tooth = useStore(form.store, (state) => state.values.toothNumber.trim())
  const surfaceOptions = /^\d+$/.test(tooth) ? (site?.partsOf(Number(tooth)) ?? []) : []

  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Revisar indicación"
      description="La indicación anterior queda reemplazada y sus sesiones se conservan en la historia."
      submitLabel="Registrar la revisión"
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="service">
          {(field) => (
            <field.Control label="Nueva prestación">
              {(control) => (
                <ServicePicker
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value?.id ?? ""}
                  onChange={(next) => {
                    field.handleChange(next)
                    form.setFieldValue("surfaces", [])
                    form.setFieldValue("quadrant", "")
                    form.setFieldValue("arch", "")
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {scope === "surfaces" ? (
          <form.AppField name="surfaces">
            {(field) => (
              <field.Group legend="Superficies revisadas">
                {(control) => (
                  <div className="flex flex-wrap gap-2">
                    {surfaceOptions.map((option) => (
                      <label key={option} className="flex items-center gap-1.5 text-sm">
                        <Checkbox
                          aria-invalid={control.invalid || undefined}
                          aria-describedby={control.describedBy}
                          checked={field.state.value.includes(option)}
                          onBlur={control.onBlur}
                          onCheckedChange={() =>
                            field.handleChange(
                              field.state.value.includes(option)
                                ? field.state.value.filter((s) => s !== option)
                                : [...field.state.value, option],
                            )
                          }
                        />
                        {option}
                      </label>
                    ))}
                  </div>
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {scope === "quadrant" ? (
          <form.AppField name="quadrant">
            {(field) => (
              <field.Control label="Cuadrante">
                {(control) => (
                  <ChoiceSelect
                    {...control.props}
                    className="w-full"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="">Elige el cuadrante</option>
                    {QUADRANTS.map((value) => (
                      <option key={value} value={value}>
                        Cuadrante {value}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
        {scope === "arch" ? (
          <form.AppField name="arch">
            {(field) => (
              <field.Control label="Arcada">
                {(control) => (
                  <ChoiceSelect
                    {...control.props}
                    className="w-full"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="">Elige la arcada</option>
                    <option value="upper">Superior</option>
                    <option value="lower">Inferior</option>
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
        {site ? (
          <form.AppField name="toothNumber">
            {(field) => (
              <field.TextField
                label={scope === "quadrant" || scope === "arch" ? "Pieza (opcional)" : "Pieza"}
                inputMode="numeric"
              />
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="diagnosis">
          {(field) => (
            <field.Control label="Diagnóstico">
              {(control) => (
                <DiagnosisSearch
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(code) => field.handleChange(code)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="detail">
          {(field) => <field.TextareaField label="Detalle clínico" maxLength={MAX_TEXT} />}
        </form.AppField>
        <form.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo de la revisión" maxLength={MAX_TEXT} />}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const statusSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Indica el motivo.")
    .max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

/** Suspender o cancelar: el motivo y su error dentro del cajón, no detrás. */
function StatusDrawer({
  kind,
  open,
  patientId,
  itemId,
  encounterId,
  onClose,
  onDone,
}: {
  kind: "suspend" | "cancel"
  open: boolean
  patientId: string
  itemId: string
  encounterId: string | null
  onClose: () => void
  onDone: () => void
}) {
  const change = useMutation({
    mutationFn: (reason: string) =>
      (kind === "cancel" ? cancelTreatmentApi : suspendTreatmentApi)(patientId, itemId, {
        reason,
        encounterId: encounterId ?? undefined,
      }),
  })
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: statusSchema },
    onSubmit: async ({ value }) => {
      await change.mutateAsync(value.reason.trim())
      onDone()
    },
  })
  // El servicio llama al motivo `statusReason`; en el cuerpo de esta ruta es `reason`.
  const surface = useFormSurface(form, { fieldMap: { statusReason: "reason" } })
  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      title={kind === "cancel" ? "Cancelar tratamiento" : "Suspender tratamiento"}
      description={
        kind === "cancel"
          ? "El tratamiento queda cancelado; sus sesiones y documentos se conservan."
          : "El tratamiento queda suspendido y puede reactivarse después."
      }
      submitLabel={kind === "cancel" ? "Cancelar tratamiento" : "Suspender"}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <form.AppField name="reason">
        {(field) => <field.TextareaField label="Motivo" maxLength={MAX_TEXT} />}
      </form.AppField>
    </FormDrawer>
  )
}
