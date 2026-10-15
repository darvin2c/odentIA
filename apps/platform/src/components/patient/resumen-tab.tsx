import { Badge, Button, buttonVariants } from "@odentia/ui"
import { AgentMark, EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleCheck } from "lucide-react"
import type { ReactNode } from "react"
import { ACTION_LABEL, type AgentProposal } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { planDecisionLabel } from "../../lib/budgets"
import {
  fetchFollowUps,
  fetchResponsibilities,
  formatDate,
  NEXT_ACTION_LABELS,
  RESPONSIBILITY_KIND_LABELS,
} from "../../lib/clinical-journey"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { type TaskItem, timeAgo, usePermission } from "../../lib/crm"
import {
  APPOINTMENT_STATUS_LABELS,
  appointmentWhen,
  nextAppointment,
  usePatientAppointments,
} from "../../lib/patient-appointments"
import type { PatientSectionId } from "../../lib/patient-areas"
import type { PatientFull, PatientSummary } from "../../lib/patients"
import {
  ageFrom,
  fetchPatientHealth,
  hasHealthInfo,
  isHealthReviewPending,
  planStatusLabel,
} from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import { useTreatmentCoordination } from "./coordinacion-panel"
import { NewPatientTaskButton } from "./new-patient-task-button"
import {
  ClinicalAlertsCard,
  ClinicalShortcuts,
  OpenEncounterCard,
  RecentImagesCard,
} from "./resumen-clinico"

interface Pending {
  id: string
  title: string
  detail: string
  action: ReactNode
  /** Lo propone el agente: se distingue con su identidad visual. */
  agent?: boolean
}

function Card({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * Resumen por rol: primero lo que esta persona necesita ahora (pendientes
 * accionables) y después el contexto que cada permiso habilita. Cada bloque
 * pide solo los datos que su permiso autoriza.
 */
export function ResumenTab({
  patientId,
  detail,
  summary,
  onTabChange,
}: {
  patientId: string
  detail: PatientFull
  summary?: PatientSummary
  onTabChange: (section: PatientSectionId, tooth?: number, itemId?: string) => void
}) {
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const canAppointments = usePermission("appointments.read")
  const canBook = usePermission("appointments.write")
  const canPatients = usePermission("patients.read")
  const canEditPatient = usePermission("patients.write")
  const canDecide = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const canTasks = usePermission("tasks.read")

  // Formato de la clínica para saldos históricos (moneda congelada de cada registro).
  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const money = (cents: number, currency: string): string =>
    orgLocale ? formatMoney(cents, currency, orgLocale) : "…"
  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canClinical,
  })
  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical && summary === undefined,
  })
  const followUpsQuery = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canClinical,
  })
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canFinance,
  })
  const responsibilitiesQuery = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: canPatients,
  })
  const appointmentsQuery = usePatientAppointments(patientId, canAppointments)
  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", "propuesta", "patient", patientId],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>(
        `/api/agent/proposals?status=propuesta&patientId=${patientId}`,
      ),
    enabled: canDecide || canReadAgent,
    retry: false,
  })
  const tasksQuery = useQuery({
    queryKey: ["patient-tasks", patientId],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=open&patientId=${patientId}`),
    enabled: canTasks && canPatients,
    retry: false,
  })
  // Quien lee la clínica ya recibe estos pendientes con su detalle.
  const coordinationQuery = useTreatmentCoordination(patientId, canAppointments && !canClinical)

  const resolved = summary ?? summaryQuery.data?.data ?? null
  if (canClinical && resolved == null) {
    if (summaryQuery.isError)
      return (
        <QueryErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      )
    return <LoadingState message="Cargando resumen…" />
  }

  const patient = detail.patient
  const go = (section: PatientSectionId, label: string) => (
    <Button size="sm" variant="outline" onClick={() => onTabChange(section)}>
      {label}
    </Button>
  )

  const pending: Pending[] = []
  // Primero lo que el agente dejó esperando el sí del paciente.
  for (const proposal of proposalsQuery.data?.data ?? [])
    pending.push({
      id: `proposal-${proposal.id}`,
      agent: true,
      title: `El agente propone: ${ACTION_LABEL[proposal.action] ?? proposal.action}`,
      detail: proposal.context.afterSummary || proposal.reason || "Espera la confirmación del paciente.",
      action: (
        <Link
          to="/agent/pendientes"
          search={{
            status: undefined,
            conversationId: proposal.conversationId,
          }}
          className={buttonVariants({ size: "sm" })}
        >
          Revisar
        </Link>
      ),
    })
  const health = healthQuery.data?.data ?? null
  if (canClinical && healthQuery.isSuccess) {
    if (isHealthReviewPending(health))
      pending.push({
        id: "health-review",
        title: "Antecedentes declarados por revisar",
        detail: "El paciente o su responsable los declaró; falta la validación clínica.",
        action: go("antecedentes", "Revisar"),
      })
    else if (!hasHealthInfo(health))
      pending.push({
        id: "health-empty",
        title: "Sin antecedentes registrados",
        detail: "Alergias, condiciones, medicación y entrevista se registran en un solo guardado.",
        action: go("antecedentes", "Registrar"),
      })
  }
  // Quien lee la clínica ve la atención en curso en su propia tarjeta.
  if (resolved?.openEncounterId && !resolved.openEncounter)
    pending.push({
      id: "open-encounter",
      title: "Atención en borrador",
      detail: "Hay una atención iniciada sin finalizar.",
      action: (
        <Link
          to="/patients/$patientId/encounters/$encounterId"
          params={{ patientId, encounterId: resolved.openEncounterId }}
          className={buttonVariants({ size: "sm" })}
        >
          Continuar
        </Link>
      ),
    })
  for (const consent of resolved?.pendingConsents ?? [])
    pending.push({
      id: `consent-${consent.id}`,
      title: `Consentimiento sin firmar: ${consent.title}`,
      detail: "Emitido y pendiente de la firma del paciente o su representante.",
      action: go("consentimientos", "Firmar"),
    })
  if (resolved && resolved.proposedBudgets.length > 0)
    pending.push({
      id: "budgets",
      title:
        resolved.proposedBudgets.length === 1
          ? `Presupuesto «${resolved.proposedBudgets[0].title}» sin decisión`
          : `${resolved.proposedBudgets.length} presupuestos sin decisión`,
      detail: "Presentado y pendiente de respuesta de quien decide.",
      action: go("plan", "Ver presupuestos"),
    })
  const openFollowUps = (followUpsQuery.data?.data ?? []).filter(
    (row) => row.status === "pendiente" || row.status === "programado",
  )
  const unscheduled = openFollowUps.filter((row) => row.status === "pendiente")
  if (unscheduled.length > 0)
    pending.push({
      id: "follow-ups",
      title:
        unscheduled.length === 1
          ? `Control por programar: ${unscheduled[0].title}`
          : `${unscheduled.length} controles por programar`,
      detail: `Vence el ${formatDate(unscheduled[0].dueAt)}.`,
      action: go("controles", "Programar"),
    })
  if (resolved && resolved.planPending.count > 0)
    pending.push({
      id: "plan-pending",
      title: `${resolved.planPending.count} tratamiento(s) aceptado(s) por ejecutar`,
      detail: "Aceptados por el paciente y aún sin realizar.",
      action: go("recorrido", "Ver tratamientos"),
    })
  const coordination = coordinationQuery.data?.data
  if (coordination) {
    const toBook = coordination.followUps.filter(
      (control) =>
        control.status === "pendiente" &&
        control.appointment?.status !== "programada" &&
        control.appointment?.status !== "confirmada",
    )
    if (toBook.length > 0)
      pending.push({
        id: "coordination-follow-ups",
        title:
          toBook.length === 1
            ? `Control por reservar: ${toBook[0].title}`
            : `${toBook.length} controles por reservar`,
        detail: `Corresponde el ${formatDate(toBook[0].dueAt)}.`,
        action: go("coordinacion", "Reservar"),
      })
    if (coordination.budgetsAwaitingDecision.length > 0)
      pending.push({
        id: "coordination-budgets",
        title:
          coordination.budgetsAwaitingDecision.length === 1
            ? `Presupuesto «${coordination.budgetsAwaitingDecision[0].title}» sin decisión`
            : `${coordination.budgetsAwaitingDecision.length} presupuestos sin decisión`,
        detail: "Presentado y pendiente de respuesta de quien decide.",
        action: go("coordinacion", "Hacer seguimiento"),
      })
  }
  const balances = accountQuery.data?.data.byCurrency ?? []
  for (const balance of balances) {
    if (balance.porCobrar > 0)
      pending.push({
        id: `balance-${balance.currency}`,
        title: `Saldo por cobrar de ${money(balance.porCobrar, balance.currency)}`,
        detail:
          balance.aFavor > 0
            ? `Hay un anticipo disponible de ${money(balance.aFavor, balance.currency)}.`
            : "Cargos emitidos sin pago aplicado.",
        action: go("cuenta", "Ir a la cuenta"),
      })
  }
  const age = Number(ageFrom(patient.birthDate))
  const isMinor = patient.birthDate != null && Number.isFinite(age) && age < 18
  const current = (responsibilitiesQuery.data?.data ?? []).filter((row) => row.isCurrent)
  if (
    isMinor &&
    responsibilitiesQuery.isSuccess &&
    !current.some((row) => row.kind === "representante_legal")
  )
    pending.push({
      id: "minor-representative",
      title: "Menor sin representante legal registrado",
      detail:
        "Sin representante vigente no se pueden decidir presupuestos ni firmar consentimientos.",
      action: go("responsables", "Registrar"),
    })
  if (canEditPatient) {
    const gaps = [
      !patient.docNumber && "documento",
      !patient.birthDate && "fecha de nacimiento",
      !patient.emergencyContactName && "contacto de emergencia",
    ].filter(Boolean)
    if (gaps.length > 0)
      pending.push({
        id: "filiacion",
        title: "Filiación incompleta",
        detail: `Falta: ${gaps.join(", ")}.`,
        action: go("filiacion", "Completar"),
      })
    // Todo paciente tiene su propia persona; lo que puede faltar es cómo ubicarla.
    if (!detail.contacts.some((link) => link.phone || link.email))
      pending.push({
        id: "contacts",
        title: "Sin datos de contacto",
        detail: "Ni la persona ni sus interlocutores tienen teléfono o correo registrados.",
        action: go("contactos", "Revisar"),
      })
  }

  for (const task of tasksQuery.data?.data ?? [])
    pending.push({
      id: `task-${task.id}`,
      title: `Tarea: ${task.title}`,
      detail: task.dueAt ? `Vence el ${formatDate(task.dueAt)}.` : "Sin fecha límite.",
      action: (
        <Link to="/tasks" className={buttonVariants({ size: "sm", variant: "outline" })}>
          Ver tareas
        </Link>
      ),
    })

  const upcoming = appointmentsQuery.data ? nextAppointment(appointmentsQuery.data.data) : null
  const lastVisit = resolved?.lastVisit ?? null
  const journeys = resolved?.treatmentJourneys ?? []
  const preferred = detail.contacts.find((contact) => contact.isPreferred) ?? detail.contacts[0]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {canClinical && resolved?.openEncounter ? (
        <OpenEncounterCard patientId={patientId} encounter={resolved.openEncounter} />
      ) : null}
      {canClinical ? <ClinicalShortcuts onOpen={(section) => onTabChange(section)} /> : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {canClinical && healthQuery.isSuccess ? (
            <ClinicalAlertsCard health={health} action={go("antecedentes", "Antecedentes")} />
          ) : null}
          <Card title="Pendientes" action={<NewPatientTaskButton patientId={patientId} />}>
            {pending.length === 0 ? (
              <EmptyState
                icon={CircleCheck}
                title="Sin pendientes"
                description="No hay nada que requiera tu acción sobre esta persona ahora."
              />
            ) : (
              <ul className="flex flex-col divide-y">
                {pending.map((item) => (
                  <li
                    key={item.id}
                    className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
                      item.agent
                        ? "my-2 rounded-lg border border-agent-border bg-agent-soft px-3"
                        : "first:pt-0 last:pb-0"
                    }`}
                  >
                    {item.agent ? <AgentMark size="sm" /> : null}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-sm text-muted-foreground">{item.detail}</p>
                    </div>
                    {item.action}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {canClinical ? (
            <Card
              title="Tratamientos y seguimiento"
              action={journeys.length > 0 ? go("odontograma", "Ver odontograma y plan") : undefined}
            >
              {journeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sin tratamientos indicados. Se indican durante una atención abierta.
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {journeys.slice(0, 6).map((row) => (
                    <li
                      key={row.item.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {row.item.toothNumber ? `Pieza ${row.item.toothNumber} · ` : "General · "}
                          {row.item.title}
                        </span>
                        <span className="text-muted-foreground">
                          {row.nextAction
                            ? NEXT_ACTION_LABELS[row.nextAction]
                            : "Sin acción pendiente"}{" "}
                          · decisión {planDecisionLabel(row.decision)} · ejecución{" "}
                          {planStatusLabel(row.clinicalStatus)}
                          {row.nextFollowUp
                            ? ` · control ${formatDate(row.nextFollowUp.dueAt)}`
                            : ""}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onTabChange("recorrido", undefined, row.item.id)}
                      >
                        Ver detalle
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {canAppointments ? (
            <Card title="Próxima cita" action={go("citas", "Ver citas")}>
              {appointmentsQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Consultando la agenda…</p>
              ) : appointmentsQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se pudo consultar la agenda.
                </p>
              ) : upcoming ? (
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{appointmentWhen(upcoming)}</span>
                  <span className="text-muted-foreground">
                    {[upcoming.serviceName ?? upcoming.reason, upcoming.dentistName]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <Badge variant={upcoming.status === "confirmada" ? "success" : "soft"}>
                    {APPOINTMENT_STATUS_LABELS[upcoming.status]}
                  </Badge>
                </div>
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-muted-foreground">Sin cita reservada.</p>
                  {canBook ? (
                    <Link to="/agenda" search={{ patientId }} className={buttonVariants({ size: "sm" })}>
                      Agendar cita
                    </Link>
                  ) : null}
                </div>
              )}
            </Card>
          ) : null}

          {canClinical ? (
            <RecentImagesCard
              patientId={patientId}
              documents={resolved?.recentDocuments ?? []}
              onOpen={(section) => onTabChange(section)}
            />
          ) : null}

          {canClinical ? (
            <Card title="Última atención">
              {lastVisit ? (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="font-medium">
                    {lastVisit.reason || "Atención finalizada"}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {timeAgo(lastVisit.finalizedAt ?? "")}
                    </span>
                  </p>
                  {lastVisit.evolution ? (
                    <p className="whitespace-pre-wrap">
                      {lastVisit.evolution.length > 280
                        ? `${lastVisit.evolution.slice(0, 280)}…`
                        : lastVisit.evolution}
                    </p>
                  ) : null}
                  <div>
                    <Link
                      to="/patients/$patientId/encounters/$encounterId"
                      params={{ patientId, encounterId: lastVisit.encounterId }}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Abrir esta atención
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sin atenciones registradas. La atención se inicia desde la cabecera de la ficha.
                </p>
              )}
            </Card>
          ) : null}

          {canFinance ? (
            <Card title="Cuenta" action={go("cuenta", "Gestionar cuenta")}>
              {accountQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Consultando la cuenta…</p>
              ) : accountQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se pudo consultar la cuenta.
                </p>
              ) : balances.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sin movimientos económicos: aceptar una propuesta no genera cargos.
                </p>
              ) : (
                <dl className="grid grid-cols-2 gap-4">
                  {balances.map((balance) => (
                    <div key={balance.currency}>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                        Por cobrar ({balance.currency})
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums">
                        {money(balance.porCobrar, balance.currency)}
                      </dd>
                      <dd className="text-xs text-muted-foreground">
                        anticipo disponible{" "}
                        {money(balance.aFavor, balance.currency)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          ) : null}

          {canPatients ? (
            <Card
              title="Quién habla y quién decide"
              action={go("responsables", "Ver responsables")}
            >
              <div className="flex flex-col gap-2 text-sm">
                {preferred ? (
                  <p>
                    <span className="font-medium">{preferred.displayName}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {preferred.relationship === "self" ? "titular" : "interlocutor"}
                      {preferred.isPreferred ? " · contacto preferido" : ""}
                    </span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">Sin interlocutor vinculado.</p>
                )}
                {current.length === 0 ? (
                  <p className="text-muted-foreground">
                    {isMinor
                      ? "Sin responsables vigentes."
                      : "Decide por sí mismo: sin responsables registrados."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {current.map((row) => (
                      <li key={row.id}>
                        <span className="font-medium">{row.contact.displayName}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {RESPONSIBILITY_KIND_LABELS[row.kind]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
