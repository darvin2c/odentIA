import { formatMoney } from "@odentia/clinical"
import { Alert, AlertDescription, AlertTitle, Button, buttonVariants } from "@odentia/ui"
import { internationalText } from "@odentia/ui-patterns"
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import {
  type OpportunityListItem,
  type TaskItem,
  timeAgo,
  useCan,
  usePermission,
} from "../../lib/crm"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { conversationStatusLabel } from "../../lib/glossary"
import { useOrgProfile } from "../../lib/org"
import {
  appointmentWhen,
  nextAppointment,
  usePatientAppointments,
} from "../../lib/patient-appointments"
import type { PatientSectionId } from "../../lib/patient-areas"
import {
  ageFrom,
  fetchPatientHealth,
  hcLabel,
  type PatientFull,
  type PatientSummary,
} from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { type PersonConversation, type PersonPage, RELATIONSHIP_WORDS, relationshipText } from "../../lib/people"
import { TaskDrawer } from "../crm/task-drawer"
import { CreatePatientDrawer } from "../patient/create-patient-drawer"
import { NewEncounterButton } from "../patient/new-encounter-button"
import { useScheduleAccepted } from "../patient/plan/plan-budgets"
import { PlanNextCard } from "../patient/plan/plan-next"
import {
  ClinicalAlertsCard,
  LastVisitCard,
  OpenEncounterCard,
  UpcomingCard,
} from "../patient/resumen-clinico"
import { PatientPendingCard, SummaryCard } from "../patient/resumen-tab"
import { PersonLink } from "../person-link"
import { WriteToPersonDialog } from "../write-to-person"
import { PersonAgentMemory, PersonNotes } from "./person-notes"

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{children}</dd>
    </div>
  )
}

/** Conversaciones de la persona: el Resumen dice la última y la pestaña las lista todas. */
export function usePersonConversations(personId: string) {
  const canRead = usePermission("conversations.read")
  return useQuery({
    queryKey: ["person-conversations", personId],
    queryFn: () =>
      apiFetch<{ data: PersonConversation[] }>(`/api/people/${personId}/conversations`),
    enabled: canRead,
    retry: false,
  })
}

/**
 * Resumen de la persona (tablero 2): lo que hace falta para atenderla de un
 * vistazo —teléfono, alergias, próxima cita, saldo, conversación y
 * oportunidad—, «Falta registrarla como paciente» si aún no lo es, sus
 * pendientes, sus notas y lo que recuerda el agente. Cada dato se pide con su
 * permiso.
 *
 * Para quien lee la clínica es el Resumen clínico (ADR 0035): arriba la
 * atención en curso y cuatro tarjetas —alergias y alertas, «Qué sigue» del
 * plan, última atención y próxima cita—; recepción y caja ven el de siempre.
 */
export function PersonSummary({
  person,
  detail,
  summary,
  onSection,
}: {
  person: PersonPage
  detail?: PatientFull
  /** El resumen clínico que pidió la página: solo para quien lee la historia. */
  summary?: UseQueryResult<{ data: PatientSummary }>
  onSection: (
    section: PatientSectionId,
    tooth?: number,
    itemId?: string,
    planId?: string,
    budgetId?: string,
  ) => void
}) {
  const patientId = person.patient?.id ?? null
  const can = useCan()
  const canAlerts = can("clinical.alerts") || can("clinical.read")
  const canAppointments = usePermission("appointments.read")
  const canFinance = usePermission("finance.read")
  const canChats = usePermission("conversations.read")
  const canCrm = usePermission("crm.read")
  const canTasks = usePermission("tasks.read")
  const canRegister = usePermission("patients.write")
  const canSendLink = can("crm.write") && can("conversations.write")
  const profile = useOrgProfile()
  const locale = profile.data?.locale
  const [registering, setRegistering] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const canTaskWrite = usePermission("tasks.write")
  const queryClient = useQueryClient()
  const [sendingLink, setSendingLink] = useState(false)

  const clinical = Boolean(summary && patientId)
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId ?? ""),
    enabled: clinical,
  })
  const schedule = useScheduleAccepted(patientId ?? "")
  const appointments = usePatientAppointments(
    patientId ?? "none",
    canAppointments && Boolean(patientId),
  )
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId ?? ""),
    enabled: canFinance && Boolean(patientId),
  })
  const conversations = usePersonConversations(person.id)
  const opportunities = useQuery({
    queryKey: ["person-opportunities", person.id],
    queryFn: () =>
      apiFetch<{ data: OpportunityListItem[] }>(
        `/api/opportunities?contactId=${person.id}&limit=5`,
      ),
    enabled: canCrm,
    retry: false,
  })
  // Sin ficha, sus tareas cuelgan de la persona (las del paciente las lista «Pendientes»).
  const tasks = useQuery({
    queryKey: ["person-tasks", person.id],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=open&contactId=${person.id}`),
    enabled: !patientId && canTasks && canCrm,
    retry: false,
  })

  const upcoming = appointments.data ? nextAppointment(appointments.data.data) : null
  const outstanding = (account.data?.data.byCurrency ?? []).filter(
    (balance) => balance.porCobrar > 0,
  )
  const lastConversation = conversations.data?.data[0] ?? null
  const openOpportunity =
    (opportunities.data?.data ?? []).find((row) => row.status === "open") ?? null
  const allergies = (detail?.activeAllergies ?? []).filter(
    (allergy) => allergy.verification !== "descartada",
  )
  const phoneText = person.phone ? internationalText(person.phone) : null
  // Sin teléfono propio, el de quien habla por ella (la preferida primero, como la entrega el servidor).
  const spokenPhone = phoneText ? null : (person.spokenForBy.find((other) => other.phone) ?? null)

  const phoneLine = phoneText
    ? `Teléfono ${phoneText}${person.channels.includes("whatsapp") ? " · WhatsApp" : ""}`
    : spokenPhone?.phone
      ? `Teléfono de ${spokenPhone.displayName} (${relationshipText(spokenPhone.relationship, spokenPhone.relationshipDetail).toLowerCase()}) · ${internationalText(spokenPhone.phone)}`
      : "Sin teléfono"
  const clinicalData = summary?.data?.data
  // Lo que ya dicen las cuatro tarjetas clínicas no se repite en los datos de abajo.
  const showFacts =
    !clinical ||
    person.responsibleFor.length > 0 ||
    ((canChats || canCrm) && person.channels.length > 0) ||
    canFinance ||
    canChats ||
    canCrm

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {clinical && patientId ? (
        <>
          {clinicalData?.openEncounter ? (
            <OpenEncounterCard patientId={patientId} encounter={clinicalData.openEncounter} />
          ) : null}
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {health.isError ? (
              <QueryErrorState error={health.error} onRetry={() => void health.refetch()} />
            ) : (
              <ClinicalAlertsCard
                health={health.data?.data ?? null}
                onAntecedentes={() => onSection("antecedentes")}
              />
            )}
            <PlanNextCard
              patientId={patientId}
              onAction={(step) => {
                if (!step.action) return
                if ((step.kind === "agendar" || step.kind === "continuar") && step.action.planItemIds)
                  schedule(step.action.planItemIds, step.action.serviceId ?? null)
                else onSection("plan", undefined, undefined, undefined, step.action.budgetId)
              }}
            />
            {clinicalData ? (
              <LastVisitCard
                patientId={patientId}
                summary={clinicalData}
                attend={
                  person.archived ? null : (
                    <NewEncounterButton
                      patientId={patientId}
                      openEncounterId={clinicalData.openEncounterId}
                      variant="outline"
                      size="sm"
                    />
                  )
                }
              />
            ) : summary?.isError ? (
              <QueryErrorState error={summary.error} onRetry={() => void summary.refetch()} />
            ) : (
              <SummaryCard title="Última atención">
                <p className="text-sm text-muted-foreground">Consultando…</p>
              </SummaryCard>
            )}
            <UpcomingCard
              patientId={patientId}
              upcoming={upcoming}
              loading={canAppointments && appointments.isPending}
              failed={!canAppointments || appointments.isError}
              phone={phoneLine}
            />
          </div>
        </>
      ) : null}
      {showFacts ? (
      <section aria-label="Resumen" className="elevated rounded-xl border bg-card p-6">
        <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {person.responsibleFor.length > 0 ? (
            <Fact label="Responsable de">
              <span className="flex flex-col gap-0.5">
                {person.responsibleFor.map((row) => {
                  const age = ageFrom(row.birthDate)
                  return (
                    <span key={row.patientId}>
                      <PersonLink patientId={row.patientId} contactId={row.personId}>
                        {row.displayName}
                      </PersonLink>
                      <span className="font-normal text-muted-foreground">
                        {" · "}
                        {[
                          age ? `${age} años` : null,
                          hcLabel(row.patientNumber),
                          row.relationshipDetail || RELATIONSHIP_WORDS[row.relationship],
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  )
                })}
              </span>
            </Fact>
          ) : null}
          {clinical ? null : (
          <Fact label="Teléfono">
            {phoneText
              ? `${phoneText}${person.channels.includes("whatsapp") ? " · WhatsApp" : ""}`
              : spokenPhone?.phone
                ? `el de ${spokenPhone.displayName} (${relationshipText(spokenPhone.relationship, spokenPhone.relationshipDetail).toLowerCase()}) · ${internationalText(spokenPhone.phone)}`
                : "Sin teléfono"}
          </Fact>
          )}
          {(canChats || canCrm) && person.channels.length > 0 ? (
            <Fact label="Canales">
              {person.channels.map((channel) => channelLabel(channel)).join(", ")}
            </Fact>
          ) : null}
          {patientId && canAlerts && detail && !clinical ? (
            <Fact label="Alergias">
              {allergies.length === 0
                ? "Sin alergias registradas"
                : allergies.map((allergy) => allergy.substance).join(", ")}
            </Fact>
          ) : null}
          {canAppointments && !clinical ? (
            <Fact label="Próxima cita">
              {!patientId
                ? "Ninguna"
                : appointments.isPending
                  ? "Consultando…"
                  : appointments.isError
                    ? "No disponible"
                    : upcoming
                      ? [
                          appointmentWhen(upcoming),
                          upcoming.serviceName ?? upcoming.reason,
                          upcoming.dentistName,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Ninguna"}
            </Fact>
          ) : null}
          {patientId && canFinance ? (
            <Fact label="Saldo">
              {account.isPending
                ? "Consultando…"
                : account.isError
                  ? "No disponible"
                  : outstanding.length === 0
                    ? "Sin saldo por cobrar"
                    : locale
                      ? outstanding
                          .map((balance) =>
                            formatMoney(balance.porCobrar, balance.currency, locale),
                          )
                          .join(" · ")
                      : "…"}
            </Fact>
          ) : null}
          {canChats ? (
            <Fact label="Conversación">
              {conversations.isPending ? (
                "Consultando…"
              ) : lastConversation ? (
                <>
                  {conversationStatusLabel(lastConversation.status, lastConversation.closure)}
                  {lastConversation.lastMessageAt
                    ? ` · ${timeAgo(lastConversation.lastMessageAt)}`
                    : ""}
                  {" · "}
                  <Link
                    to="/inbox"
                    search={{ conversation: lastConversation.id }}
                    className="text-primary hover:underline"
                  >
                    Abrir
                  </Link>
                </>
              ) : (
                "Todavía no ha escrito"
              )}
            </Fact>
          ) : null}
          {canCrm ? (
            <Fact label="Oportunidad">
              {openOpportunity ? (
                <Link
                  to="/pipeline"
                  search={{ oportunidad: openOpportunity.id }}
                  className="text-primary hover:underline"
                >
                  {openOpportunity.title} · {openOpportunity.stageName}
                </Link>
              ) : (
                "Ninguna abierta"
              )}
            </Fact>
          ) : null}
        </dl>
      </section>
      ) : null}

      {person.kind === "por_registrar" && !person.archived ? (
        <Alert>
          <AlertTitle>Falta registrarla como paciente</AlertTitle>
          <AlertDescription>
            <span className="block">
              Se necesita antes de su primera atención. Puede hacerlo ella con «Su enlace», donde también elige su cita, o tú ahora.
            </span>
            {canSendLink || canRegister ? (
              <span className="mt-2 flex flex-wrap gap-2">
                {canSendLink ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSendingLink(true)}
                  >
                    Enviarle su enlace
                  </Button>
                ) : null}
                {canRegister ? (
                  <Button type="button" size="sm" onClick={() => setRegistering(true)}>
                    Registrar
                  </Button>
                ) : null}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {patientId && detail ? (
            <PatientPendingCard
              patientId={patientId}
              detail={detail}
              clinical={clinical ? { summary: clinicalData, health: health.data?.data } : undefined}
              onTabChange={onSection}
            />
          ) : !patientId && canTasks && canCrm ? (
            <SummaryCard
              title="Pendientes"
              action={
                canTaskWrite && !person.archived ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setNewTask(true)}
                  >
                    Nueva tarea
                  </Button>
                ) : undefined
              }
            >
              {(tasks.data?.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sin tareas abiertas para esta persona.
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {(tasks.data?.data ?? []).map((task) => (
                    <li
                      key={task.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="text-sm font-medium">{task.title}</span>
                      <Link
                        to="/tasks"
                        search={{ task: task.id }}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
                        Ver tarea
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SummaryCard>
          ) : null}
          <PersonNotes personId={person.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PersonAgentMemory personId={person.id} />
        </div>
      </div>

      <CreatePatientDrawer
        open={registering}
        onClose={() => setRegistering(false)}
        contactId={person.id}
        person={person}
        stayOnPage
      />
      {!patientId ? (
        <TaskDrawer
          open={newTask}
          contactId={person.id}
          onClose={() => setNewTask(false)}
          onSaved={() =>
            void queryClient.invalidateQueries({ queryKey: ["person-tasks", person.id] })
          }
        />
      ) : null}
      <WriteToPersonDialog
        open={sendingLink}
        onClose={() => setSendingLink(false)}
        people={[{ contactId: person.id, displayName: person.displayName }]}
        prepareRegistration
      />
    </div>
  )
}
