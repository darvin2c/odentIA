import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import {
  Badge,
  Button,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  AgentMark,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Filter, KanbanSquare, List } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  type PipelineSearch,
  pipelineQueryOf,
  pipelineSearchOf,
} from "../../components/arm/pipeline-search"
import { productShape } from "../../components/arm/sale-api"
import {
  CLIENT_ORIGINS,
  daysWords,
  dueWords,
  limaDay,
  ORIGIN_WORDS,
  TASK_WORDS,
  type TaskKind,
} from "../../components/arm/sale-words"
import { type ProductChoice, ProductFilter, ProductMark } from "../../components/product"
import {
  PIPELINE_BOARD_CLASS,
  PIPELINE_COLUMN_CLASS,
  PIPELINE_SUBTITLE,
  PipelineBoardSkeleton,
  PipelineListSkeleton,
  PipelinePageSkeleton,
} from "../../components/skeletons/pipeline"
import { ApiError, api } from "../../lib/api"
import { useAdminUserId } from "../../lib/session"

/**
 * El Embudo del ARM (lienzo «Embudo y presentaciones», tablero 1): las ventas
 * abiertas de los tres productos, una tarjeta por cliente en la columna de su
 * etapa, y lo decidido en 30 días plegado. Ninguna tarjeta se arrastra ni se
 * mueve a mano: la columna la pone el hecho (la calcula el servidor). Cada
 * tarjeta abre la ficha del cliente en «Venta». Filtros y vista en la dirección.
 */
export const Route = createFileRoute("/_app/pipeline")({
  validateSearch: (search: Record<string, unknown>): PipelineSearch => pipelineSearchOf(search),
  pendingComponent: PipelinePageSkeleton,
  component: PipelinePage,
})

const COLUMN_KEYS = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
  "decidio",
] as const
type ColumnKey = (typeof COLUMN_KEYS)[number]

const COLUMN_WORDS: Record<ColumnKey, { title: string; fact: string }> = {
  contacto: { title: "Contacto", fact: "Abierta y sin nada más" },
  presentacion_agendada: { title: "Presentación agendada", fact: "Hay una presentación por venir" },
  presentacion_hecha: { title: "Presentación hecha", fact: "Se anotó que se hizo" },
  propuesta: { title: "Propuesta", fact: "Se envió una propuesta o tiene invitación" },
  decidio: { title: "Decidió", fact: "Últimos 30 días" },
}

const DECISION_WORDS = { entro: "Entró", no_por_ahora: "No por ahora", perdido: "Perdido" } as const

const cardSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  product: productShape,
  nextStep: z.object({ kind: z.string(), title: z.string(), dueOn: z.string() }).nullable(),
  daysInStage: z.number(),
  owner: z.object({ userId: z.string(), name: z.string() }).nullable(),
  signals: z.array(z.object({ code: z.string(), words: z.string() })),
  decision: z.enum(["entro", "no_por_ahora", "perdido"]).nullable(),
})
type Card = z.infer<typeof cardSchema>
const pipelineSchema = z.object({
  columns: z.array(z.object({ key: z.enum(COLUMN_KEYS), cards: z.array(cardSchema) })),
})

type Row = Card & { column: ColumnKey }

function PipelinePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/pipeline" })
  const myUserId = useAdminUserId()
  const set = (patch: Partial<PipelineSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  const query = useQuery({
    queryKey: ["admin", "clients", "pipeline", search.responsable ?? null, search.origen ?? null],
    queryFn: async () => pipelineSchema.parse(await api<unknown>(pipelineQueryOf(search))),
    placeholderData: (previous) => previous,
  })

  // Quién lleva cada venta, recordado mientras se mira: así el filtro sigue ofreciendo a todos aunque uno esté elegido.
  const owners = React.useRef(new Map<string, string>())
  for (const column of query.data?.columns ?? [])
    for (const card of column.cards)
      if (card.owner) owners.current.set(card.owner.userId, card.owner.name)

  const product: ProductChoice = search.producto ?? "todos"
  const columns = React.useMemo(
    () =>
      COLUMN_KEYS.map((key) => ({
        key,
        cards: (query.data?.columns.find((column) => column.key === key)?.cards ?? []).filter(
          (card) => product === "todos" || card.product === product,
        ),
      })),
    [query.data, product],
  )
  const open = (query.data?.columns ?? [])
    .filter((column) => column.key !== "decidio")
    .flatMap((column) => column.cards)
  const counts = {
    todos: open.length,
    ...(Object.fromEntries(
      CLINICAL_PRODUCTS.map((each) => [each, open.filter((card) => card.product === each).length]),
    ) as Record<ClinicalProduct, number>),
  }
  const total = columns.reduce((sum, column) => sum + column.cards.length, 0)
  const filtered = Boolean(search.producto || search.responsable || search.origen)

  return (
    <PageShell className="space-y-5">
      <PageHeader title="Embudo" subtitle={PIPELINE_SUBTITLE} />
      <ViewTabs
        label="Vista"
        value={search.vista ?? "tablero"}
        options={[
          { value: "tablero", label: "Tablero", icon: <KanbanSquare aria-hidden /> },
          { value: "lista", label: "Lista", icon: <List aria-hidden /> },
        ]}
        onValueChange={(value) => set({ vista: value === "lista" ? "lista" : undefined })}
      />
      <div className="flex flex-wrap items-end gap-3">
        <ProductFilter
          value={product}
          onChange={(value) => set({ producto: value === "todos" ? undefined : value })}
          counts={counts}
        />
        <OwnerFilter
          value={search.responsable}
          owners={owners.current}
          myUserId={myUserId}
          onChange={(responsable) => set({ responsable })}
        />
        <OriginFilter value={search.origen} onChange={(origen) => set({ origen })} />
        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => set({ producto: undefined, responsable: undefined, origen: undefined })}
          >
            Quitar filtros
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        search.vista === "lista" ? (
          <PipelineListSkeleton />
        ) : (
          <PipelineBoardSkeleton />
        )
      ) : query.isError && !query.data ? (
        <ErrorState
          title="No pude cargar el Embudo"
          error={query.error instanceof ApiError ? query.error.shape : query.error}
          onRetry={() => void query.refetch()}
        />
      ) : total === 0 ? (
        filtered ? (
          <EmptyState
            icon={Filter}
            title="Sin ventas con estos filtros"
            description="Prueba con otro producto, responsable u origen."
            actionLabel="Quitar filtros"
            onAction={() => set({ producto: undefined, responsable: undefined, origen: undefined })}
          />
        ) : (
          <EmptyState
            icon={KanbanSquare}
            title="Todavía no hay ventas abiertas"
            description="Cada cliente sin cuenta tiene su venta: aparece aquí desde el primer contacto, con o sin solicitud de la web."
          >
            <Button render={<Link to="/clients" />}>Ver clientes</Button>
          </EmptyState>
        )
      ) : search.vista === "lista" ? (
        <PipelineList columns={columns} isFetching={query.isFetching} />
      ) : (
        <PipelineBoard columns={columns} stale={query.isPlaceholderData} />
      )}
    </PageShell>
  )
}

/* ---------- Filtros ---------- */

const ALL = "__todos"

function OwnerFilter({
  value,
  owners,
  myUserId,
  onChange,
}: {
  value: string | undefined
  owners: Map<string, string>
  myUserId: string
  onChange: (value: string | undefined) => void
}) {
  const people = [...owners.entries()]
    .filter(([userId]) => userId !== myUserId)
    .sort((a, b) => a[1].localeCompare(b[1], "es"))
  const items: Record<string, string> = {
    [ALL]: "Responsable: Todos",
    mio: "Responsable: Mías",
    sin: "Responsable: Sin responsable",
    ...Object.fromEntries(people.map(([userId, name]) => [userId, `Responsable: ${name}`])),
  }
  if (value && !items[value]) items[value] = "Responsable: otra persona"
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor="embudo-responsable" className="sr-only">
        Responsable
      </FieldLabel>
      <Select
        value={value ?? ALL}
        items={items}
        onValueChange={(next) => onChange(!next || next === ALL ? undefined : String(next))}
      >
        <SelectTrigger id="embudo-responsable" className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label.replace("Responsable: ", "")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function OriginFilter({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: (typeof CLIENT_ORIGINS)[number] | undefined) => void
}) {
  const items: Record<string, string> = {
    [ALL]: "Origen: Todos",
    ...Object.fromEntries(
      CLIENT_ORIGINS.map((origin) => [origin, `Origen: ${ORIGIN_WORDS[origin]}`]),
    ),
  }
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor="embudo-origen" className="sr-only">
        Origen
      </FieldLabel>
      <Select
        value={value ?? ALL}
        items={items}
        onValueChange={(next) => {
          const picked = CLIENT_ORIGINS.find((origin) => origin === next)
          onChange(picked)
        }}
      >
        <SelectTrigger id="embudo-origen" className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos</SelectItem>
          {CLIENT_ORIGINS.map((origin) => (
            <SelectItem key={origin} value={origin}>
              {ORIGIN_WORDS[origin]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/* ---------- Tablero ---------- */

function PipelineBoard({
  columns,
  stale,
}: {
  columns: { key: ColumnKey; cards: Card[] }[]
  /** Con otro filtro en camino: lo de antes sigue a la vista, atenuado. */
  stale: boolean
}) {
  const [showDecided, setShowDecided] = React.useState(false)
  const decided = columns.find((column) => column.key === "decidio")?.cards ?? []
  return (
    <section
      aria-label="Tablero del Embudo"
      // Desde tableta las columnas van en fila y se recorren de lado aquí dentro, nunca la página entera.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: la fila se desplaza con el teclado.
      tabIndex={0}
      aria-busy={stale || undefined}
      className={`${PIPELINE_BOARD_CLASS} rounded-xl transition-opacity focus-visible:outline-2 focus-visible:outline-ring ${stale ? "opacity-60" : ""}`}
    >
      {columns
        .filter((column) => column.key !== "decidio")
        .map((column) => (
          <section
            key={column.key}
            aria-labelledby={`embudo-${column.key}`}
            className={PIPELINE_COLUMN_CLASS}
          >
            <header>
              <h2
                id={`embudo-${column.key}`}
                className="flex items-baseline gap-2 text-sm font-semibold"
              >
                {COLUMN_WORDS[column.key].title}
                <span className="font-medium text-muted-foreground tabular-nums">
                  {column.cards.length}
                </span>
              </h2>
              <p className="text-xs text-muted-foreground">{COLUMN_WORDS[column.key].fact}</p>
            </header>
            {column.cards.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                Ninguna ahora.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {column.cards.map((card) => (
                  <li key={card.clientId}>
                    <SaleCard card={card} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      <section aria-labelledby="embudo-decidio" className={PIPELINE_COLUMN_CLASS}>
        <header>
          <h2 id="embudo-decidio" className="flex items-baseline gap-2 text-sm font-semibold">
            {COLUMN_WORDS.decidio.title}
            <span className="font-medium text-muted-foreground tabular-nums">{decided.length}</span>
          </h2>
          <p className="text-xs text-muted-foreground">{COLUMN_WORDS.decidio.fact}</p>
        </header>
        <p className="text-sm">
          {(["entro", "no_por_ahora", "perdido"] as const)
            .map(
              (decision) =>
                `${DECISION_WORDS[decision]} ${decided.filter((card) => card.decision === decision).length}`,
            )
            .join(" · ")}
        </p>
        {decided.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 w-fit"
            aria-expanded={showDecided}
            aria-controls="embudo-decidio-tarjetas"
            onClick={() => setShowDecided((shown) => !shown)}
          >
            <ChevronDown
              aria-hidden
              className={showDecided ? "rotate-180 transition-transform" : "transition-transform"}
            />
            {showDecided ? "Plegar" : "Ver cuáles"}
          </Button>
        ) : null}
        {showDecided ? (
          <ul id="embudo-decidio-tarjetas" className="flex flex-col gap-2">
            {decided.map((card) => (
              <li key={card.clientId}>
                <SaleCard card={card} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  )
}

/** «Llamar · hoy» o «Sin próximo paso». */
function nextStepWords(card: Card, today: string): string {
  if (!card.nextStep) return card.decision ? "" : "Sin próximo paso"
  const kind = TASK_WORDS[card.nextStep.kind as TaskKind] ?? "Tarea"
  return `${kind} · ${dueWords(card.nextStep.dueOn, null, today)}`
}

/** La tarjeta de una venta: abre la ficha del cliente en «Venta». No se arrastra. */
function SaleCard({ card }: { card: Card }) {
  const today = limaDay()
  const overdue = card.nextStep ? card.nextStep.dueOn < today : false
  const step = nextStepWords(card, today)
  return (
    <Link
      to="/clients/$clientId"
      params={{ clientId: card.clientId }}
      search={{ tab: "venta" }}
      className="lift flex flex-col gap-1.5 rounded-lg border bg-card p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-between gap-2">
        <ProductMark product={card.product} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {card.decision ? DECISION_WORDS[card.decision] : daysWords(card.daysInStage)}
        </span>
      </span>
      <span className="font-semibold leading-snug break-words">{card.name}</span>
      {step ? (
        <span
          className={
            !card.nextStep || overdue
              ? "text-xs font-medium text-warning"
              : "text-xs text-muted-foreground"
          }
        >
          {step}
          {overdue ? " · vencido" : ""}
          {card.nextStep ? (
            <span className="block truncate font-normal text-muted-foreground">
              {card.nextStep.title}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">{card.owner?.name ?? "Sin responsable"}</span>
      {card.signals.length > 0 ? (
        <span className="flex flex-col gap-1 rounded-md border border-agent-border bg-agent-soft p-2">
          {card.signals.map((signal) => (
            <span key={signal.code} className="flex items-start gap-1.5 text-xs">
              <AgentMark size="sm" className="size-5" />
              <span>
                <span className="font-semibold">Kairós · </span>
                {signal.words}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </Link>
  )
}

/* ---------- Lista ---------- */

function PipelineList({
  columns,
  isFetching,
}: {
  columns: { key: ColumnKey; cards: Card[] }[]
  isFetching: boolean
}) {
  const navigate = useNavigate()
  const today = limaDay()
  const rows = React.useMemo<Row[]>(
    () =>
      columns.flatMap((column) => column.cards.map((card) => ({ ...card, column: column.key }))),
    [columns],
  )
  const tableColumns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "clinic",
        header: "Clínica",
        cell: ({ row }) => <span className="font-semibold">{row.original.name}</span>,
        meta: { view: { role: "title" } },
      },
      {
        id: "product",
        header: "Producto",
        cell: ({ row }) => <ProductMark product={row.original.product} />,
      },
      {
        id: "stage",
        header: "Etapa",
        cell: ({ row }) =>
          row.original.decision
            ? `Decidió: ${DECISION_WORDS[row.original.decision]}`
            : COLUMN_WORDS[row.original.column].title,
        meta: { view: { primary: true } },
      },
      {
        id: "next",
        header: "Próximo paso",
        cell: ({ row }) => nextStepWords(row.original, today) || "—",
        meta: { view: { primary: true } },
      },
      {
        id: "days",
        header: "En la etapa",
        cell: ({ row }) => (row.original.decision ? "—" : daysWords(row.original.daysInStage)),
      },
      {
        id: "owner",
        header: "Responsable",
        cell: ({ row }) => row.original.owner?.name ?? "Sin responsable",
      },
      {
        id: "signals",
        header: "Kairós",
        cell: ({ row }) =>
          row.original.signals.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.signals.map((signal) => (
                <Badge key={signal.code} variant="outline" title={signal.words}>
                  {signal.words}
                </Badge>
              ))}
            </span>
          ) : (
            "—"
          ),
      },
    ],
    [today],
  )
  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <DataTable
      table={table}
      wrap
      isFetching={isFetching}
      onRowClick={(row) =>
        void navigate({
          to: "/clients/$clientId",
          params: { clientId: row.clientId },
          search: { tab: "venta" },
        })
      }
    />
  )
}
