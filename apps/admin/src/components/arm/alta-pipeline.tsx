import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { Badge, Button, ScrollArea } from "@odentia/ui"
import { AgentMark, DataTable, EmptyState, ErrorState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Filter, KanbanSquare } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { useIsAdmin } from "../../lib/session"
import { ProductMark } from "../product"
import {
  AltaBoardSkeleton,
  AltaListSkeleton,
  PIPELINE_BOARD_CLASS,
  PIPELINE_COLUMN_CLASS,
} from "../skeletons/pipeline"
import { type PipelineSearch, pipelineQueryOf } from "./pipeline-search"
import { productShape } from "./sale-api"

/**
 * El Embudo «Alta» (`/pipeline?pestana=alta`): las clínicas que entraron, una tarjeta por
 * clínica en la columna de lo que le falta, y las que pagaron en 30 días plegadas. Como en
 * Venta, nadie arrastra nada: la columna la pone el servidor con los mismos pasos de la ficha
 * › Alta. Soporte no recibe «Primer pago» ni «Pagó» (las quita el servidor); la pantalla pinta
 * solo las columnas que llegan.
 */

export const ALTA_COLUMN_KEYS = [
  "bienvenida",
  "sus_datos",
  "arranque",
  "primer_pago",
  "pago",
] as const
type AltaColumnKey = (typeof ALTA_COLUMN_KEYS)[number]

const ALTA_COLUMN_WORDS: Record<AltaColumnKey, { title: string; fact: string }> = {
  bienvenida: { title: "Bienvenida", fact: "Falta la propietaria, el contrato o la carta" },
  sus_datos: { title: "Sus datos", fact: "Falta recibir, cargar o informar" },
  arranque: { title: "Arranque", fact: "Falta el equipo, WhatsApp o el primer uso" },
  primer_pago: { title: "Primer pago", fact: "Todo listo; falta su primer pago" },
  pago: { title: "Pagó", fact: "Últimos 30 días" },
}

// El paso y a quién le toca se leen como texto: una clave nueva del servidor no rompe la pantalla.
const altaCardSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  product: productShape,
  missing: z.object({ step: z.string(), words: z.string() }).nullable(),
  who: z
    .object({
      kind: z.string(),
      person: z.object({ userId: z.string(), name: z.string() }).nullable(),
    })
    .nullable(),
  daysInAlta: z.number(),
  stuck: z.object({ days: z.number(), words: z.string() }).nullable(),
  paidAt: z.string().nullable(),
  remaining: z.number(),
  owner: z.object({ userId: z.string(), name: z.string() }).nullable(),
})
export type AltaCardData = z.infer<typeof altaCardSchema>
export const altaBoardSchema = z.object({
  columns: z.array(z.object({ key: z.enum(ALTA_COLUMN_KEYS), cards: z.array(altaCardSchema) })),
})
type AltaColumn = { key: AltaColumnKey; cards: AltaCardData[] }

/** «Espera a la clínica», «Espera a Meta», «Nos toca: Ana» o, sin nada que falte, el responsable. */
export function altaWhoWords(card: Pick<AltaCardData, "who" | "owner">): string {
  if (!card.who) return card.owner ? `Responsable: ${card.owner.name}` : "Sin responsable"
  if (card.who.kind === "clinica") return "Espera a la clínica"
  if (card.who.kind === "meta") return "Espera a Meta"
  if (card.who.kind === "nosotros") return `Nos toca: ${card.who.person?.name || "falta asignar responsable"}`
  return "Sin saber a quién le toca"
}

/** «Falta: …»; en «Pagó», «Le falta: …» o que ya no le queda nada. */
export function altaMissingWords(card: Pick<AltaCardData, "missing">, paid: boolean): string {
  if (!card.missing) return "No le falta ningún paso"
  return `${paid ? "Le falta" : "Falta"}: ${card.missing.words}`
}

/** «Entró hoy», «1 día en alta», «12 días en alta». */
export function altaDaysWords(days: number): string {
  if (days <= 0) return "Entró hoy"
  return `${days} ${days === 1 ? "día" : "días"} en alta`
}

const dayFormat = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "numeric",
  month: "short",
})
/** «Pagó el 12 nov». */
export function altaPaidWords(paidAt: string): string {
  return `Pagó el ${dayFormat.format(new Date(paidAt)).replace(".", "")}`
}

interface AltaPipelineProps {
  search: PipelineSearch
  /** Los filtros de la página, con lo que cuenta el de producto y quién lleva cada clínica. */
  filters: (input: {
    counts: Record<"todos" | ClinicalProduct, number>
    owners: Map<string, string>
  }) => React.ReactNode
  onClearFilters: () => void
}

/** El cuerpo de la pestaña «Alta»: sus filtros, su tablero o su lista y sus estados. */
export function AltaPipeline({ search, filters, onClearFilters }: AltaPipelineProps) {
  const admin = useIsAdmin()
  const query = useQuery({
    queryKey: [
      "admin",
      "clients",
      "pipeline-alta",
      search.responsable ?? null,
      search.origen ?? null,
    ],
    queryFn: async () => altaBoardSchema.parse(await api<unknown>(pipelineQueryOf(search))),
    placeholderData: (previous) => previous,
  })

  // Quién lleva cada clínica, recordado mientras se mira (como en Venta).
  const owners = React.useRef(new Map<string, string>())
  for (const column of query.data?.columns ?? [])
    for (const card of column.cards)
      if (card.owner) owners.current.set(card.owner.userId, card.owner.name)

  const product = search.producto ?? "todos"
  const columns = React.useMemo<AltaColumn[]>(
    () =>
      ALTA_COLUMN_KEYS.flatMap((key) => {
        const column = query.data?.columns.find((each) => each.key === key)
        if (!column) return []
        return [
          {
            key,
            cards: column.cards.filter((card) => product === "todos" || card.product === product),
          },
        ]
      }),
    [query.data, product],
  )
  // El contador del producto cuenta las que siguen en alta (sin «Pagó»).
  const inAlta = (query.data?.columns ?? [])
    .filter((column) => column.key !== "pago")
    .flatMap((column) => column.cards)
  const counts = {
    todos: inAlta.length,
    ...(Object.fromEntries(
      CLINICAL_PRODUCTS.map((each) => [
        each,
        inAlta.filter((card) => card.product === each).length,
      ]),
    ) as Record<ClinicalProduct, number>),
  }
  const total = columns.reduce((sum, column) => sum + column.cards.length, 0)
  const filtered = Boolean(search.producto || search.responsable || search.origen)

  return (
    <>
      {filters({ counts, owners: owners.current })}
      {query.isPending ? (
        search.vista === "lista" ? (
          <AltaListSkeleton />
        ) : (
          <AltaBoardSkeleton admin={admin} />
        )
      ) : query.isError && !query.data ? (
        <ErrorState
          title="No pude cargar el alta"
          error={query.error instanceof ApiError ? query.error.shape : query.error}
          onRetry={() => void query.refetch()}
        />
      ) : total === 0 ? (
        filtered ? (
          <EmptyState
            icon={Filter}
            title="Sin clínicas en el alta con estos filtros"
            description="Prueba con otro producto, responsable u origen."
            actionLabel="Quitar filtros"
            onAction={onClearFilters}
          />
        ) : (
          <EmptyState
            icon={KanbanSquare}
            title="Ninguna clínica está en el alta"
            description="Una clínica aparece aquí cuando entra y avanza sola con cada paso que da."
          />
        )
      ) : search.vista === "lista" ? (
        <AltaList columns={columns} isFetching={query.isFetching} />
      ) : (
        <AltaBoard columns={columns} stale={query.isPlaceholderData} />
      )}
    </>
  )
}

/* ---------- Tablero ---------- */

function AltaColumnHeader({ column }: { column: AltaColumn }) {
  return (
    <header>
      <h2 id={`alta-${column.key}`} className="flex items-baseline gap-2 text-sm font-semibold">
        {ALTA_COLUMN_WORDS[column.key].title}
        <span className="font-medium text-muted-foreground tabular-nums">
          {column.cards.length}
        </span>
      </h2>
      <p className="text-xs text-muted-foreground">{ALTA_COLUMN_WORDS[column.key].fact}</p>
    </header>
  )
}

export function AltaBoard({ columns, stale }: { columns: AltaColumn[]; stale: boolean }) {
  const [showPaid, setShowPaid] = React.useState(false)
  const paid = columns.find((column) => column.key === "pago")
  return (
    // Las columnas en fila desde tableta, recorridas de lado dentro del ScrollArea; en el
    // teléfono, una debajo de otra. Tarjetas del mismo ancho, apiladas: nunca alturas sueltas.
    <ScrollArea
      horizontal
      className={`min-w-0 max-w-full rounded-xl transition-opacity ${stale ? "opacity-60" : ""}`}
    >
      <section
        aria-label="Tablero del alta"
        aria-busy={stale || undefined}
        className={PIPELINE_BOARD_CLASS}
      >
        {columns
          .filter((column) => column.key !== "pago")
          .map((column) => (
            <section
              key={column.key}
              aria-labelledby={`alta-${column.key}`}
              className={PIPELINE_COLUMN_CLASS}
            >
              <AltaColumnHeader column={column} />
              {column.cards.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  Ninguna ahora.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {column.cards.map((card) => (
                    <li key={card.clientId}>
                      <AltaCard card={card} paid={false} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        {paid ? (
          <section aria-labelledby="alta-pago" className={PIPELINE_COLUMN_CLASS}>
            <AltaColumnHeader column={paid} />
            <p className="text-sm">
              {paid.cards.length === 1 ? "1 clínica" : `${paid.cards.length} clínicas`} en 30 días
            </p>
            {paid.cards.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 w-fit"
                aria-expanded={showPaid}
                aria-controls="alta-pago-tarjetas"
                onClick={() => setShowPaid((shown) => !shown)}
              >
                <ChevronDown
                  aria-hidden
                  className={showPaid ? "rotate-180 transition-transform" : "transition-transform"}
                />
                {showPaid ? "Plegar" : "Ver cuáles"}
              </Button>
            ) : null}
            {showPaid ? (
              <ul id="alta-pago-tarjetas" className="flex flex-col gap-2">
                {paid.cards.map((card) => (
                  <li key={card.clientId}>
                    <AltaCard card={card} paid />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </section>
    </ScrollArea>
  )
}

/**
 * La tarjeta de un alta: abre la ficha en «Alta». Siempre las mismas líneas (producto y días,
 * nombre, lo que falta, a quién le toca) y la franja de Kairós solo si está trabada.
 */
function AltaCard({ card, paid }: { card: AltaCardData; paid: boolean }) {
  return (
    <Link
      to="/clients/$clientId"
      params={{ clientId: card.clientId }}
      search={{ tab: "alta" }}
      className="lift flex flex-col gap-1.5 rounded-lg border bg-card p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-between gap-2">
        <ProductMark product={card.product} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {paid && card.paidAt ? altaPaidWords(card.paidAt) : altaDaysWords(card.daysInAlta)}
        </span>
      </span>
      <span className="font-semibold leading-snug break-words">{card.name}</span>
      <span
        className={
          card.stuck ? "text-xs font-medium text-warning" : "text-xs text-muted-foreground"
        }
      >
        {altaMissingWords(card, paid)}
      </span>
      <span className="text-xs text-muted-foreground">{altaWhoWords(card)}</span>
      {card.stuck ? (
        <span className="flex items-start gap-1.5 rounded-md border border-agent-border bg-agent-soft p-2 text-xs">
          <AgentMark size="sm" className="size-5" />
          <span className="line-clamp-2">
            <span className="font-semibold">Kairós · Trabada: </span>
            {card.stuck.words.charAt(0).toLowerCase() + card.stuck.words.slice(1)}
          </span>
        </span>
      ) : null}
    </Link>
  )
}

/* ---------- Lista ---------- */

type AltaRow = AltaCardData & { column: AltaColumnKey }

export function AltaList({ columns, isFetching }: { columns: AltaColumn[]; isFetching: boolean }) {
  const navigate = useNavigate()
  const rows = React.useMemo<AltaRow[]>(
    () =>
      columns.flatMap((column) => column.cards.map((card) => ({ ...card, column: column.key }))),
    [columns],
  )
  const tableColumns = React.useMemo<ColumnDef<AltaRow>[]>(
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
        id: "column",
        header: "En el alta",
        cell: ({ row }) => ALTA_COLUMN_WORDS[row.original.column].title,
      },
      {
        id: "missing",
        header: "Falta",
        cell: ({ row }) =>
          row.original.missing
            ? row.original.missing.words.charAt(0).toUpperCase() +
              row.original.missing.words.slice(1)
            : "—",
        meta: { view: { primary: true } },
      },
      {
        id: "who",
        header: "Quién",
        cell: ({ row }) => altaWhoWords(row.original),
        meta: { view: { primary: true } },
      },
      {
        id: "days",
        header: "Días",
        cell: ({ row }) =>
          row.original.column === "pago" && row.original.paidAt
            ? altaPaidWords(row.original.paidAt)
            : altaDaysWords(row.original.daysInAlta),
      },
      {
        id: "stuck",
        header: "Kairós",
        cell: ({ row }) =>
          row.original.stuck ? (
            <Badge variant="outline" title={row.original.stuck.words}>
              Trabada · {row.original.stuck.days} días
            </Badge>
          ) : (
            "—"
          ),
      },
    ],
    [],
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
          search: { tab: "alta" },
        })
      }
    />
  )
}
