import { FieldLabel, Textarea, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { AdminRecommendationDrawer, AdminUnreachedDrawer } from "../../components/agent/admin-recommendation"
import { CaseBriefDrawer } from "../../components/agent/case-brief"
import { invalidateAgentPanelQueries, takeCase } from "../../components/agent-panel"
import { useCompleteTask } from "../../components/crm/resolve-preview"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { AwayLine } from "../../components/home/away-line"
import { useAppointmentArrival } from "../../components/agenda/arrival"
import { RegistrationHoldDrawer } from "../../components/home/registration-hold-drawer"
import { AgendaLine, type BranchChoice, CashLine, TodayAgenda, TodayCash, TodayPatients } from "../../components/home/today"
import { WaitingList } from "../../components/home/waiting-list"
import { HomeStart, needsSetup } from "../../components/home-start"
import { useActiveBranch } from "../../lib/active-branch"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { createReorderDrafts } from "../../lib/inventory"
import { usePermission } from "../../lib/crm"
import { type DebtRow, invalidateFinance } from "../../lib/finance-cash"
import { type CollectResultBody, useOrgFinanceProfile } from "../../lib/finance-collect"
import { daysAgo, longDay, waitingKey } from "../../lib/home"
import { mutationErrorMessage } from "../../lib/query-error"
import { useOrgEvents } from "../../lib/org-events"
import type { WaitingRow, WorkspaceCash, WorkspaceHome } from "../../lib/workspace"

export const Route = createFileRoute("/_org/home")({
  /** La sede de la agenda y la caja viaja en el enlace, como en las demás pantallas por sede. */
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    ...(typeof search.branch === "string" && search.branch ? { branch: search.branch } : {}),
  }),
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

type BudgetsRow = Extract<WaitingRow, { kind: "budgets" }>
type CaseRow = Extract<WaitingRow, { kind: "case" }>
type StaleEncounterRow = Extract<WaitingRow, { kind: "staleEncounter" }>
type DuplicateRow = Extract<WaitingRow, { kind: "possibleDuplicate" }>
type InventoryRow = Extract<WaitingRow, { kind: "inventory" }>

/** Tiene al menos un dominio de trabajo; sin ninguno no hay nada que mostrarle. */
function hasWork(access: WorkspaceHome["access"]): boolean {
  return access.patients || access.appointments || access.conversations || access.tasks || access.finance || access.clinical || access.crm || access.agent
}

function HomePage() {
  const queryClient = useQueryClient()
  const canTake = usePermission("conversations.write")
  const sede = useActiveBranch()
  const query = useQuery({
    queryKey: ["workspace-home", sede.branchId ?? null],
    queryFn: () => apiFetch<{ data: WorkspaceHome }>(`/api/workspace/home${sede.branchId ? `?branch=${encodeURIComponent(sede.branchId)}` : ""}`),
    // Hasta saber si la sede recordada sigue existiendo no se pide nada: evita pedir dos veces.
    enabled: sede.ready,
    // Al cambiar de sede se conserva lo anterior a la vista mientras llega lo nuevo.
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
  useOrgEvents(HOME_EVENTS, refresh)

  const canDoTasks = usePermission("tasks.write")
  // «Tomar este tema» desde la fila: la misma acción que en la Bandeja y el panel (toma el tema, no la conversación).
  const take = useMutation({
    mutationFn: (row: CaseRow) => takeCase({ id: row.id, conversationId: row.conversationId }),
    onSuccess: () => {
      invalidateAgentPanelQueries(queryClient)
      refresh()
    },
  })
  // «Hecha»: si la tarea resolviera una conversación, antes se muestra lo mismo que «Resolver».
  const completion = useCompleteTask(refresh)
  // «Confirmar» el representante que nombró un registro en línea: vínculo y rol a nombre de quien confirma.
  const canWritePatients = usePermission("patients.write")
  const canWriteAppointments = usePermission("appointments.write")
  // «Llegó» desde la fila de quien terminó su registro: la misma operación que la Agenda.
  const arrival = useAppointmentArrival()
  const confirmRepresentative = useMutation({
    mutationFn: (row: DuplicateRow) =>
      apiFetch(`/api/patients/${row.patientId}/responsibilities/pending/${row.id}/confirm`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_result, row) => {
      toast.success(`${row.personName ?? "La persona"} quedó como representante de ${row.patientName}`)
      refresh()
    },
  })
  // «No es ella» y «Descartar»: lo que dejó un registro en línea queda cerrado con su motivo, sin cambiar a nadie.
  const discardRegistration = useMutation({
    mutationFn: (row: DuplicateRow) => apiFetch(`/api/tasks/${row.id}/discard`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_result, row) => {
      toast.success(row.source === "representante" ? `No se vinculó a ${row.personName ?? "esa persona"}` : "Se descartó")
      refresh()
    },
  })
  // «Pedir lo que falta»: un borrador por proveedor con lo que hace falta en esa sede (ADR 0067);
  // se revisan y confirman en Compras.
  const navigate = useNavigate()
  const canOrder = usePermission("inventory.write")
  const reorder = useMutation({
    mutationFn: (row: InventoryRow) => createReorderDrafts(row.branchId),
    onSuccess: (result, row) => {
      const drafts = result.drafts.length
      const loose = result.withoutSupplier.length
      toast.success(
        drafts === 0
          ? loose > 0
            ? `Lo que falta en ${row.branchName} no tiene proveedor: elígelo en la compra.`
            : `Lo que falta en ${row.branchName} ya está en un borrador.`
          : `${drafts === 1 ? "Quedó 1 borrador" : `Quedaron ${drafts} borradores`} de compra para ${row.branchName}${loose > 0 ? `; ${loose === 1 ? "1 producto no tiene" : `${loose} productos no tienen`} proveedor` : ""}. Revísalos y confírmalos.`,
      )
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      refresh()
      void navigate({ to: "/inventory", search: { tab: "compras", branch: row.branchId, ver: "borradores" } })
    },
  })
  const busyKey = take.isPending && take.variables
    ? waitingKey(take.variables)
    : confirmRepresentative.isPending && confirmRepresentative.variables
      ? waitingKey(confirmRepresentative.variables)
      : discardRegistration.isPending && discardRegistration.variables
        ? waitingKey(discardRegistration.variables)
        : reorder.isPending && reorder.variables
          ? waitingKey(reorder.variables)
          : completion.pendingId
          ? `task:${completion.pendingId}`
          : null
  const busyAction = discardRegistration.isPending ? "descartar" : null
  const actionError =
    (take.error ? mutationErrorMessage(take.error) ?? "No se pudo tomar el caso." : null) ??
    (confirmRepresentative.error ? mutationErrorMessage(confirmRepresentative.error) ?? "No se pudo confirmar el representante." : null) ??
    (discardRegistration.error ? mutationErrorMessage(discardRegistration.error) ?? "No se pudo descartar." : null) ??
    (reorder.error ? mutationErrorMessage(reorder.error) ?? "No se armaron los borradores de compra." : null) ??
    completion.error

  const [briefFor, setBriefFor] = useState<{ conversationId: string; name: string } | null>(null)
  // «¿Es la misma persona?»: la fila del registro por el código QR que se revisa.
  const [holdTask, setHoldTask] = useState<string | null>(null)
  const [advice, setAdvice] = useState<string | null>(null)
  const [unreached, setUnreached] = useState(false)
  const [budgets, setBudgets] = useState<BudgetsRow | null>(null)
  // «Anular con motivo» una atención de otro día sin cerrar: la misma anulación de la atención.
  const [discarding, setDiscarding] = useState<StaleEncounterRow | null>(null)
  const [discardReason, setDiscardReason] = useState("")
  const discard = useMutation({
    mutationFn: (input: { row: StaleEncounterRow; reason: string }) =>
      apiFetch(`/api/patients/${input.row.patientId}/encounters/${input.row.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason }),
      }),
    onSuccess: async (_result, input) => {
      toast.success(`Se anuló la atención de ${input.row.patientName}`)
      setDiscarding(null)
      setDiscardReason("")
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", input.row.patientId] })
      refresh()
    },
    onError: (cause) => toast.error(mutationErrorMessage(cause) ?? "No se pudo anular la atención."),
  })

  const receptionName = useReceptionName()
  const data = query.data?.data
  const context = data
    ? { today: data.date, timezone: data.timezone, locale: data.locale, allTasks: data.access.allTasks, receptionName }
    : null
  const choice = { branches: sede.branches, onChange: (id: string) => sede.choose(id) }
  return <PageShell className="flex flex-col gap-4">
    <PageHeader title="Inicio" subtitle={data ? longDay(data.date, data.locale) : "Lo que te toca hoy"} />
    <AwayLine canSeeCases={data?.access.agent ?? false} canSeeAgenda={data?.access.appointments ?? false} />
    {query.isError && !data ? (
      <ErrorState title="No pudimos cargar tu jornada" message="Revisa tu conexión." retryLabel="Reintentar" onRetry={() => void query.refetch()} />
    ) : !data || !context ? (
      <LoadingState />
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
              onCase: (row) => row.conversationId && setBriefFor({ conversationId: row.conversationId, name: row.contactName ?? "Interlocutor" }),
              onAdvice: (row) => setAdvice(row.key),
              onUnreached: () => setUnreached(true),
              onBudgets: setBudgets,
              onTake: canTake ? (row) => take.mutate(row) : undefined,
              noCaseBrief: !data.access.conversations && !data.access.agent,
              // Responder sin entrar a la Bandeja: el odontólogo su duda clínica, caja un pago (R3 y decisión 3).
              onReply: async (row, text) => {
                try {
                  const sent = await apiFetch<{ data: { held?: boolean } }>(`/api/workspace/topics/${row.id}/reply`, {
                    method: "POST",
                    body: JSON.stringify({ text }),
                  })
                  const first = row.contactName?.trim().split(/\s+/)[0] || "la persona"
                  toast.success(sent.data.held ? `Quedó por entregar: a ${first} le llega con «Ver respuesta».` : `Le respondiste a ${first}. Tema resuelto.`)
                  invalidateAgentPanelQueries(queryClient)
                  refresh()
                  return null
                } catch (cause) {
                  return mutationErrorMessage(cause) ?? "No se pudo enviar la respuesta."
                }
              },
              onDone: canDoTasks ? (row) => void completion.complete(row.id) : undefined,
              onReviewed: canDoTasks ? (row) => void completion.complete(row.id) : undefined,
              onConfirmRepresentative: canWritePatients && canDoTasks ? (row) => confirmRepresentative.mutate(row) : undefined,
              onDiscard: canDoTasks ? (row) => discardRegistration.mutate(row) : undefined,
              onReviewRegistration: canWritePatients && canDoTasks ? (row) => setHoldTask(row.id) : undefined,
              onReorder: canOrder ? (row) => reorder.mutate(row) : undefined,
              onArrived: canWriteAppointments
                ? (row) => arrival.mutate({ id: row.appointmentId, arrived: true, patient: { id: row.patientId, name: row.patientName } })
                : undefined,
              onVoidEncounter: (row) => {
                setDiscardReason("")
                setDiscarding(row)
              },
              busyKey,
              busyAction,
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
      pending={discard.isPending}
      confirmDisabled={discardReason.trim().length === 0}
      onClose={() => setDiscarding(null)}
      onConfirm={() => discarding && discard.mutate({ row: discarding, reason: discardReason.trim() })}
    >
      <div className="grid gap-2 text-left">
        <FieldLabel htmlFor="anular-atencion-motivo">Motivo</FieldLabel>
        <Textarea
          id="anular-atencion-motivo"
          value={discardReason}
          maxLength={2000}
          rows={3}
          placeholder="Ej.: se abrió por error"
          onChange={(event) => setDiscardReason(event.target.value)}
        />
      </div>
    </ConfirmDialog>
    <RegistrationHoldDrawer taskId={holdTask} onClose={() => setHoldTask(null)} />
    <CaseBriefDrawer conversationId={briefFor?.conversationId ?? null} name={briefFor?.name ?? "Interlocutor"} canTake={canTake} onClose={() => setBriefFor(null)} onClaimed={refresh} />
    <AdminRecommendationDrawer recommendationKey={advice} onClose={() => setAdvice(null)} />
    <AdminUnreachedDrawer open={unreached} onClose={() => setUnreached(false)} />
    {completion.dialog}
    <DetailDrawer
      open={budgets !== null}
      onClose={() => setBudgets(null)}
      title="Presupuestos que esperan respuesta"
      description={budgets && budgets.items.length < budgets.total ? `Los ${budgets.items.length} más antiguos de ${budgets.total}` : undefined}
    >
      {budgets && context ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {budgets.items.map((item) => (
            <li key={item.id} className="flex flex-col px-3 py-2 text-sm">
              <Link to="/patients/$patientId" params={{ patientId: item.patientId }} search={{ tab: "plan" }} className="font-semibold text-primary hover:underline">
                {item.patientName}
              </Link>
              <span>{item.title}</span>
              <span className="text-muted-foreground">{item.presentedAt ? `Se presentó ${daysAgo(item.presentedAt, context)}` : "Aún sin fecha de presentación"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </DetailDrawer>
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
