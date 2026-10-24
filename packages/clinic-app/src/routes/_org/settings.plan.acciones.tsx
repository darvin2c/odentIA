/**
 * Cada acción de los agentes en el tramo que corre y en el anterior (ADR 0031,
 * tablero C3; ADR 0054, tablero 6; ADR 0085, tablero C2): la factura suma
 * exactamente estas filas, cada una con su tipo.
 * Lo que no se cobra no aparece; lo que se cuenta pero no suma (va dentro de
 * una cita, cita anulada, devuelta al revisarla) lo dice en su estado. De
 * cualquier fila se pide revisión desde su «⋯». Solo owner/admin, como el
 * resto de Plan y pagos, dentro de la clínica (ADR 0065).
 */
import { Badge, Button, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { DataTable, EmptyState, ErrorState, LoadingState, PageHeader, RowActions } from "@odentia/ui-patterns"
import { seesBilling } from "@odentia/auth/permissions"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ArrowLeft } from "lucide-react"
import { useMemo, useState } from "react"
import { type ActionReview, ActionReviewDrawer, type ReviewTarget, reviewStateWords } from "../../components/billing/action-review"
import { agentOfKind, PriceWithDiscount, type SaasActionKind, type SaasActionTier, TIER_NAME } from "../../components/billing/consumption"
import { formatMicros } from "../../components/billing/money"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { PersonLink } from "../../components/person-link"
import { ADMIN_NAME, CLINICAL_NAME, useReceptionName } from "../../lib/agent-names"
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
  /** Su tipo (ADR 0085); null en la cita recuperada, las preguntas y el almacenamiento. */
  tier: SaasActionTier | null
  /** Preguntas del paquete o GB extra. */
  units: number | null
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
  /** Gestiona cuya cita reservada aún no se da: lo que sumaría si viene (ADR 0085). */
  agendaPendingMicros?: number | null
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
  esperando: "Esperando que venga",
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

/** De quién es cada fila (tablero C2): Argos son sus citas recuperadas y sus paquetes de preguntas. */
type Filter = "todo" | "sofi" | "clio" | "argos" | "almacenamiento" | "esperando"

/** La etiqueta de cada fila: su tipo, o lo que es si no tiene. */
function kindLabel(row: Pick<ActionRow, "kind" | "tier" | "units">): string {
  if (row.tier) return TIER_NAME[row.tier]
  if (row.kind === "cita") return "Cita recuperada"
  if (row.kind === "preguntas") return `${row.units ?? ""} preguntas`.trim()
  if (row.kind === "almacenamiento") return `${row.units ?? ""} GB extra`.trim()
  return ""
}
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
  const receptionName = useReceptionName()
  const [filter, setFilter] = useState<Filter>("todo")
  const [period, setPeriod] = useState<Period>("actual")
  const [offset, setOffset] = useState(0)
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null)
  const params = new URLSearchParams({ orgId: organizationId, limit: String(PAGE), offset: String(offset), periodo: period })
  if (filter === "esperando") params.set("state", "esperando")
  else if (filter !== "todo") params.set("agente", filter)
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
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {agentOfKind(row.original.kind, receptionName)}
                {channel ? ` · ${channel}` : ""}
                {kindLabel(row.original) ? (
                  <Badge variant={row.original.kind === "cita" ? "warning" : "soft"} className="h-5 px-1.5 text-[11px]">
                    {kindLabel(row.original)}
                  </Badge>
                ) : null}
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
              {row.original.agendaPendingMicros !== undefined ? (
                <span className="block text-xs text-muted-foreground">
                  Esperando que venga a su cita: si viene, sube a Agenda
                  {row.original.agendaPendingMicros !== null ? ` (+${formatMicros(row.original.agendaPendingMicros, "USD")})` : ""}
                </span>
              ) : null}
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
    [receptionName],
  )
  const table = useReactTable({ data: actions.data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() })
  const total = actions.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cada acción de tus agentes"
        subtitle={`${clinicLine} · La factura suma exactamente estas filas`}
        primary={{ label: "Volver a Plan y pagos", icon: <ArrowLeft aria-hidden />, render: <Link to={PLAN_PATH} /> }}
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
            <TabsTrigger value="sofi">{receptionName}</TabsTrigger>
            <TabsTrigger value="clio">{CLINICAL_NAME}</TabsTrigger>
            <TabsTrigger value="argos">{ADMIN_NAME}</TabsTrigger>
            <TabsTrigger value="almacenamiento">Almacenamiento</TabsTrigger>
            {period === "actual" ? (
              <TabsTrigger value="esperando">Esperando que venga{actions.data?.pending ? ` (${actions.data.pending})` : ""}</TabsTrigger>
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
          description="Cuando un agente atienda una conversación, ordene una consulta dictada, recupere una cita o sume preguntas, aparecerá aquí con su tipo y su precio."
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
