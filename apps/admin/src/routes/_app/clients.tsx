/**
 * Clientes (tablero 2 del lienzo del ARM, ADR 0184): todas las clínicas de
 * odentIA, latidIA y vistIA en una sola lista, desde el primer contacto hasta
 * las que pagan. Reemplaza a Lista de espera y Organizaciones: cada clínica es
 * una fila, con su etapa (la calcula el servidor; nadie la mueve), su próximo
 * paso y quién la lleva, y lo que Kairós marca en palabras. Las vistas, los
 * filtros y la búsqueda viven en la dirección (`clientsSearchOf`); la fila abre
 * la ficha, que es su página. Las demos no son clientes: están en Demos.
 */
import { CLINICAL_PRODUCTS, productWords } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import {
  AgentMark,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  type FilterDef,
  PageHeader,
  PageShell,
  ViewTabs,
} from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { CircleAlert, Plus, Users } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  type ClientListItem,
  clientListSchema,
  nextStepWords,
  ORIGIN_WORDS,
  SELLING_STAGES,
  STAGE_WORDS,
  VIEW_WORDS,
  whenWords,
  wordOf,
} from "../../components/arm/client-model"
import { NewClientDrawer, useStaff } from "../../components/arm/new-client-drawer"
import {
  type ProductChoice,
  ProductFilter,
  ProductMark,
  perProduct,
} from "../../components/product"
import {
  CLIENTS_SUBTITLE,
  ClientsPageSkeleton,
  ClientsTableSkeleton,
} from "../../components/skeletons/clients"
import { ApiError, api } from "../../lib/api"
import {
  CLIENT_LIST_VIEWS,
  CLIENT_ORIGIN_NAMES,
  CLIENT_STAGE_NAMES,
  type ClientListView,
  type ClientsSearch,
  clientsSearchOf,
  rememberClientsSearch,
} from "../../lib/list-search"
import { useIsAdmin } from "../../lib/session"

export const Route = createFileRoute("/_app/clients")({
  // Cada filtro va siempre, vacío si su valor no sirve: «?vista=xyz» o «?etapa=xyz» se ignoran.
  validateSearch: (search: Record<string, unknown>): ClientsSearch => clientsSearchOf(search),
  pendingComponent: ClientsPageSkeleton,
  component: ClientsPage,
})

const PAGE_SIZE = 50

/** Las etapas que tienen sentido en cada vista: en las cerradas, la etapa ya es la vista. */
const STAGES_OF: Record<ClientListView, readonly string[]> = {
  por_vender: SELLING_STAGES,
  con_cuenta: [],
  no_por_ahora: [],
  perdidos: [],
  todos: CLIENT_STAGE_NAMES,
}

/** Lugares de Fundador y cómo se abren las clínicas de cada producto (ADR 0093), como en la lista de espera. */
const seatsSchema = z.object({
  seats: perProduct(
    z.object({ used: z.number(), limit: z.number().nullable() }).nullable().default(null),
  ),
  modes: perProduct(z.enum(["invitacion", "abierta"]).default("invitacion")),
})

function ClientsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const isAdmin = useIsAdmin()
  const [creating, setCreating] = React.useState(false)
  const view: ClientListView = search.vista ?? "por_vender"
  const page = search.pagina ?? 1
  const product: ProductChoice = search.producto ?? "todos"
  // «← Clientes» de la ficha vuelve con lo que se miraba.
  React.useEffect(() => rememberClientsSearch(search), [search])

  const list = useQuery({
    queryKey: [
      "admin",
      "clients",
      "list",
      view,
      search.producto ?? "",
      search.responsable ?? "",
      search.origen ?? "",
      search.etapa ?? "",
      search.q ?? "",
      page,
    ],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({
        view,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      })
      if (search.producto) params.set("product", search.producto)
      if (search.responsable) params.set("owner", search.responsable)
      if (search.origen) params.set("origin", search.origen)
      if (search.etapa && STAGES_OF[view].includes(search.etapa)) params.set("stage", search.etapa)
      if (search.q) params.set("q", search.q)
      return clientListSchema.parse(await api<unknown>(`/api/admin/clients?${params}`))
    },
  })
  // Otro filtro u otra búsqueda vuelven a la primera página.
  const filterKey = [search.responsable, search.origen, search.etapa, search.q].join("|")
  const lastFilter = React.useRef(filterKey)
  React.useEffect(() => {
    if (lastFilter.current === filterKey) return
    lastFilter.current = filterKey
    if (search.pagina)
      void navigate({ search: (prev) => ({ ...prev, pagina: undefined }), replace: true })
  }, [filterKey, search.pagina, navigate])
  const staff = useStaff()
  const seats = useQuery({
    queryKey: ["admin", "waitlist", "seats"],
    staleTime: 60_000,
    queryFn: async () =>
      seatsSchema.parse(await api<unknown>("/api/admin/waitlist?stage=invitada")),
  })

  const rows = React.useMemo(() => list.data?.items ?? [], [list.data?.items])
  const columns = React.useMemo<ColumnDef<ClientListItem>[]>(
    () => [
      {
        id: "clinic",
        header: "Clínica",
        cell: ({ row }) => <ClinicCell item={row.original} />,
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
        cell: ({ row }) => (
          <Badge variant="outline">{wordOf(STAGE_WORDS, row.original.stage, "Contacto")}</Badge>
        ),
        meta: { view: { primary: true } },
      },
      {
        id: "next",
        header: "Próximo paso",
        cell: ({ row }) => <NextStepCell item={row.original} />,
        meta: { view: { primary: true } },
      },
      {
        id: "owner",
        header: "Responsable",
        cell: ({ row }) =>
          row.original.owner ? (
            row.original.owner.name || "Sin nombre"
          ) : (
            <span className="text-muted-foreground">Sin responsable</span>
          ),
      },
      {
        id: "origin",
        header: "Origen",
        cell: ({ row }) => wordOf(ORIGIN_WORDS, row.original.origin, "Otro"),
      },
      {
        id: "last",
        header: "Último contacto",
        cell: ({ row }) =>
          row.original.lastContactAt ? (
            whenWords(row.original.lastContactAt)
          ) : (
            <span className="text-muted-foreground">Sin contacto</span>
          ),
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  const counts = list.data?.counts
  const viewOptions = React.useMemo(
    () =>
      CLIENT_LIST_VIEWS.map((value) => ({
        value,
        label: VIEW_WORDS[value],
        ...(counts ? { count: counts[value] ?? 0 } : {}),
      })),
    [counts],
  )
  const stageOptions = STAGES_OF[view]
  const filters = React.useMemo<FilterDef[]>(() => {
    const people = (staff.data ?? []).map((row) => ({
      value: row.userId,
      label: row.name || row.email,
    }))
    return [
      {
        key: "responsable",
        label: "Responsable",
        type: "select",
        options: [
          { value: "mio", label: "Míos" },
          { value: "sin", label: "Sin responsable" },
          ...people,
        ],
      },
      {
        key: "origen",
        label: "Origen",
        type: "select",
        options: CLIENT_ORIGIN_NAMES.map((origin) => ({
          value: origin,
          label: ORIGIN_WORDS[origin],
        })),
      },
      ...(stageOptions.length
        ? [
            {
              key: "etapa",
              label: "Etapa",
              type: "select" as const,
              options: stageOptions.map((stage) => ({
                value: stage,
                label: wordOf(STAGE_WORDS, stage),
              })),
            },
          ]
        : []),
    ]
  }, [staff.data, stageOptions])

  const setView = (next: ClientListView) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        vista: next === "por_vender" ? undefined : next,
        // Una etapa que no es de la vista nueva no se arrastra; la página vuelve a la 1.
        etapa: prev.etapa && STAGES_OF[next].includes(prev.etapa) ? prev.etapa : undefined,
        pagina: undefined,
      }),
    })
  const filtered = Boolean(
    search.producto || search.responsable || search.origen || search.etapa || search.q,
  )
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title="Clientes"
        subtitle={<ClientsSubtitle seats={seats.data} isAdmin={isAdmin} />}
        primary={{
          label: "Nuevo cliente",
          icon: <Plus aria-hidden />,
          onClick: () => setCreating(true),
        }}
      />
      <div className="flex flex-col gap-4">
        <ViewTabs
          label="Qué clientes ver"
          value={view}
          options={viewOptions}
          onValueChange={setView}
        />
        <ProductFilter
          value={product}
          onChange={(value) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                producto: value === "todos" ? undefined : value,
                pagina: undefined,
              }),
            })
          }
        />
        <FilterBar
          filters={filters}
          sortOptions={[]}
          searchPlaceholder="Buscar por clínica, persona, correo o teléfono"
          searchLabel="Buscar en clientes"
          searchPending={list.isFetching && !list.isPending}
          resetKeys={["responsable", "origen", "etapa", "q", "pagina"]}
        />

        {list.isPending ? (
          <ClientsTableSkeleton />
        ) : list.isError && !list.data ? (
          <ErrorState
            title="No pude cargar los clientes"
            error={list.error instanceof ApiError ? list.error.shape : list.error}
            onRetry={() => void list.refetch()}
          />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title="Ningún cliente con estos filtros"
              description="Busca por la clínica, una persona, su correo o su celular, o quita los filtros."
              actionLabel="Quitar los filtros"
              onAction={() =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    producto: undefined,
                    responsable: undefined,
                    origen: undefined,
                    etapa: undefined,
                    q: undefined,
                    pagina: undefined,
                  }),
                })
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title={
                view === "por_vender"
                  ? "No hay clínicas por vender"
                  : `No hay clientes en «${VIEW_WORDS[view]}»`
              }
              description="Una clínica es cliente desde que alguien la contacta: las solicitudes de la web llegan solas y las demás se agregan con «Nuevo cliente»."
              actionLabel="Nuevo cliente"
              onAction={() => setCreating(true)}
            />
          )
        ) : (
          <>
            <DataTable
              table={table}
              wrap
              isFetching={list.isFetching}
              onRowClick={(item) =>
                void navigate({ to: "/clients/$clientId", params: { clientId: item.id } })
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                {total === 1 ? "1 cliente" : `${total} clientes`}
                {pages > 1 ? ` · página ${page} de ${pages}` : ""}. Las demos no salen aquí: están
                en Demos.
              </span>
              {pages > 1 ? (
                <span className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() =>
                      void navigate({
                        search: (prev) => ({
                          ...prev,
                          pagina: page - 1 > 1 ? page - 1 : undefined,
                        }),
                      })
                    }
                  >
                    Anterior
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() =>
                      void navigate({ search: (prev) => ({ ...prev, pagina: page + 1 }) })
                    }
                  >
                    Siguiente
                  </Button>
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
      <NewClientDrawer open={creating} onClose={() => setCreating(false)} />
    </PageShell>
  )
}

/** Lo de siempre y, cuando llega, los lugares de Fundador y cómo se abren las clínicas de cada producto. */
function ClientsSubtitle({
  seats,
  isAdmin,
}: {
  seats: z.infer<typeof seatsSchema> | undefined
  isAdmin: boolean
}) {
  if (!seats) return <p className="min-w-0">{CLIENTS_SUBTITLE}</p>
  const seatText = CLINICAL_PRODUCTS.map((product) => {
    const of = seats.seats[product]
    return `${productWords(product).name} ${of ? (of.limit === null ? of.used : `${of.used} de ${of.limit}`) : "sin plan"}`
  }).join(" · ")
  const modes = CLINICAL_PRODUCTS.map(
    (product) =>
      `${productWords(product).name} ${seats.modes[product] === "invitacion" ? "solo con invitación" : "abierta"}`,
  ).join(" · ")
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="min-w-0">{CLIENTS_SUBTITLE}</p>
      <p className="min-w-0">
        Lugares de Fundador: {seatText}. Alta de clínicas: {modes}
        {isAdmin ? (
          <>
            {" · "}
            <Link to="/billing" hash="alta" className="font-medium text-foreground underline">
              Cambiar
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}

/** El nombre y, debajo, lo que marca Kairós en palabras (sin próximo paso, se enfría, ¿repetida?). */
function ClinicCell({ item }: { item: ClientListItem }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {/* El nombre es el enlace de la fila: se abre con el teclado y en otra pestaña. */}
      <Link
        to="/clients/$clientId"
        params={{ clientId: item.id }}
        className="font-semibold [overflow-wrap:anywhere] outline-none hover:underline focus-visible:underline"
      >
        {item.name}
      </Link>
      {item.signals.length ? (
        <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AgentMark size="sm" className="mt-px size-5 rounded-md [&>svg]:size-3" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">Kairós: </span>
            {item.signals.map((signal) => signal.words).join(" · ")}
          </span>
        </span>
      ) : null}
    </span>
  )
}

function NextStepCell({ item }: { item: ClientListItem }) {
  if (!item.nextStep)
    return (
      <span
        className={
          (SELLING_STAGES as readonly string[]).includes(item.stage)
            ? "font-medium"
            : "text-muted-foreground"
        }
      >
        Sin próximo paso
      </span>
    )
  const { when, what } = nextStepWords(item.nextStep)
  return (
    <span className="flex min-w-0 flex-col">
      <span
        className={
          item.nextStep.overdue
            ? "inline-flex items-center gap-1 font-medium text-destructive"
            : "font-medium"
        }
      >
        {item.nextStep.overdue ? <CircleAlert aria-hidden className="size-3.5 shrink-0" /> : null}
        {when}
      </span>
      <span className="text-muted-foreground [overflow-wrap:anywhere]">{what}</span>
    </span>
  )
}
