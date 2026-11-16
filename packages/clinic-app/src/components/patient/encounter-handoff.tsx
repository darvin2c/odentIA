import { Badge, buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { fetchConsents } from "../../lib/clinical-forms"
import { fetchConsentNeeds } from "../../lib/encounter-documents"
import { consentsStillAsked } from "./encounter-documents"
import { fetchEncounterNextSteps, type PlanNextStep } from "../../lib/budgets"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { usePermission } from "../../lib/crm"
import type { PatientSectionId } from "../../lib/patient-areas"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import type { EncounterDetail } from "../../lib/patients"
import { StepNotice } from "./next-up"
import { NextStepButton } from "./plan/next-step-action"

/** Lo que no es del plan: el consentimiento por recabar y el saldo. */
interface Step {
  key: string
  /** Quién continúa el trabajo. */
  owner: "Clínica" | "Caja"
  title: string
  detail: string
  section: PatientSectionId
  /** Documentos abre en «Requieren acción». */
  pending?: boolean
  /** «Cobrar»: Cobros con el cobro ya abierto. */
  collect?: boolean
  action: string
}

/** Lo que ya tiene su cita no falta: se dice en verde. */
function settled(step: PlanNextStep): boolean {
  return step.kind === "reservado" || (step.kind === "control" && !!step.action?.appointmentId)
}

/**
 * Cierre y relevo de una atención finalizada: qué queda por hacer y quién lo
 * continúa. Lo del plan es la lista de «Qué sigue» de la ficha, con sus
 * palabras y sus botones, y lo de esta atención primero (la ordena el servidor,
 * `getEncounterNextSteps`): no se arma otra lista aquí. Debajo, el
 * consentimiento por recabar y el saldo, cada uno con el permiso que lo
 * autoriza.
 */
export function EncounterHandoff({
  patientId,
  patientName,
  detail,
}: {
  patientId: string
  /** Para «Nueva cita» y las demás acciones: la persona ya puesta. */
  patientName: string
  detail: EncounterDetail
}) {
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const orgLocale = useOrgProfile().data?.locale
  const encounterId = detail.encounter.id
  // La misma caché de «Qué sigue»: lo que se reserva o responde aquí la vuelve a leer.
  const next = useQuery({
    queryKey: ["plan-next", patientId, "atencion", encounterId],
    queryFn: () => fetchEncounterNextSteps(patientId, encounterId),
    enabled: canClinical,
    retry: false,
  })
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canClinical,
  })
  const needs = useQuery({
    queryKey: ["consent-needs", patientId, encounterId],
    queryFn: () => fetchConsentNeeds(patientId, encounterId),
    enabled: canClinical,
  })
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canFinance,
  })
  // Lo que ya no se pide (no lo aceptó o eligió otro camino) no queda por recabar.
  const { pendingSignatures: pendingConsents } = consentsStillAsked(
    (consents.data?.data ?? []).filter((row) => row.encounterId === encounterId && row.status === "pendiente"),
    needs,
  )
  const outstanding = (account.data?.data.byCurrency ?? []).filter(
    (balance) => balance.porCobrar > 0,
  )
  const activeProcedures = detail.procedures.filter((proc) => !proc.voidedAt)
  const priced = activeProcedures.length
  const planSteps = next.data?.data ?? []

  const steps: Step[] = []
  for (const consent of pendingConsents)
    steps.push({
      key: `consent-${consent.id}`,
      owner: "Clínica",
      title: consent.personSignedAt
        ? `Consentimiento por confirmar: ${consent.titleSnapshot}`
        : `Consentimiento sin firmar: ${consent.titleSnapshot}`,
      detail: consent.personSignedAt
        ? "Lo firmó desde su enlace: se confirma en su atención en curso, con la persona delante."
        : "Debe firmarlo el paciente o su representante legal vigente.",
      section: "documentos",
      pending: true,
      action: consent.personSignedAt ? "Ver" : "Recabar firma",
    })
  if (canFinance) {
    for (const balance of outstanding)
      steps.push({
        key: `balance-${balance.currency}`,
        owner: "Caja",
        // El saldo descuenta lo que tiene a favor (decisión 22).
        title:
          balance.saldo > 0
            ? `Cobrar ${orgLocale ? formatMoney(balance.saldo, balance.currency, orgLocale) : "…"}`
            : "Aplicar lo que tiene a favor",
        detail:
          balance.saldo > 0 ? "Saldo por cobrar en la cuenta del paciente." : "Lo que tiene a favor cubre lo que debe.",
        section: "cuenta",
        collect: true,
        action: balance.saldo > 0 ? "Cobrar" : "Aplicar",
      })
  }

  const loading =
    (canClinical && (next.isPending || consents.isPending)) ||
    (canFinance && account.isPending)

  const linkTo = (section: PatientSectionId, label: string, pending?: boolean, collect?: boolean): ReactNode => (
    <Link
      to="/patients/$patientId"
      params={{ patientId }}
      search={pending ? { tab: section, tipo: "requieren" } : collect ? { tab: section, cobrar: true } : { tab: section }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      {label}
    </Link>
  )

  const total = planSteps.length + steps.length
  // Sin nada pendiente no hay bloque: lo hecho ya se lee en la atención de abajo.
  if (!loading && total === 0 && (canFinance || priced === 0)) return null
  return (
    <section
      className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6"
      aria-labelledby="relevo-titulo"
    >
      <h2 id="relevo-titulo" className="font-heading text-base font-medium">
        Lo que sigue
      </h2>
      {loading ? (
        <p className="text-sm text-muted-foreground">Consultando lo que queda por hacer…</p>
      ) : total === 0 ? null : (
        <ul className="flex flex-col divide-y">
          {planSteps.map((step) => (
            <li
              key={`${step.kind}-${step.action?.followUpId ?? step.action?.budgetId ?? step.action?.planItemIds?.join() ?? ""}-${step.action?.appointmentId ?? ""}-${step.text}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {/* Lo del plan lo coordina recepción; lo suspendido se retoma en la clínica. */}
                  <Badge variant={settled(step) ? "success" : "warning"}>
                    {step.kind === "suspendido" ? "Clínica" : "Recepción"}
                  </Badge>
                  {step.text}
                </span>
                {step.detail ? <span className="text-sm text-muted-foreground">{step.detail}</span> : null}
                <StepNotice notice={step.notice} />
              </div>
              <NextStepButton patient={{ id: patientId, name: patientName }} step={step} size="sm" variant="outline" />
            </li>
          ))}
          {steps.map((step) => (
            <li
              key={step.key}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Badge variant="warning">{step.owner}</Badge>
                  {step.title}
                </span>
                {step.detail ? (
                  <span className="text-sm text-muted-foreground">{step.detail}</span>
                ) : null}
              </div>
              {linkTo(step.section, step.action, step.pending, step.collect)}
            </li>
          ))}
        </ul>
      )}
      {!canFinance && priced > 0 ? (
        <p className="text-sm text-muted-foreground">
          Los actos con precio generaron sus cargos: caja los ve en la cuenta del paciente.
        </p>
      ) : null}
    </section>
  )
}
