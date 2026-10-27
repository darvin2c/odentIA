import { Badge, buttonVariants } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { apiFetch } from "../../lib/api"
import { fetchConsents } from "../../lib/clinical-forms"
import {
  fetchFollowUps,
  formatDate,
  formatDateTime,
} from "../../lib/clinical-journey"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { usePermission } from "../../lib/crm"
import type { PatientSectionId } from "../../lib/patient-areas"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import type { EncounterDetail, PatientSummary } from "../../lib/patients"
interface Step {
  key: string
  /** Quién continúa el trabajo. */
  owner: "Clínica" | "Recepción" | "Caja"
  title: string
  detail: string
  tone: "warning" | "success"
  section: PatientSectionId
  /** Documentos abre en «Requieren acción». */
  pending?: boolean
  /** «Cobrar»: Cobros con el cobro ya abierto. */
  collect?: boolean
  action: string
}

/**
 * Cierre y relevo de una atención finalizada: qué quedó hecho y qué recibe cada
 * rol para continuar. Cada dato se pide solo con el permiso que lo autoriza; lo
 * que este usuario no puede ver se enuncia sin detalle.
 */
export function EncounterHandoff({
  patientId,
  detail,
}: {
  patientId: string
  detail: EncounterDetail
}) {
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const orgLocale = useOrgProfile().data?.locale
  const encounterId = detail.encounter.id
  const followUps = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canClinical,
  })
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canClinical,
  })
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical,
  })
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canFinance,
  })
  const ownControls = (followUps.data?.data ?? []).filter(
    (row) => row.originEncounterId === encounterId,
  )
  const pendingConsents = (consents.data?.data ?? []).filter(
    (row) => row.encounterId === encounterId && row.status === "pendiente",
  )
  const proposed = summary.data?.data.proposedBudgets ?? []
  const outstanding = (account.data?.data.byCurrency ?? []).filter(
    (balance) => balance.porCobrar > 0,
  )
  const activeProcedures = detail.procedures.filter((proc) => !proc.voidedAt)
  const priced = activeProcedures.length

  const steps: Step[] = []
  for (const consent of pendingConsents)
    steps.push({
      key: `consent-${consent.id}`,
      owner: "Clínica",
      title: `Consentimiento sin firmar: ${consent.titleSnapshot}`,
      detail: "Debe firmarlo el paciente o su representante legal vigente.",
      tone: "warning",
      section: "documentos",
      pending: true,
      action: "Recabar firma",
    })
  for (const control of ownControls.filter((row) => row.status === "pendiente"))
    steps.push({
      key: `control-${control.id}`,
      owner: "Recepción",
      title: `Reservar el control: ${control.title}`,
      detail: `Corresponde el ${formatDate(control.dueAt)}. Falta reservarle la cita.`,
      tone: "warning",
      section: "plan",
      action: "Programar",
    })
  for (const control of ownControls.filter(
    (row) => row.status === "programado" && row.appointment,
  ))
    steps.push({
      key: `control-ok-${control.id}`,
      owner: "Recepción",
      title: `Control con cita: ${control.title}`,
      detail: control.appointment ? formatDateTime(control.appointment.startsAt) : "",
      tone: "success",
      section: "plan",
      action: "Ver controles",
    })
  if (proposed.length > 0)
    steps.push({
      key: "budgets",
      owner: "Recepción",
      title:
        proposed.length === 1
          ? `Seguimiento del presupuesto «${proposed[0].title}»`
          : `Seguimiento de ${proposed.length} presupuestos sin decisión`,
      // Enviado o «lo está pensando»: la regla del servidor; un borrador nunca llega aquí.
      detail: "Espera la respuesta de quien decide.",
      tone: "warning",
      section: "plan",
      action: "Ver presupuestos",
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
        tone: "warning",
        section: "cuenta",
        collect: true,
        action: balance.saldo > 0 ? "Cobrar" : "Aplicar",
      })
  }

  const loading =
    (canClinical && (followUps.isPending || consents.isPending)) ||
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

  // Sin nada pendiente no hay bloque: lo hecho ya se lee en la atención de abajo.
  if (!loading && steps.length === 0 && (canFinance || priced === 0)) return null
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
      ) : steps.length === 0 ? null : (
        <ul className="flex flex-col divide-y">
          {steps.map((step) => (
            <li
              key={step.key}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Badge variant={step.tone === "success" ? "success" : "warning"}>
                    {step.owner}
                  </Badge>
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
