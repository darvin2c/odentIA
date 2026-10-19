/**
 * Cada acción de los agentes en el tramo que corre y en el anterior (ADR 0031,
 * tablero C3; ADR 0054, tablero 6): la factura suma exactamente estas filas.
 * Lo que no se cobra no aparece; lo que se cuenta pero no suma (va dentro de
 * una cita, cita anulada, devuelta al revisarla) lo dice en su estado. De
 * cualquier fila se pide revisión desde su «⋯». Solo owner/admin, como el
 * resto de Plan y pagos, dentro de la clínica (ADR 0065).
 */
import { Button, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { DataTable, EmptyState, ErrorState, LoadingState, PageHeader, RowActions } from "@odentia/ui-patterns"
import { seesBilling } from "@odentia/auth/permissions"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { type ActionReview, ActionReviewDrawer, type ReviewTarget, reviewStateWords } from "../../components/billing/action-review"
import { AGENT_OF, PriceWithDiscount, type SaasActionKind } from "../../components/billing/consumption"
import { formatMicros } from "../../components/billing/money"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { PersonLink } from "../../components/person-link"
import { apiFetch } from "../../lib/api"
import { PLAN_PATH, useClinicLine } from "../../lib/billing"
import { useMyRole } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

export const Route = createFileRoute("/_org/settings/plan/acciones")({
  component: ActionsGate,
})

const orgRouteApi = getRouteApi("/_org")

function ActionsGate() {
  const role = useMyRole()
  if (!seesBilling(role)) {
    return (
      <>
        <PageHeader title="Cada acción de tus agentes" />
        <SettingsNoAccess />
      </>
    )
  }
  return <ActionsPage />
}

type ActionState = "prueba" | "credito" | "sobre_credito" | "dentro_de_cita" | "esperando" | "sin_precio" | "anulada" | "devuelta"

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
  /** El cargo en que salió; nulo si aún no se cobró. */
  chargeId: string | null
  /** De una cita recuperada: las conversaciones ya cobradas que devuelve. */
  refunds?: Array<{ actionId: string; occurredAt: string; priceMicros: number }>
  /** La revisión que pidió la clínica, si pidió. */
  review: ActionReview | null
}

interface ActionsPage {
  period: { start: string; end: string; credit: "prueba" | "mes" }
  /** El tramo anterior, que también se puede revisar. */
  previous: { start: string; end: string }
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
  devuelta: "No se cobra: se devolvió al revisarla",
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
type Period = "actual" | "anterior"
const PAGE = 50

function when(iso: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: activeOrgTimeZone() }).format(new Date(iso))
}

/** El mes de un tramo por el día en que empieza: «Octubre». */
function monthName(iso: string): string {
  const name = new Intl.DateTimeFormat(activeOrgLocale(), { month: "long", timeZone: "UTC" }).format(new Date(iso))
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Se pide revisión de lo que tiene precio y cuenta; de lo que aún espera o no suma, no. */
const REVIEWABLE: ReadonlySet<ActionState> = new Set(["prueba", "credito", "sobre_credito"])

/** La respuesta de odentIA, que se abre en la propia fila. */
function ReviewAnswer({ review }: { review: ActionReview }) {
  const [open, setOpen] = useState(false)
  if (!review.answer) return null
  return (
    <>
      {" · "}
      <button type="button" className="underline underline-offset-2" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "ocultar respuesta" : "ver respuesta"}
      </button>
      {open ? <span className="mt-1 block rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">«{review.answer}»</span> : null}
    </>
  )
}

function ActionsPage() {
  const { org } = orgRouteApi.useRouteContext()
  const organizationId = org.id
  const clinicLine = useClinicLine()
  const [filter, setFilter] = useState<Filter>("todo")
  const [period, setPeriod] = useState<Period>("actual")
  const [offset, setOffset] = useState(0)
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null)
  const params = new URLSearchParams({ orgId: organizationId, limit: String(PAGE), offset: String(offset), periodo: period })
  if (filter === "esperando") params.set("state", "esperando")
  else if (filter !== "todo") params.set("kind", filter)
  const actions = useQuery({
    queryKey: ["billing", organizationId, "actions", period, filter, offset],
    queryFn: () => apiFetch<{ data: ActionsPage }>(`/api/account/billing/actions?${params.toString()}`).then((res) => res.data),
    retry: false,
  })
  // Los nombres de los dos tramos salen del mes en curso y no cambian al pasar de uno a otro.
  const [ranges, setRanges] = useState<{ current: string; previous: string; trial: boolean } | null>(null)
  if (actions.data && period === "actual" && ranges?.current !== actions.data.period.start) {
    setRanges({ current: actions.data.period.start, previous: actions.data.previous.start, trial: actions.data.period.credit === "prueba" })
  }
  const currentLabel = ranges ? (ranges.trial ? "Prueba, en curso" : `${monthName(ranges.current)}, en curso`) : "Este mes"
  const previousLabel = ranges ? monthName(ranges.previous) : "El mes anterior"

  const columns = useMemo<ColumnDef<ActionRow>[]>(
    () => [
      { id: "cuando", header: "Cuándo", cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{when(row.original.occurredAt)}</span>, meta: { view: { primary: true } } },
      {
        id: "persona",
        header: "Persona",
        cell: ({ row }) =>
          row.original.personName && row.original.contactId ? (
            <PersonLink contactId={row.original.contactId}>{row.original.personName}</PersonLink>
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
              {row.original.conversationId ? (
                <>
                  {" · "}
                  <Link className="underline underline-offset-2" to="/inbox" search={{ conversation: row.original.conversationId }}>
                    Ver conversación
                  </Link>
                </>
              ) : null}
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
          ) : row.original.state === "devuelta" && row.original.priceMicros !== null ? (
            <s className="text-muted-foreground tabular-nums">{formatMicros(row.original.priceMicros, "USD")}</s>
          ) : (
            <PriceWithDiscount
              base={row.original.basePriceMicros}
              price={row.original.priceMicros}
              currency="USD"
              discountBps={row.original.discountBps}
            />
          ),
      },
      {
        id: "estado",
        header: "Estado",
        cell: ({ row }) => {
          const { review } = row.original
          return (
            <span className="block min-w-32 whitespace-normal text-sm">
              {review ? reviewStateWords(review, row.original.priceMicros, row.original.chargeId !== null) : STATE_WORDS[row.original.state]}
              {review ? <ReviewAnswer review={review} /> : null}
              {review?.status === "pendiente" && review.caseId ? (
                <>
                  {" · "}
                  <a className="underline underline-offset-2" href={`?ayuda=casos&caso=${encodeURIComponent(review.caseId)}`}>
                    ver en Ayuda
                  </a>
                </>
              ) : null}
            </span>
          )
        },
        meta: { view: { primary: true } },
      },
      {
        id: "acciones",
        header: () => <span className="sr-only">Acciones</span>,
        cell: ({ row }) => {
          const action = row.original
          const canAsk = action.review === null && action.priceMicros !== null && REVIEWABLE.has(action.state)
          if (!canAsk) return null
          return (
            <RowActions
              label={`Acciones de la fila del ${when(action.occurredAt)}`}
              items={[
                {
                  key: "revision",
                  label: "Pedir revisión",
                  onSelect: () =>
                    setReviewing({
                      id: action.id,
                      kind: action.kind,
                      occurredAt: action.occurredAt,
                      personName: action.personName,
                      priceMicros: action.priceMicros,
                      conversationId: action.conversationId,
                    }),
                },
              ]}
            />
          )
        },
      },
    ],
    [],
  )
  const table = useReactTable({ data: actions.data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() })
  const total = actions.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cada acción de tus agentes"
        subtitle={`${clinicLine} · La factura suma exactamente estas filas`}
        actions={
          <Button variant="outline" size="sm" render={<Link to={PLAN_PATH} />}>
            Volver a Plan y pagos
          </Button>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
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
            {period === "actual" ? (
              <TabsTrigger value="esperando">Esperando que asista{actions.data?.pending ? ` (${actions.data.pending})` : ""}</TabsTrigger>
            ) : null}
          </TabsList>
        </Tabs>
        {/* El mes anterior también se ve, para pedir revisión de lo ya facturado (decisión 7). */}
        <Tabs
          value={period}
          onValueChange={(value) => {
            setPeriod(value as Period)
            if (filter === "esperando") setFilter("todo")
            setOffset(0)
          }}
        >
          <TabsList aria-label="Qué mes">
            <TabsTrigger value="actual">{currentLabel}</TabsTrigger>
            <TabsTrigger value="anterior">{previousLabel}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {actions.isPending ? (
        <LoadingState message="Cargando las acciones…" />
      ) : actions.isError ? (
        <ErrorState title="No se pudieron cargar las acciones" message="Reintenta en un momento." onRetry={() => void actions.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          title={filter === "esperando" ? "Ninguna cita espera asistencia" : period === "anterior" ? "No hubo acciones ese mes" : "Aún no hay acciones en este tramo"}
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
        Lo que no se cobra no aparece aquí: recordatorios, derivaciones sin IA, respuestas fijas, spam, borradores descartados y lo que respondió tu
        equipo. ¿Algo no cuadra? Pide revisión desde el ⋯ de la fila.
      </p>
      <ActionReviewDrawer organizationId={organizationId} target={reviewing} onClose={() => setReviewing(null)} />
    </div>
  )
}
