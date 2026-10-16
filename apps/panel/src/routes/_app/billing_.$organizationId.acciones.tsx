/**
 * Cada acción de los agentes en el tramo que corre (ADR 0031, tablero C3):
 * la factura suma exactamente estas filas. Lo que no se cobra no aparece; lo
 * que se cuenta pero no suma (va dentro de una cita, cita anulada) lo dice
 * en su estado. Solo owner/admin, como el resto de Plan y pagos.
 */
import { Button, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { DataTable, EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { AGENT_OF, PriceWithDiscount, type SaasActionKind } from "../../components/billing/consumption"
import { formatMicros } from "../../components/billing/money"
import { accountOrganizationsQuery } from "../../lib/account-organizations"
import { apiFetch } from "../../lib/api"
import { tenantUrl } from "../../lib/host"

export const Route = createFileRoute("/_app/billing_/$organizationId/acciones")({
  component: ActionsPage,
})

type ActionState = "prueba" | "credito" | "sobre_credito" | "dentro_de_cita" | "esperando" | "sin_precio" | "anulada"

interface ActionRow {
  id: string
  kind: SaasActionKind
  occurredAt: string
  contactId: string | null
  personName: string | null
  conversationId: string | null
  appointmentId: string | null
  channel: string | null
  detail: string
  basePriceMicros: number | null
  priceMicros: number | null
  discountBps: number
  state: ActionState
  /** De una cita recuperada: las conversaciones ya cobradas que devuelve. */
  refunds?: Array<{ actionId: string; occurredAt: string; priceMicros: number }>
}

interface ActionsPage {
  period: { start: string; end: string; credit: "prueba" | "mes" }
  total: number
  pending: number
  items: ActionRow[]
}

const STATE_WORDS: Record<ActionState, string> = {
  prueba: "Del saldo de prueba",
  credito: "Del crédito del mes",
  sobre_credito: "Por encima del crédito",
  dentro_de_cita: "Va dentro de la cita recuperada",
  esperando: "Esperando que asista",
  sin_precio: "Sin precio en tu plan",
  anulada: "No se cobra: la cita ya no figura como atendida",
}

const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  email: "Correo",
  webchat: "Chat web",
  agent: "en la conversación",
  enlace: "desde el enlace",
}

type Filter = "todo" | SaasActionKind | "esperando"
const PAGE = 50

function when(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
}

function ActionsPage() {
  const { organizationId } = Route.useParams()
  const [filter, setFilter] = useState<Filter>("todo")
  const [offset, setOffset] = useState(0)
  const organizations = useQuery(accountOrganizationsQuery)
  const slug = organizations.data?.find((org) => org.organizationId === organizationId)?.slug ?? null
  const params = new URLSearchParams({ orgId: organizationId, limit: String(PAGE), offset: String(offset) })
  if (filter === "esperando") params.set("state", "esperando")
  else if (filter !== "todo") params.set("kind", filter)
  const actions = useQuery({
    queryKey: ["billing", organizationId, "actions", filter, offset],
    queryFn: () => apiFetch<{ data: ActionsPage }>(`/api/account/billing/actions?${params.toString()}`).then((res) => res.data),
    retry: false,
  })

  const columns = useMemo<ColumnDef<ActionRow>[]>(
    () => [
      { id: "cuando", header: "Cuándo", cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{when(row.original.occurredAt)}</span>, meta: { view: { primary: true } } },
      {
        id: "persona",
        header: "Persona",
        cell: ({ row }) =>
          row.original.personName && row.original.contactId && slug ? (
            <a className="font-medium underline-offset-2 hover:underline" href={tenantUrl(slug, `/contacts/${row.original.contactId}`)}>
              {row.original.personName}
            </a>
          ) : (
            <span className="font-medium">{row.original.personName ?? "Sin persona"}</span>
          ),
        meta: { view: { role: "title" } },
      },
      {
        id: "que",
        header: "Qué hizo",
        cell: ({ row }) => {
          const channel = row.original.channel ? CHANNEL_WORDS[row.original.channel] ?? row.original.channel : null
          return (
            <span className="block min-w-48 whitespace-normal">
              <span className="block text-xs text-muted-foreground">
                {AGENT_OF[row.original.kind].agent}
                {channel ? ` · ${channel}` : ""}
              </span>
              {row.original.detail}
              {row.original.refunds?.length ? (
                <span className="block text-xs text-muted-foreground">
                  Devuelve {row.original.refunds.length === 1 ? "la conversación ya cobrada que llevó a ella" : `${row.original.refunds.length} conversaciones ya cobradas que llevaron a ella`} (
                  {formatMicros(
                    row.original.refunds.reduce((sum, refund) => sum + refund.priceMicros, 0),
                    "USD",
                  )}
                  )
                </span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "importe",
        header: "Importe",
        cell: ({ row }) =>
          row.original.state === "dentro_de_cita" || row.original.state === "anulada" ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <PriceWithDiscount
              base={row.original.basePriceMicros}
              price={row.original.priceMicros}
              currency="USD"
              discountBps={row.original.discountBps}
            />
          ),
      },
      { id: "estado", header: "Estado", cell: ({ row }) => <span className="block min-w-32 whitespace-normal text-sm">{STATE_WORDS[row.original.state]}</span>, meta: { view: { primary: true } } },
    ],
    [slug],
  )
  const table = useReactTable({ data: actions.data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() })
  const total = actions.data?.total ?? 0

  return (
    <PageShell className="flex flex-col gap-4">
      <PageHeader
        title="Cada acción de tus agentes"
        subtitle="La factura suma exactamente estas filas"
        actions={
          <Button variant="outline" size="sm" render={<Link to="/billing/$organizationId" params={{ organizationId }} />}>
            Volver a Plan y pagos
          </Button>
        }
      />
      <Tabs
        value={filter}
        onValueChange={(value) => {
          setFilter(value as Filter)
          setOffset(0)
        }}
      >
        <TabsList aria-label="Qué mostrar">
          <TabsTrigger value="todo">Todo</TabsTrigger>
          <TabsTrigger value="conversacion">Recepción</TabsTrigger>
          <TabsTrigger value="consulta">Asistente clínico</TabsTrigger>
          <TabsTrigger value="cita">Administrador</TabsTrigger>
          <TabsTrigger value="esperando">Esperando que asista{actions.data?.pending ? ` (${actions.data.pending})` : ""}</TabsTrigger>
        </TabsList>
      </Tabs>
      {actions.isPending ? (
        <LoadingState message="Cargando las acciones…" />
      ) : actions.isError ? (
        <ErrorState title="No se pudieron cargar las acciones" message="Reintenta en un momento." onRetry={() => void actions.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          title={filter === "esperando" ? "Ninguna cita espera asistencia" : "Aún no hay acciones en este tramo"}
          description="Cuando un agente atienda una conversación, ordene una consulta dictada o recupere una cita, aparecerá aquí con su precio."
        />
      ) : (
        <>
          <DataTable table={table} view="table" isFetching={actions.isFetching} />
          {total > PAGE ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {offset + 1}–{Math.min(offset + PAGE, total)} de {total}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Anteriores
                </Button>
                <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                  Siguientes
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Lo que no se cobra no aparece aquí: recordatorios, derivaciones sin IA, respuestas fijas, borradores descartados y lo que respondió tu equipo.
      </p>
    </PageShell>
  )
}
