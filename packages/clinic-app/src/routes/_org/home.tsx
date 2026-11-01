import { Button, buttonVariants, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { AdminRecommendationDrawer, AdminUnreachedDrawer } from "../../components/agent/admin-recommendation"
import { openAppointmentAnywhere } from "../../components/agenda/schedule-host"
import { AlsoList, CallPanel, DuplicatePanel, EncounterPanel, InventoryPanel, PromotionPanel, VisitPanel } from "../../components/home/row-panels"
import { BudgetReviewDrawer } from "../../components/patient/plan/budget-review"
import { PersonPanel, type PersonPanelTarget } from "../../components/person/person-panel"
import { invalidateAgentWork } from "../../lib/agent-work"
import { useCompleteTask } from "../../components/crm/complete-task"
import { TaskDrawer } from "../../components/crm/task-drawer"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { AwayLine } from "../../components/home/away-line"
import { useAppointmentArrival, useAppointmentVisitStatus } from "../../components/agenda/arrival"
import { useAttendAppointment } from "../../components/patient/new-encounter-button"
import { DataRequestDrawer } from "../../components/patient/data-requests-panel"
import { BudgetAnswerDrawer } from "../../components/patient/plan/next-step-action"
import { PortalResendDrawer } from "../../components/portal/portal-access-section"
import { RegistrationHoldDrawer } from "../../components/home/registration-hold-drawer"
import { AgendaLine, type BranchChoice, CashLine, TodayAgenda, TodayCash, TodayPatients } from "../../components/home/today"
import { WaitingList } from "../../components/home/waiting-list"
import { ReportListDrawer } from "../../components/reports/report-list-drawer"
import { HomePageSkeleton, HomeSkeleton } from "../../components/skeletons/home"
import { HomeStart, needsSetup } from "../../components/home-start"
import { useActiveBranch } from "../../lib/active-branch"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { createReorderDrafts } from "../../lib/inventory"
import { usePermission } from "../../lib/crm"
import { type DebtRow, invalidateFinance } from "../../lib/finance-cash"
import { type CollectResultBody, useOrgFinanceProfile } from "../../lib/finance-collect"
import { daysAgo, longDay, repliable, replyName, waitingKey } from "../../lib/home"
import { isReceiptOnly, useOrgEvents } from "../../lib/org-events"
import type { WaitingEntry, WaitingRow, WorkspaceCash, WorkspaceHome } from "../../lib/workspace"

export const Route = createFileRoute("/_org/home")({
  /** La sede de la agenda y la caja viaja en el enlace, como en las demás pantallas por sede. */
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    ...(typeof search.branch === "string" && search.branch ? { branch: search.branch } : {}),
  }),
  pendingComponent: HomePageSkeleton,
  component: HomePage,
})

/** Eventos que dejan obsoleto Inicio (la consulta periódica de 5 min cubre huecos). */
const HOME_EVENTS = [
  "message.created",
  "message.updated",
  "conversation.updated",
  "agent.proposal.created",
  "agent.proposal.decided",
  "agent.proposal.executed",
  "agent.handoff.created",
  "appointment.updated",
  "task.updated",
  "payment.created",
  "payment.voided",
  "opportunity.updated",
  "contact.updated",
  "stream.reconnected",
]

type CaseRow = Extract<WaitingRow, { kind: "case" }>
type StaleEncounterRow = Extract<WaitingRow, { kind: "staleEncounter" }>
type DuplicateRow = Extract<WaitingRow, { kind: "possibleDuplicate" }>
type InventoryRow = Extract<WaitingRow, { kind: "inventory" }>

/** El motivo de anular una atención, con el mismo tope que `POST /api/patients/:id/encounters/:encounterId/void`. */
const VOID_REASON_MAX = 2000
const voidReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe por qué se anula la atención.")
    .max(VOID_REASON_MAX, `Escribe como mucho ${VOID_REASON_MAX} caracteres.`),
})

/** Tiene al menos un dominio de trabajo; sin ninguno no hay nada que mostrarle. */
function hasWork(access: WorkspaceHome["access"]): boolean {
  return access.patients || access.appointments || access.conversations || access.tasks || access.finance || access.clinical || access.crm || access.agent
}

function HomePage() {
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  const query = useQuery({
    queryKey: ["workspace-home", sede.branchId ?? null],
    queryFn: () => apiFetch<{ data: WorkspaceHome }>(`/api/workspace/home${sede.branchId ? `?branch=${encodeURIComponent(sede.branchId)}` : ""}`),
    // Al cambiar de sede se conserva lo anterior a la vista mientras llega lo nuevo.
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
  useOrgEvents(HOME_EVENTS, (kind, data) => {
    if (!isReceiptOnly(kind, data)) refresh()
  })

  const canDoTasks = usePermission("tasks.write")
  const canOrder = usePermission("inventory.write")
  // «Hecha» en la fila.
  const completion = useCompleteTask(refresh)
  // «Confirmar» el representante que nombró un registro en línea: vínculo y rol a nombre de quien confirma.
  const canWritePatients = usePermission("patients.write")
  const canWriteAppointments = usePermission("appointments.write")
  // «Llegó» desde la fila de quien terminó su registro: la misma operación que la Agenda.
  const arrival = useAppointmentArrival()
  // «No vino» y «Confirmar cita» desde la fila: la misma operación que la Agenda.
  const visitStatus = useAppointmentVisitStatus()
  // «Registrar la atención» de una cita que quedó sin cerrar: la misma de la Agenda.
  const canAttend = usePermission("clinical.write")
  const attend = useAttendAppointment()
  // Quienes aceptaron y no tienen cita: la lista de Reportes, al lado, para agendarlos desde aquí.
  const [acceptedList, setAcceptedList] = useState(false)
  const confirmRepresentative = useMutation({
    mutationFn: (row: DuplicateRow) =>
      apiFetch(`/api/patients/${row.patientId}/responsibilities/pending/${row.id}/confirm`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_result, row) => {
      toast.success(`${row.personName ?? "La persona"} quedó como representante de ${row.patientName}`)
      refresh()
    },
  })
  // «No es representante» y «Descartar»: lo que dejó un registro en línea queda cerrado con su motivo, sin cambiar a nadie.
  const discardRegistration = useMutation({
    mutationFn: (row: DuplicateRow) => apiFetch(`/api/tasks/${row.id}/discard`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_result, row) => {
      toast.success(row.source === "representante" ? `No se vinculó a ${row.personName ?? "esa persona"}` : "Se descartó")
      refresh()
    },
  })
  const busyKey = confirmRepresentative.isPending && confirmRepresentative.variables
    ? waitingKey(confirmRepresentative.variables)
    : discardRegistration.isPending && discardRegistration.variables
      ? waitingKey(discardRegistration.variables)
      : arrival.isPending && arrival.variables
        ? `registrationDone:${arrival.variables.id}`
        : completion.pendingId
          ? `task:${completion.pendingId}`
          : null
  const actionError =
    (confirmRepresentative.error ? submitErrorMessage(confirmRepresentative.error) : null) ??
    (discardRegistration.error ? submitErrorMessage(discardRegistration.error) : null) ??
    completion.error

  // Lo que la fila abre al lado. Sus datos salen de lo último que llegó: lo que se resuelve se va de la lista.
  const [opened, setOpened] = useState<WaitingRow | null>(null)
  // «¿Es la misma persona?»: la fila del registro por el código QR que se revisa.
  const [holdTask, setHoldTask] = useState<string | null>(null)
  const [advice, setAdvice] = useState<string | null>(null)
  const [unreached, setUnreached] = useState(false)
  const [budgetsOpen, setBudgetsOpen] = useState(false)
  // «¿Qué respondió?» del presupuesto que se anota, sin salir de la lista.
  const [answering, setAnswering] = useState<{ patientId: string; budgetId: string } | null>(null)
  const canAnswerBudgets = usePermission("budgets.write")
  const canSendBudgets = usePermission("budgets.send")
  // Para quién es lo que se abre al lado de una persona.
  const [person, setPerson] = useState<PersonPanelTarget | null>(null)
  const [reviewing, setReviewing] = useState<{ patientId: string; budgetId: string } | null>(null)
  // La tarea que se abre al lado desde su fila.
  const canReadTasks = usePermission("tasks.read")
  const [openTask, setOpenTask] = useState<string | null>(null)
  // El pedido sobre sus datos y el reenvío del portal: los mismos cajones de la ficha.
  const [dataRequest, setDataRequest] = useState<{ patientId: string; requestId: string } | null>(null)
  const [portalResend, setPortalResend] = useState<{ patientId: string; grantId: string } | null>(null)
  // «Anular con motivo» una atención de otro día sin cerrar: la misma anulación de la atención.
  const [discarding, setDiscarding] = useState<StaleEncounterRow | null>(null)
  const discard = useMutation({
    mutationFn: (input: { row: StaleEncounterRow; reason: string }) =>
      apiFetch(`/api/patients/${input.row.patientId}/encounters/${input.row.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason }),
      }),
    onSuccess: async (_result, input) => {
      toast.success(`Se anuló la atención de ${input.row.patientName}`)
      setDiscarding(null)
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", input.row.patientId] })
      refresh()
    },
  })
  // El motivo es un campo con su error; lo que el servidor rechaza sin campo (ya anulada, no es quien la atiende,
  // indicaciones ya presupuestadas) se dice en el diálogo, junto a sus botones.
  const discardForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: voidReasonSchema },
    onSubmit: async ({ value }) => {
      if (discarding) await discard.mutateAsync({ row: discarding, reason: value.reason.trim() })
    },
  })
  const discardError = useFormSubmitError(discardForm)
  const discardPending = useStore(discardForm.store, (state) => state.isSubmitting)

  const receptionName = useReceptionName()
  const data = query.data?.data
  const context = data
    ? { today: data.date, timezone: data.timezone, locale: data.locale, allTasks: data.access.allTasks, receptionName, canAttend }
    : null
  const choice = { branches: sede.branches, onChange: (id: string) => sede.choose(id) }
  // ¿Esta fila abre algo al lado? Si no, lleva a donde se resuelve.
  function opensBeside(row: WaitingRow): boolean {
    switch (row.kind) {
      case "case":
        return row.conversationId !== null ? true : row.taskId !== null && canReadTasks
      case "person":
      case "advice":
      case "unreached":
      case "budgets":
      case "acceptedUnbooked":
      case "unconfirmed":
      case "unclosed":
      case "staleEncounter":
      case "registrationDone":
      case "promotions":
        return true
      case "stillOpen":
        return row.conversationId !== null
      case "unsentBudget":
        return canSendBudgets
      case "possibleDuplicate":
        return canDoTasks
      case "dataRequest":
        return canWritePatients
      case "portalReentry":
        return canWritePatients && row.grantId !== null
      case "inventory":
        return canOrder
      case "task":
        return row.more === 0 && canReadTasks && row.href.startsWith("/tasks")
      default:
        return false
    }
  }
  /** Abre al lado lo que la fila pide resolver. Lo demás de la persona sigue en la lista y en «También». */
  function openRow(row: WaitingRow) {
    switch (row.kind) {
      case "case":
        if (row.conversationId) setPerson({ conversationId: row.conversationId, topicId: row.id, name: row.contactName ?? "Interlocutor" })
        else if (row.taskId) setOpenTask(row.taskId)
        setOpened(row)
        return
      case "person":
        setPerson({ conversationId: row.conversationId, name: row.contactName ?? "Interlocutor" })
        setOpened(row)
        return
      case "stillOpen":
        if (row.conversationId) setPerson({ conversationId: row.conversationId, name: row.contactName ?? "Interlocutor" })
        setOpened(row)
        return
      case "registrationDone":
        openAppointmentAnywhere(row.appointmentId)
        return
      case "advice":
        setAdvice(row.key)
        return
      case "unreached":
        setUnreached(true)
        return
      case "budgets":
        setBudgetsOpen(true)
        return
      case "acceptedUnbooked":
        setAcceptedList(true)
        return
      case "unsentBudget":
        setReviewing({ patientId: row.patientId, budgetId: row.id })
        return
      case "possibleDuplicate":
        if (row.source === "registro" && row.held && canWritePatients) setHoldTask(row.id)
        else setOpened(row)
        return
      case "dataRequest":
        setDataRequest({ patientId: row.patientId, requestId: row.id })
        return
      case "portalReentry":
        if (row.grantId) setPortalResend({ patientId: row.patientId, grantId: row.grantId })
        return
      case "task":
        setOpenTask(row.id)
        return
      default:
        setOpened(row)
    }
  }
  /** Lo que hace el botón de «También»: lo de la fila, o su acción directa. */
  function runRow(row: WaitingRow) {
    if (row.kind === "registrationDone" && canWriteAppointments) {
      arrival.mutate({ id: row.appointmentId, arrived: true, patient: { id: row.patientId, name: row.patientName } })
      return
    }
    if (row.kind === "task" && canDoTasks) {
      void completion.complete(row.id)
      return
    }
    openRow(row)
  }
  const closePanel = () => {
    setOpened(null)
    setPerson(null)
  }
  // Lo demás de la persona abierta, leído de la lista: lo que se resuelve desaparece.
  const openedEntry: WaitingEntry | null = opened ? (data?.waiting.find((row) => waitingKey(row) === waitingKey(opened)) ?? null) : null
  const openedAlso = openedEntry?.also?.length && context ? <AlsoList rows={openedEntry.also} context={context} onRun={runRow} /> : null
  // «Siguiente: Rosa Quispe»: la próxima fila que se puede responder, nunca solo.
  const nextRow = opened
    ? (data?.waiting.slice((data.waiting.findIndex((row) => waitingKey(row) === waitingKey(opened)) ?? -1) + 1).find((row) => repliable(row)) ?? null)
    : null
  const next = nextRow ? { name: replyName(nextRow) ?? "la siguiente persona", open: () => openRow(nextRow) } : null
  // La lista sale de lo último que llegó: lo que se anota se va de ella.
  const budgets = budgetsOpen ? (data?.waiting.find((row): row is Extract<WaitingEntry, { kind: "budgets" }> => row.kind === "budgets") ?? null) : null
  return <PageShell className="flex flex-col gap-4">
    <PageHeader title="Inicio" subtitle={data ? longDay(data.date, data.locale) : "Lo que te toca hoy"} />
    <AwayLine canSeeAgenda={data?.access.appointments ?? false} />
    {query.isError && !data ? (
      <ErrorState title="No pudimos cargar tu jornada" message="Revisa tu conexión." retryLabel="Reintentar" onRetry={() => void query.refetch()} />
    ) : !data || !context ? (
      <SkeletonRegion>
        <HomeSkeleton />
      </SkeletonRegion>
    ) : !hasWork(data.access) ? (
      <EmptyState title="Aún no tienes nada asignado" description="Pide a la administración los permisos que necesitas para tu trabajo." />
    ) : needsSetup(data) && data.setup ? (
      <HomeStart setup={data.setup} />
    ) : (
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[3_1_30rem]">
          <WaitingList
            rows={data.waiting}
            context={context}
            error={actionError}
            handlers={{
              onOpen: openRow,
              opensBeside,
              onDone: canDoTasks ? (row) => void completion.complete(row.id) : undefined,
              onArrived: canWriteAppointments
                ? (row) => arrival.mutate({ id: row.appointmentId, arrived: true, patient: { id: row.patientId, name: row.patientName } })
                : undefined,
              busyKey,
            }}
          />
        </div>
        {data.today || data.cash ? (
          <div className="flex min-w-0 flex-[2_1_21rem] flex-col gap-4">
            {data.today?.scope === "mine" ? (
              <TodayPatients today={data.today} locale={data.locale} multiBranch={data.multiBranch} />
            ) : data.today ? (
              <TodayAgenda today={data.today} locale={data.locale} choice={choice} />
            ) : null}
            {/* Quien atiende y además ve la sede (la dueña que atiende): la agenda de la sede en una línea. */}
            {data.agendaLine ? <AgendaLine line={data.agendaLine} /> : null}
            {/* Quien solo cobra tiene la caja como su «Hoy»; quien además ve la agenda, una línea. */}
            {data.cash && data.today ? (
              <CashLine cash={data.cash} locale={data.locale} />
            ) : data.cash ? (
              <CashOfToday cash={data.cash} locale={data.locale} choice={choice} onChanged={refresh} />
            ) : null}
          </div>
        ) : null}
      </div>
    )}

    <ConfirmDialog
      open={discarding !== null}
      title="Anular la atención"
      description={discarding ? `La atención de ${discarding.patientName} queda anulada en su historia, con tu motivo. No genera cargos y su ficha queda libre para otra atención.` : ""}
      confirmLabel="Anular la atención"
      cancelLabel="Volver"
      pending={discardPending}
      error={discardError}
      onClose={() => setDiscarding(null)}
      onConfirm={() => void submitForm(discardForm)}
    >
      <discardForm.AppField name="reason">
        {(field) => (
          <field.TextareaField
            id="anular-atencion-motivo"
            label="Motivo"
            className="text-left"
            maxLength={VOID_REASON_MAX}
            rows={3}
            placeholder="Ej.: se abrió por error"
            aria-required
          />
        )}
      </discardForm.AppField>
    </ConfirmDialog>
    <RegistrationHoldDrawer taskId={holdTask} onClose={() => setHoldTask(null)} />
    <PersonPanel target={person} also={openedAlso} next={next} onClose={closePanel} onChanged={refresh} />
    {context && opened?.kind === "unclosed" ? (
      <VisitPanel row={opened} also={openedAlso} context={context} canAttend={canAttend} canWrite={canWriteAppointments} onClose={closePanel} onChanged={refresh} />
    ) : null}
    {context && opened?.kind === "unconfirmed" ? (
      <CallPanel row={opened} also={openedAlso} context={context} canWrite={canWriteAppointments} onClose={closePanel} onChanged={refresh} />
    ) : null}
    {context && opened?.kind === "staleEncounter" ? (
      <EncounterPanel
        row={opened}
        also={openedAlso}
        context={context}
        canVoid
        onClose={closePanel}
        onChanged={refresh}
        onVoid={() => {
          const row = opened
          closePanel()
          discardForm.reset({ reason: "" })
          setDiscarding(row)
        }}
      />
    ) : null}
    {context && opened?.kind === "possibleDuplicate" ? (
      <DuplicatePanel
        row={opened}
        also={openedAlso}
        context={context}
        pending={confirmRepresentative.isPending || discardRegistration.isPending || completion.pendingId !== null}
        error={actionError}
        onClose={closePanel}
        onConfirm={canWritePatients && canDoTasks ? () => confirmRepresentative.mutate(opened, { onSuccess: closePanel }) : undefined}
        onDiscard={canDoTasks ? () => discardRegistration.mutate(opened, { onSuccess: closePanel }) : undefined}
        onReviewed={canDoTasks ? () => void completion.complete(opened.id).then(closePanel) : undefined}
        compareLink={
          opened.patientId ? (
            <Link to="/patients/$patientId" params={{ patientId: opened.patientId }} search={{ tab: "filiacion" }} className={buttonVariants({ variant: "ghost" })}>
              Ver la ficha
            </Link>
          ) : opened.personId ? (
            <Link to="/people/$personId" params={{ personId: opened.personId }} className={buttonVariants({ variant: "ghost" })}>
              Ver la ficha
            </Link>
          ) : null
        }
      />
    ) : null}
    {opened?.kind === "inventory" ? <InventoryPanel row={opened} onClose={closePanel} onChanged={refresh} /> : null}
    {opened?.kind === "promotions" ? <PromotionPanel items={opened.items} onClose={closePanel} onChanged={refresh} /> : null}
    {reviewing ? (
      <BudgetReviewDrawer
        patientId={reviewing.patientId}
        budgetId={reviewing.budgetId}
        onClose={() => setReviewing(null)}
        onSent={() => {
          setReviewing(null)
          refresh()
        }}
      />
    ) : null}
    <AdminRecommendationDrawer recommendationKey={advice} onClose={() => setAdvice(null)} />
      {/* «Ver la lista»: se agenda desde cada fila sin salir de Inicio (tablero 12). */}
      {acceptedList ? (
        <ReportListDrawer
          list="upcoming_unbooked"
          query={{ period: "este_mes" }}
          onClose={() => {
            setAcceptedList(false)
            refresh()
          }}
        />
      ) : null}
    <AdminUnreachedDrawer open={unreached} onClose={() => setUnreached(false)} />
    <DetailDrawer
      open={budgets !== null}
      onClose={() => setBudgetsOpen(false)}
      title="Presupuestos que esperan respuesta"
      description={budgets && budgets.items.length < budgets.total ? `Los ${budgets.items.length} más antiguos de ${budgets.total}` : undefined}
    >
      {budgets && context ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {budgets.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
              <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
                <span className="font-semibold">{item.patientName}</span>
                <span>{item.title}</span>
                <span className="text-muted-foreground">{item.presentedAt ? `Se presentó ${daysAgo(item.presentedAt, context)}` : "Aún sin fecha de presentación"}</span>
              </span>
              {canAnswerBudgets ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 shrink-0 max-sm:w-full sm:min-h-8"
                  aria-label={`¿Qué respondió? ${item.patientName}`}
                  onClick={() => setAnswering({ patientId: item.patientId, budgetId: item.id })}
                >
                  ¿Qué respondió?
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </DetailDrawer>
    {answering ? (
      <BudgetAnswerDrawer
        patientId={answering.patientId}
        budgetId={answering.budgetId}
        onClose={() => {
          setAnswering(null)
          refresh()
        }}
      />
    ) : null}
    {dataRequest ? (
      <DataRequestDrawer
        patientId={dataRequest.patientId}
        requestId={dataRequest.requestId}
        onClose={() => {
          setDataRequest(null)
          refresh()
        }}
      />
    ) : null}
    {portalResend ? (
      <PortalResendDrawer
        patientId={portalResend.patientId}
        grantId={portalResend.grantId}
        onClose={() => {
          setPortalResend(null)
          refresh()
        }}
      />
    ) : null}
    <TaskDrawer
      open={openTask !== null}
      taskId={openTask ?? undefined}
      onClose={() => setOpenTask(null)}
      onSaved={refresh}
    />
  </PageShell>
}

/**
 * La caja como «Hoy» de quien cobra. «Cobrar» abre el mismo cobro que
 * Finanzas › Caja y, al terminar, el mismo ticket.
 */
function CashOfToday({ cash, locale, choice, onChanged }: { cash: WorkspaceCash; locale: string; choice: BranchChoice; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const canCollect = usePermission("finance.write")
  const profile = useOrgFinanceProfile().data?.data ?? null
  const [collecting, setCollecting] = useState<DebtRow | null>(null)
  const [ticket, setTicket] = useState<{ result: CollectResultBody; patientId: string } | null>(null)
  const changed = () => {
    invalidateFinance(queryClient)
    onChanged()
  }
  return <>
    <TodayCash cash={cash} locale={locale} choice={choice} onCollect={canCollect ? setCollecting : undefined} />
    <CollectDrawer
      patientId={collecting?.patientId ?? null}
      patientName={collecting?.displayName || undefined}
      branchId={cash.branchId}
      branchName={cash.branchName}
      currency={cash.currency}
      locale={locale}
      open={collecting !== null}
      onClose={() => setCollecting(null)}
      onCollected={(result, patientId) => {
        changed()
        setTicket({ result, patientId })
      }}
    />
    <DetailDrawer
      open={ticket !== null}
      onClose={() => setTicket(null)}
      title={ticket ? `Cobro registrado · Ticket ${ticketDisplayNumber(ticket.result.ticket.ticketNumber)}` : "Cobro registrado"}
    >
      {ticket && profile ? (
        <TicketView
          ticket={ticket.result.ticket}
          remainingCents={ticket.result.remainingCents}
          receipt={ticket.result.receipt ?? null}
          patientName={ticket.result.ticket.snapshot.patient.displayName}
          branchName={ticket.result.ticket.snapshot.branch.name}
          locale={profile.locale}
          timeZone={cash.timezone}
          receiptWidth={profile.receiptWidth}
          ticketFooter={profile.ticketFooter}
          onChanged={() => {
            changed()
            void queryClient.invalidateQueries({ queryKey: ["patient-account3", ticket.patientId] })
          }}
        />
      ) : null}
    </DetailDrawer>
  </>
}
