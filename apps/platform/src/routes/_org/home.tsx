import { DetailDrawer, EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { AdminRecommendationDrawer, AdminUnreachedDrawer } from "../../components/agent/admin-recommendation"
import { CaseBriefDrawer } from "../../components/agent/case-brief"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { type BranchChoice, CashLine, TodayAgenda, TodayCash, TodayPatients } from "../../components/home/today"
import { WaitingList } from "../../components/home/waiting-list"
import { HomeStart, needsSetup } from "../../components/home-start"
import { useActiveBranch } from "../../lib/active-branch"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { type DebtRow, invalidateFinance } from "../../lib/finance-cash"
import { type CollectResultBody, useOrgFinanceProfile } from "../../lib/finance-collect"
import { daysAgo, longDay } from "../../lib/home"
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

/** Tiene al menos un dominio de trabajo; sin ninguno no hay nada que mostrarle. */
function hasWork(access: WorkspaceHome["access"]): boolean {
  return access.patients || access.appointments || access.conversations || access.tasks || access.finance || access.clinical || access.crm || access.agent
}

function HomePage() {
  const queryClient = useQueryClient()
  const canClaim = usePermission("tasks.write")
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

  const [briefFor, setBriefFor] = useState<{ conversationId: string; name: string } | null>(null)
  const [advice, setAdvice] = useState<string | null>(null)
  const [unreached, setUnreached] = useState(false)
  const [budgets, setBudgets] = useState<BudgetsRow | null>(null)

  const data = query.data?.data
  const context = data ? { today: data.date, timezone: data.timezone, locale: data.locale, allTasks: data.access.allTasks } : null
  const choice = { branches: sede.branches, onChange: (id: string) => sede.choose(id) }
  return <PageShell className="flex flex-col gap-4">
    <PageHeader title="Inicio" subtitle={data ? longDay(data.date, data.locale) : "Lo que te toca hoy"} />
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
            handlers={{
              onCase: (row) => row.conversationId && setBriefFor({ conversationId: row.conversationId, name: row.contactName ?? "Interlocutor" }),
              onAdvice: (row) => setAdvice(row.key),
              onUnreached: () => setUnreached(true),
              onBudgets: setBudgets,
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

    <CaseBriefDrawer conversationId={briefFor?.conversationId ?? null} name={briefFor?.name ?? "Interlocutor"} canClaim={canClaim} onClose={() => setBriefFor(null)} onClaimed={refresh} />
    <AdminRecommendationDrawer recommendationKey={advice} onClose={() => setAdvice(null)} />
    <AdminUnreachedDrawer open={unreached} onClose={() => setUnreached(false)} />
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
