import {
  Badge,
  Button,
  cn,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FilterBar,
  type FilterDef,
  FormDrawer,
  PageHeader,
  PageNotice,
  PersonAvatar,
  SkeletonRegion,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  useListSearch,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import {
  ArrowLeft,
  BookmarkPlus,
  MessageCircle,
  Plus,
  Repeat,
  SearchX,
  UserRound,
  Users,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useMemo, useState } from "react"
import { z } from "zod"
import { api } from "./lib/api"
import {
  boughtBadges,
  CUSTOMER_KEY,
  CUSTOMERS_KEY,
  type CustomerComputed,
  type CustomerDetail,
  type CustomerFilters,
  type CustomerList,
  type CustomerSummary,
  channelsText,
  customerSearch,
  dayOf,
  filtersOf,
  GROUPS_KEY,
  groupNameOf,
  hasFilters,
  historyText,
  lastBoughtText,
  listQuery,
  owedText,
  plural,
  priceText,
  purchasesText,
  reasonText,
  type SavedGroup,
  SEGMENT_IDS,
  SEGMENTS,
  type Segment,
  type SimilarPair,
  sameFilters,
  searchOfGroup,
  sinceText,
  WANTED_KIND,
  whatsappLink,
} from "./lib/clientes"
import { HOME_KEY } from "./lib/inicio"
import { STATE_TONE, stateName } from "./lib/pedidos"
import { type ConsentState, shortDate } from "./lib/perfil"
import { money } from "./lib/tienda"
import { NewOrderSheet, type OrderDraft } from "./pedidos"
import { ArgosKnows, DeArgos, ProfileCard, WhenToWrite } from "./perfil"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Clientes (entrega 4 de «gestorIA como odentIA», tablero 8): cada clienta con todos sus canales
 * y sus compras, como la ficha de la persona en odentIA, sin nada clínico. Cada pedido que se anota
 * o que arma Sofi se suma a su ficha. Que dos fichas sean la misma lo dice una persona: el mismo
 * teléfono o el mismo nombre solo lo sugieren («¿Es la misma clienta?»), y se puede separar.
 *
 * Lo calculado y los grupos (lienzo «Clientas con Argos», PR 2): cada noche Argos le calcula a cada
 * clienta su grupo, su gasto y lo que compra, con sus pedidos pagados; nadie la mueve a mano. La
 * lista se filtra por grupo, medida, categoría, distrito y promociones (en la dirección), y lo
 * elegido se guarda como grupo, que Argos pone al día solo.
 *
 * Lo ve todo el equipo que atiende: Dueño, Administrador y Ventas.
 */

const SIMILAR_KEY = (storeId: string) => ["clientes-parecidas", storeId]

/** Lo que muestra «¿Es la misma clienta?» de cada ficha. */
type CompareCard = Pick<
  CustomerSummary,
  "id" | "name" | "phones" | "channels" | "purchases" | "lastOrder" | "lastAddress"
>

function cardOf(customer: CustomerDetail): CompareCard {
  const last = customer.orders[0]
  return {
    id: customer.id,
    name: customer.name,
    phones: customer.phones,
    channels: customer.channels,
    purchases: customer.purchases,
    lastOrder: last ? { number: last.number, createdAt: last.createdAt, text: last.text } : null,
    lastAddress: customer.addresses[0]?.address || null,
  }
}

/** Que todo lo de las clientas se vuelva a pedir: la lista, las fichas y las sugerencias. */
function useRefreshCustomers() {
  const queryClient = useQueryClient()
  const { store } = useStoreContext()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEY(store.id) }),
      queryClient.invalidateQueries({ queryKey: CUSTOMER_KEY(store.id) }),
      queryClient.invalidateQueries({ queryKey: SIMILAR_KEY(store.id) }),
      // «¿Es la misma clienta?» también está en «Te toca» de Inicio.
      queryClient.invalidateQueries({ queryKey: HOME_KEY(store.id) }),
    ])
}

/** El grupo de la clienta, con su color y su nombre escrito. */
export function SegBadge({ segment, className }: { segment: Segment; className?: string }) {
  const seg = SEGMENTS[segment]
  if (!seg) return null
  return (
    <Badge variant="outline" className={cn("gap-1.5 border-transparent", seg.className, className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {seg.label}
    </Badge>
  )
}

/** «Promociones» en una fila: lo último que ella dijo, corto. */
const CONSENT_SHORT: Record<
  ConsentState,
  { label: string; variant: "success" | "destructive" | "outline" }
> = {
  si: { label: "Acepta", variant: "success" },
  baja: { label: "Pidió que no", variant: "destructive" },
  no: { label: "Dijo que no", variant: "outline" },
  sin_preguntar: { label: "Sin permiso", variant: "outline" },
}

/* ------------------------------------------------------------------------- la lista */

/** La lista y la ficha son dos páginas; la dirección de la lista (sus filtros) vale en las dos. */
export function CustomersLayout() {
  return <Outlet />
}

/** Lo que dice cada clienta debajo de su nombre, si el servidor no trae su línea. */
function lineOf(c: CustomerSummary): string {
  return c.whoLine || [channelsText(c.channels), c.lastZone].filter(Boolean).join(" · ")
}

/**
 * Clientes: cada clienta con el grupo que Argos le calculó. Pestañas por grupo con su cuenta,
 * filtros y orden en la dirección (se conservan al abrir una ficha y volver), «Tus grupos» y
 * «Guardar como grupo».
 */
export function CustomersIndex() {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const raw = useSearch({ strict: false }) as Record<string, unknown>
  const search = customerSearch(raw)
  const filters = filtersOf(search)
  const query = listQuery(filters, search.q)
  const { setParam, setParams } = useListSearch()
  const list = useQuery({
    queryKey: [...CUSTOMERS_KEY(store.id), query],
    queryFn: () => api<CustomerList>(`/api/tiendas/${store.id}/clientes${query}`),
    placeholderData: (previous) => previous,
  })
  const [comparing, setComparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const customers = list.data?.customers ?? []
  const similar = list.data?.similar ?? 0
  const facets = list.data?.facets
  const measureLabel = list.data?.measureLabel || "Medida"
  const counts = facets?.segments ?? {}
  const total = SEGMENT_IDS.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  const filtered = hasFilters(filters)

  // Cada filtro con lo que hay en la tienda; lo elegido sigue en su lista aunque hoy no salga.
  const optionsOf = (values: string[] | undefined, chosen: string | undefined) =>
    [...new Set([...(values ?? []), ...(chosen ? [chosen] : [])])].map((value) => ({
      value,
      label: value,
    }))
  const filterDefs: FilterDef[] = [
    {
      key: "medida",
      label: measureLabel,
      type: "select" as const,
      options: optionsOf(facets?.measures, search.medida),
    },
    {
      key: "categoria",
      label: "Categoría",
      type: "select" as const,
      options: optionsOf(facets?.categories, search.categoria),
    },
    {
      key: "distrito",
      label: "Distrito",
      type: "select" as const,
      options: optionsOf(facets?.districts, search.distrito),
    },
  ].filter((def) => def.options.length > 0)
  filterDefs.push({
    key: "promociones",
    label: "Promociones",
    type: "select",
    options: [
      { value: "si", label: "Aceptan promociones" },
      { value: "no", label: "No las reciben" },
    ],
  })

  const columns = useMemo<ColumnDef<CustomerSummary>[]>(
    () => [
      {
        id: "clienta",
        header: "Clienta",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const c = row.original
          const owes = owedText(c, store.currency)
          const line = lineOf(c)
          return (
            <span className="flex min-w-0 items-center gap-3">
              <PersonAvatar name={c.name} className="size-9" decorative />
              <span className="flex min-w-0 max-w-80 flex-col">
                <Link
                  to="/tiendas/$id/clientes/$customerId"
                  params={{ id: store.id, customerId: c.id }}
                  search={(previous: Record<string, unknown>) => previous}
                  className="truncate rounded-sm font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  {c.name}
                </Link>
                {line ? (
                  <span className="truncate text-xs text-muted-foreground">{line}</span>
                ) : null}
                {owes ? <span className="text-xs font-medium text-warning">{owes}</span> : null}
              </span>
            </span>
          )
        },
      },
      {
        id: "grupo",
        header: "Grupo",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.segment ? (
            <SegBadge segment={row.original.segment} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "medida",
        header: measureLabel,
        meta: { view: { tableOnly: true } },
        cell: ({ row }) =>
          row.original.measure ? (
            <span className="tabular-nums">{row.original.measure}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "distrito",
        header: "Distrito",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          // Solo el de su perfil: la zona de reparto de la tienda no es un distrito.
          const district = row.original.district
          return district ? (
            <span className="whitespace-nowrap">{district}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: "compras",
        header: "Compras",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const c = row.original
          const count = c.ordersCount ?? c.purchases
          return (
            <span className="flex flex-col whitespace-nowrap tabular-nums">
              <span>{plural(count, "compra", "compras")}</span>
              {c.totalCents !== undefined && count > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {money(c.totalCents, store.currency)}
                </span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "ultima",
        header: "Última compra",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const c = row.original
          return (
            <span className="whitespace-nowrap tabular-nums">
              {c.lastBoughtDays !== undefined
                ? lastBoughtText(c.lastBoughtDays)
                : c.lastPurchaseAt
                  ? `La última ${dayOf(c.lastPurchaseAt, store.timeZone)}`
                  : "Sin compras"}
            </span>
          )
        },
      },
      {
        id: "promociones",
        header: "Promociones",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const consent = row.original.consent ? CONSENT_SHORT[row.original.consent] : null
          return consent ? (
            <Badge variant={consent.variant}>{consent.label}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
    ],
    [store.id, store.currency, store.timeZone, measureLabel],
  )
  const table = useReactTable({ data: customers, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <>
      <StoreHeader
        title="Clientes"
        subtitle={
          facets ? (
            <DeArgos className="text-sm">
              {plural(total, "clienta", "clientas")} · Argos las perfila solo, con sus chats y sus
              pedidos pagados
            </DeArgos>
          ) : (
            "Cada clienta con sus compras, llegue por donde llegue."
          )
        }
        secondary={{
          label: "Guardar como grupo",
          icon: <BookmarkPlus aria-hidden />,
          disabled: !filtered,
          onClick: () => setSaving(true),
        }}
      />
      {similar > 0 ? (
        <PageNotice
          tone="aviso"
          label="Por mirar"
          action={
            <Button size="sm" variant="outline" onClick={() => setComparing(true)}>
              Comparar
            </Button>
          }
        >
          {similar === 1
            ? "Dos fichas podrían ser la misma clienta."
            : `${similar} parejas de fichas podrían ser la misma clienta.`}{" "}
          Lo decide una persona; no frena ninguna venta.
        </PageNotice>
      ) : null}
      {facets ? (
        <ViewTabs
          label="Grupo de la clienta"
          value={search.grupo ?? "todas"}
          onValueChange={(value) => setParam("grupo", value === "todas" ? undefined : value)}
          options={[
            { value: "todas", label: "Todas", count: total },
            ...SEGMENT_IDS.filter((id) => (counts[id] ?? 0) > 0 || search.grupo === id).map(
              (id) => ({ value: id, label: SEGMENTS[id].label, count: counts[id] ?? 0 }),
            ),
          ]}
        />
      ) : null}
      <FilterBar
        filters={filterDefs}
        sortOptions={[
          { value: "reciente", label: "Compró hace menos" },
          { value: "gasto", label: "Gastó más" },
        ]}
        searchLabel="Buscar en clientes"
        searchPlaceholder="Buscar por nombre o teléfono"
        searchPending={list.isFetching && !list.isPending}
        resetKeys={["q", "medida", "categoria", "distrito", "promociones"]}
      />
      <SavedGroups current={filters} onApply={(group) => setParams(searchOfGroup(group.filters))} />
      <section aria-label="Clientas" className="flex min-w-0 flex-col gap-3">
        {list.isPending ? <CustomersSkeleton /> : null}
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : null}
        {list.data && customers.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title="Ninguna clienta en este grupo"
              description="Con lo elegido no sale ninguna hoy. Argos la suma sola cuando alguna cumpla."
              actionLabel="Ver todas"
              onAction={() =>
                setParams({
                  grupo: undefined,
                  medida: undefined,
                  categoria: undefined,
                  distrito: undefined,
                  promociones: undefined,
                  q: undefined,
                })
              }
            />
          ) : search.q ? (
            <EmptyState
              icon={UserRound}
              title={`Nadie coincide con «${search.q}»`}
              description="Busca por su nombre o por parte de su teléfono. Si es nueva, su ficha se abre al anotar su pedido."
            />
          ) : (
            <EmptyState
              icon={UserRound}
              title="Todavía no hay clientas"
              description="Cada pedido que anotas o que arma Sofi abre la ficha de su clienta. Las compras de antes de estrenar Clientes no se unen solas por el teléfono: siguen en Pedidos."
            />
          )
        ) : null}
        {customers.length > 0 ? (
          <DataTable
            table={table}
            isFetching={list.isFetching && !list.isPending}
            onRowClick={(c) =>
              void navigate({
                to: "/tiendas/$id/clientes/$customerId",
                params: { id: store.id, customerId: c.id },
                search: (previous: Record<string, unknown>) => previous,
              })
            }
          />
        ) : null}
        {list.data?.limited ? (
          <p className="text-xs text-muted-foreground">
            Se ven las {customers.length} con compras más recientes. Busca o filtra para encontrar a
            las demás.
          </p>
        ) : null}
      </section>
      {comparing ? <SimilarQueue onClose={() => setComparing(false)} /> : null}
      {saving ? (
        <SaveGroupSheet
          filters={filters}
          count={customers.length}
          limited={Boolean(list.data?.limited)}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </>
  )
}

/** Lo que se ve mientras llega la lista: la tabla (o las filas, en el teléfono) en su lugar. */
function CustomersSkeleton() {
  return <DataTableSkeleton columnCount={7} rowCount={6} label="Cargando clientes…" />
}

/**
 * «Tus grupos»: lo que la tienda guardó, cada uno un botón que aplica sus filtros (apretado si es
 * lo elegido ahora) y su «×» para quitarlo. Sin grupos, o si no se pudieron traer, no se dibuja:
 * la lista sigue igual.
 */
function SavedGroups({
  current,
  onApply,
}: {
  current: CustomerFilters
  onApply: (group: SavedGroup) => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const labelId = useId()
  const groups = useQuery({
    queryKey: GROUPS_KEY(store.id),
    queryFn: () => api<{ groups: SavedGroup[] }>(`/api/tiendas/${store.id}/clientes/grupos`),
    retry: false,
  })
  const remove = useMutation({
    mutationFn: (group: SavedGroup) =>
      api(`/api/tiendas/${store.id}/clientes/grupos/${group.id}`, { method: "DELETE" }),
    onSuccess: async (_data, group) => {
      await queryClient.invalidateQueries({ queryKey: GROUPS_KEY(store.id) })
      toast.success(`Grupo «${group.name}» quitado. Las clientas siguen igual.`)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const list = groups.data?.groups ?? []
  if (list.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span id={labelId} className="text-sm text-muted-foreground">
        Tus grupos
      </span>
      <ul aria-labelledby={labelId} className="flex min-w-0 flex-wrap items-center gap-2">
        {list.map((group) => {
          const active = sameFilters(current, group.filters)
          const removing = remove.isPending && remove.variables?.id === group.id
          return (
            <li
              key={group.id}
              className={cn(
                "inline-flex max-w-full min-w-0 items-center rounded-full border bg-card",
                active && "border-accent bg-accent-soft",
              )}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={active}
                className="min-w-0 rounded-full max-md:min-h-11"
                onClick={() => onApply(group)}
              >
                <Users aria-hidden />
                <span className="truncate">{group.name}</span>
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="mr-0.5 rounded-full max-md:size-11"
                aria-label={`Quitar el grupo «${group.name}»`}
                disabled={removing}
                onClick={() => remove.mutate(group)}
              >
                <X aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * «Guardar como grupo»: lo elegido en la lista, con un nombre. No es una lista fija: Argos lo pone
 * al día solo (entra quien cumpla, sale quien no).
 */
function SaveGroupSheet({
  filters,
  count,
  limited,
  onClose,
}: {
  filters: CustomerFilters
  count: number
  limited: boolean
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: { name: string; filters: CustomerFilters }) =>
      api<{ group: SavedGroup }>(`/api/tiendas/${store.id}/clientes/grupos`, {
        method: "POST",
        body,
      }),
  })
  const form = useAppForm({
    defaultValues: { name: groupNameOf(filters) },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, "Escribe su nombre").max(60, "Hasta 60 letras"),
      }),
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      await save.mutateAsync({ name, filters })
      await queryClient.invalidateQueries({ queryKey: GROUPS_KEY(store.id) })
      toast.success(`Grupo «${name}» guardado. Argos lo pone al día solo.`)
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const today = limited ? `más de ${count} clientas` : plural(count, "clienta", "clientas")
  return (
    <FormDrawer
      {...surface}
      open
      title="Guardar como grupo"
      description={`Argos lo pone al día solo: entra quien cumpla, sale quien no. Hoy son ${today}.`}
      submitLabel="Guardar grupo"
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="name">
          {(field) => <field.TextField label="Nombre" maxLength={60} />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ------------------------------------------------------------------------- la ficha */

export function CustomerPage() {
  const { store } = useStoreContext()
  const { customerId } = useParams({ strict: false }) as { customerId: string }
  const navigate = useNavigate()
  const detail = useQuery({
    queryKey: CUSTOMER_KEY(store.id, customerId),
    queryFn: async () =>
      (await api<{ customer: CustomerDetail }>(`/api/tiendas/${store.id}/clientes/${customerId}`))
        .customer,
  })
  // Una ficha que quedó dentro de otra se ve como esa otra: es la misma clienta.
  const shown = detail.data?.id
  useEffect(() => {
    if (shown && shown !== customerId)
      void navigate({
        to: "/tiendas/$id/clientes/$customerId",
        params: { id: store.id, customerId: shown },
        search: (previous: Record<string, unknown>) => previous,
        replace: true,
      })
  }, [shown, customerId, navigate, store.id])

  return (
    <>
      {/* Vuelve a la lista como estaba: sus filtros van en la dirección. */}
      <Link
        to="/tiendas/$id/clientes"
        params={{ id: store.id }}
        search={(previous: Record<string, unknown>) => previous}
        className="-mb-3 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Clientes
      </Link>
      {detail.isPending ? <CustomerSkeleton /> : null}
      {detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}
      {detail.data ? <CustomerCard customer={detail.data} /> : null}
    </>
  )
}

/** La ficha mientras llega: el encabezado y las dos columnas, en su lugar. */
function CustomerSkeleton() {
  return (
    <SkeletonRegion message="Abriendo su ficha…" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </SkeletonRegion>
  )
}

/** Un apartado dentro de una tarjeta de la ficha, con su título. */
function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Una cifra de «Lo que Argos calcula», con lo que la explica debajo. */
function Figure({
  label,
  hint,
  wide,
  children,
}: {
  label: string
  hint?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg bg-surface-muted p-3",
        wide && "sm:col-span-2",
      )}
    >
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-semibold break-words">{children}</dd>
      {hint ? <dd className="text-xs break-words text-muted-foreground">{hint}</dd> : null}
    </div>
  )
}

/**
 * «Lo que Argos calcula»: su grupo con su porqué, lo que gastó, cada cuánto compra, lo que compra,
 * cómo paga y lo que quiso y no compró. Son cuentas fijas sobre sus pedidos pagados, cada noche:
 * nadie la mueve de grupo a mano. Sin compras, solo su grupo y lo que quiso.
 */
function ArgosComputes({ computed }: { computed: CustomerComputed }) {
  const { store } = useStoreContext()
  const bought = computed.ordersCount > 0
  const price = priceText(computed)
  const badges = boughtBadges(computed)
  const wanted = computed.wanted ?? []
  return (
    <ProfileCard
      title="Lo que Argos calcula"
      subtitle="Con sus pedidos pagados, cada noche. Nadie la mueve a mano."
    >
      <dl className="grid gap-2.5 sm:grid-cols-2">
        <Figure label="Su grupo" hint={computed.why} wide>
          <SegBadge segment={computed.segment} />
        </Figure>
        {bought ? (
          <>
            <Figure label="Gasto total" hint={plural(computed.ordersCount, "compra", "compras")}>
              <span className="tabular-nums">{money(computed.totalCents, store.currency)}</span>
            </Figure>
            <Figure
              label="Ticket promedio"
              hint={
                computed.rhythmDays
                  ? `compra cada ${computed.rhythmDays} días`
                  : computed.ordersCount === 1
                    ? "una sola compra"
                    : undefined
              }
            >
              <span className="tabular-nums">{money(computed.avgCents, store.currency)}</span>
            </Figure>
            {badges.length > 0 ? (
              <Figure label="Lo que compra" wide>
                <span className="flex flex-wrap gap-1.5 font-normal">
                  {badges.map((badge) => (
                    <Badge key={badge.key} variant="outline">
                      {badge.text}
                    </Badge>
                  ))}
                </span>
              </Figure>
            ) : null}
            <Figure label="Precio" hint={price.why || undefined}>
              {price.value}
            </Figure>
          </>
        ) : null}
        {wanted.length > 0 ? (
          <Figure label="Lo que quiso y no compró" wide>
            <ul className="flex flex-col gap-0.5 font-normal">
              {wanted.map((item) => (
                <li key={`${item.kind}-${item.at}-${item.text}`}>
                  {[
                    item.text,
                    WANTED_KIND[item.kind],
                    item.orderNumber ? `pedido ${item.orderNumber}` : null,
                    shortDate(item.at, store.timeZone),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              ))}
            </ul>
          </Figure>
        ) : null}
      </dl>
    </ProfileCard>
  )
}

function CustomerCard({ customer }: { customer: CustomerDetail }) {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [repeating, setRepeating] = useState(false)
  const [comparing, setComparing] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [separating, setSeparating] = useState<{ id: string; name: string } | null>(null)
  const refresh = useRefreshCustomers()
  const separate = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string }>(`/api/tiendas/${store.id}/clientes/${id}/separar`, { method: "POST" }),
    onSuccess: async () => {
      await refresh()
      setSeparating(null)
      toast.success("Listo: volvió a ser otra ficha, con sus pedidos")
    },
  })
  const write = whatsappLink(customer.phones, customer.country)
  const joinedNotes = customer.members.filter((m) => m.note)
  const contact = [
    channelsText(customer.channels),
    ...customer.phones,
    customer.addresses[0]?.zone,
    sinceText(customer.since),
  ]
    .filter(Boolean)
    .join(" · ")
  const computed = customer.computed ?? null
  const chosen = { id: customer.id, name: customer.name, phone: customer.phones[0] ?? null }
  // «Repetir pedido» trae lo de su última compra; sin compras, el pedido nuevo va a su ficha.
  const draft: OrderDraft = customer.repeat
    ? {
        customer: chosen,
        number: customer.repeat.number,
        channel: customer.repeat.channel,
        lines: customer.repeat.lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          text: `${l.productName}${l.variantName === "Única" ? "" : ` · ${l.variantName}`}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`,
        })),
        deliveryMethodId: customer.repeat.deliveryMethodId,
        zone: customer.repeat.zone,
        address: customer.repeat.address,
        paymentMethodId: customer.repeat.paymentMethodId,
      }
    : { customer: chosen }
  const order = {
    label: customer.repeat ? "Repetir pedido" : "Anotar un pedido",
    icon: customer.repeat ? <Repeat aria-hidden /> : <Plus aria-hidden />,
    onClick: () => setRepeating(true),
  }

  return (
    <article aria-label={`Ficha de ${customer.name}`} className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-2">
        <PageHeader
          title={customer.name}
          subtitle={
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {computed ? <SegBadge segment={computed.segment} /> : null}
              <span className="min-w-0 break-words text-foreground">
                {customer.whoLine || contact}
              </span>
            </span>
          }
          // «Escribirle» abre su WhatsApp en el celular (lo envía la persona); sin un teléfono que
          // se pueda leer, lo principal es anotarle un pedido.
          primary={
            write
              ? {
                  label: "Escribirle",
                  icon: <MessageCircle aria-hidden />,
                  // biome-ignore lint/a11y/useAnchorContent: el encabezado le pone el texto y el icono
                  render: <a href={write} target="_blank" rel="noopener noreferrer" />,
                }
              : order
          }
          secondary={write ? order : undefined}
        />
      </div>

      {customer.similar.map((other) => (
        <PageNotice
          key={other.id}
          tone="aviso"
          label="Por mirar"
          action={
            <Button size="sm" variant="outline" onClick={() => setComparing(other.id)}>
              Comparar
            </Button>
          }
        >
          «{other.name}»{other.phone ? ` (${other.phone})` : ""} podría ser la misma clienta.
        </PageNotice>
      ))}

      {/* En ancho, lo que Argos sabe y calcula y sus compras a la izquierda; cuándo escribirle y lo
          del equipo a la derecha. En el teléfono, una columna en ese mismo orden. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <div className="flex min-w-0 flex-col gap-5">
          {customer.profile ? <ArgosKnows customer={customer} profile={customer.profile} /> : null}
          {computed ? <ArgosComputes computed={computed} /> : null}
          {customer.orders.length > 0 ? (
            <ProfileCard
              title="Compras"
              subtitle={plural(customer.orders.length, "pedido", "pedidos")}
            >
              <ul className="-mx-2 flex flex-col divide-y">
                {customer.orders.map((o) => (
                  <li key={o.id}>
                    <Link
                      to="/tiendas/$id/pedidos"
                      params={{ id: store.id }}
                      search={{ pedido: o.id }}
                      className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset sm:grid-cols-[3rem_minmax(0,1fr)_5.5rem_auto]"
                    >
                      <span className="font-mono tabular-nums">{o.number}</span>
                      <span className="min-w-0">
                        {dayOf(o.createdAt, store.timeZone)} · {o.text}
                        {o.priceNote ? (
                          <span className="text-muted-foreground">
                            {o.priceNote === "rebaja" ? " · con rebaja" : " · en liquidación"}
                          </span>
                        ) : null}
                        {o.channel !== "otro" ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · por {channelsText([o.channel])}
                          </span>
                        ) : null}
                      </span>
                      <span className="hidden text-right tabular-nums sm:block">
                        {money(o.totalCents, store.currency)}
                      </span>
                      <Badge variant={STATE_TONE[o.state]}>{stateName(o)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </ProfileCard>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {customer.profile ? <WhenToWrite profile={customer.profile} /> : null}

          <ProfileCard
            title="Lo que sabemos"
            action={
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Editar
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm break-words text-muted-foreground">{contact}</p>
              {customer.note ? (
                <div className="flex flex-col gap-0.5">
                  <p className="whitespace-pre-line text-sm">{customer.note}</p>
                  <p className="text-xs text-muted-foreground">
                    Nota del equipo, la clienta no la ve
                    {customer.noteByName && customer.noteAt
                      ? ` · escribió ${customer.noteByName.split(" ")[0]} ${dayOf(customer.noteAt, store.timeZone)}`
                      : ""}
                  </p>
                </div>
              ) : joinedNotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Su talla, cómo prefiere recibir, lo que conviene recordar. Es del equipo: la
                  clienta no lo ve.
                </p>
              ) : null}
              {/* Lo que se anotó en una ficha que se le unió: unir no lo mueve ni lo borra. */}
              {joinedNotes.map((m) => (
                <div key={m.id} className="flex flex-col gap-0.5 border-t pt-2">
                  <p className="whitespace-pre-line text-sm">{m.note}</p>
                  <p className="text-xs text-muted-foreground">
                    De la ficha que se le unió
                    {m.channels.length > 0 ? `, por ${channelsText(m.channels)}` : ""}
                  </p>
                </div>
              ))}
            </div>

            {customer.addresses.length > 0 ? (
              <Section title="Direcciones">
                <ul className="flex flex-col gap-1 text-sm">
                  {customer.addresses.map((a, i) => (
                    <li key={`${a.deliveryName}-${a.zone}-${a.address}`} className="break-words">
                      {[a.address, a.zone].filter(Boolean).join(" · ")}
                      <span className="text-muted-foreground">
                        {" "}
                        · {a.deliveryName}
                        {i === 0 ? " · la última" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section title="Debe">
              <p className="text-sm">
                {customer.dueCents > 0
                  ? `${money(customer.dueCents, store.currency)}${customer.dueOnDelivery ? " · contra entrega" : ""}`
                  : "Nada"}
              </p>
            </Section>
          </ProfileCard>

          <ProfileCard
            title="Historia"
            action={
              <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                Es la misma que otra ficha
              </Button>
            }
          >
            {customer.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Si llegó por otro canal y tiene otra ficha, únelas: lo decide una persona.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {customer.history.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-muted-foreground">
                      {dayOf(item.createdAt, store.timeZone)} ·
                    </span>
                    <span className="min-w-0 flex-1">{historyText(item)}</span>
                    {item.separates ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() =>
                          setSeparating({ id: item.separates as string, name: item.with.name })
                        }
                      >
                        Separar
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </ProfileCard>
        </div>
      </div>

      <ConfirmDialog
        open={separating !== null}
        title={`¿Separar «${separating?.name ?? ""}»?`}
        description="Vuelve a ser otra ficha, con sus pedidos y con las fichas que se le unieron antes. No se vuelve a sugerir como la misma clienta."
        confirmLabel="Separar"
        cancelLabel="Dejarla unida"
        pending={separate.isPending}
        error={separate.isError ? submitErrorMessage(separate.error) : null}
        onConfirm={() => separating && separate.mutate(separating.id)}
        onClose={() => {
          setSeparating(null)
          separate.reset()
        }}
      />
      {editing ? <EditCustomerSheet customer={customer} onClose={() => setEditing(false)} /> : null}
      {repeating ? (
        <NewOrderSheet
          draft={draft}
          onClose={() => setRepeating(false)}
          onCreated={(orderId) => {
            setRepeating(false)
            void navigate({
              to: "/tiendas/$id/pedidos",
              params: { id: store.id },
              search: { pedido: orderId },
            })
          }}
        />
      ) : null}
      {comparing ? (
        <SimilarQueue
          involving={customer.id}
          first={comparing}
          onClose={() => setComparing(null)}
        />
      ) : null}
      {picking ? <PickOtherSheet customer={customer} onClose={() => setPicking(false)} /> : null}
    </article>
  )
}

/* ------------------------------------------------------------- ¿es la misma clienta? */

function Card({ card }: { card: CompareCard }) {
  const { store } = useStoreContext()
  const where = [channelsText(card.channels) || "Anotada a mano", ...card.phones].join(" · ")
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border p-3 text-sm">
      <span className="font-semibold">{card.name}</span>
      <span className="text-muted-foreground">{where}</span>
      <span>
        {card.lastOrder
          ? `${card.lastOrder.number} · ${dayOf(card.lastOrder.createdAt, store.timeZone)} · ${card.lastOrder.text}`
          : "Sin compras"}
      </span>
      {card.purchases > 1 ? (
        <span className="text-xs text-muted-foreground">{card.purchases} compras en total</span>
      ) : null}
      {card.lastAddress ? (
        <span className="text-xs text-muted-foreground">{card.lastAddress}</span>
      ) : null}
    </div>
  )
}

/**
 * «¿Es la misma clienta?» (tablero 8): las dos fichas lado a lado, y lo decide la persona. Sí:
 * la más nueva queda dentro de la más antigua y se puede separar desde la ficha. No: queda dicho
 * y no se vuelve a preguntar. Nunca se une sola por el nombre o el teléfono.
 */
function CompareSheet({
  pair,
  remaining = 0,
  onAnswered,
  onClose,
}: {
  pair: { a: CompareCard; b: CompareCard; reason?: SimilarPair["reason"] }
  /** Cuántas parejas quedan por mirar después de esta. */
  remaining?: number
  onAnswered: (answer: "misma" | "distintas", keptId: string | null) => void
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const refresh = useRefreshCustomers()
  const body = { a: pair.a.id, b: pair.b.id }
  const same = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/tiendas/${store.id}/clientes/unir`, { method: "POST", body }),
    onSuccess: async (data) => {
      await refresh()
      toast.success("Listo: ahora es una sola ficha")
      onAnswered("misma", data.id)
    },
  })
  const distinct = useMutation({
    mutationFn: () => api(`/api/tiendas/${store.id}/clientes/distintas`, { method: "POST", body }),
    onSuccess: async () => {
      await refresh()
      toast.success("Anotado: son dos clientas")
      onAnswered("distintas", null)
    },
  })
  const pending = same.isPending || distinct.isPending
  const failed = same.error ?? distinct.error
  // Unir es una decisión: va en un cajón que pide responder antes de seguir, no al lado.
  return (
    <DetailDrawer
      open
      dock={false}
      size="lg"
      title="¿Es la misma clienta?"
      description={`${pair.reason ? `${reasonText(pair.reason)} ` : ""}${
        remaining > 0 ? `Después quedan ${remaining} por mirar.` : "Mira sus compras y decide."
      }`}
      onClose={onClose}
      isSubmitting={pending}
      error={failed ? submitErrorMessage(failed) : null}
      actions={
        <>
          <SubmitButton
            variant="outline"
            className="min-h-11"
            pending={distinct.isPending}
            disabled={pending}
            onClick={() => distinct.mutate()}
          >
            No, son distintas
          </SubmitButton>
          <SubmitButton
            className="min-h-11"
            pending={same.isPending}
            disabled={pending}
            onClick={() => same.mutate()}
          >
            Sí, es la misma
          </SubmitButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Card card={pair.a} />
          <Card card={pair.b} />
        </div>
        <p className="text-sm text-muted-foreground">
          Nunca se une sola por el nombre o el teléfono: lo dice una persona. Si es la misma, queda
          la ficha más antigua con todas sus compras; queda quién lo dijo y cuándo, y se puede
          separar desde la ficha. Es un aviso: no frena ninguna venta.
        </p>
      </div>
    </DetailDrawer>
  )
}

/**
 * Las parejas por mirar, de a una, hasta que no quede ninguna. Con `involving`, solo las de esa
 * ficha (desde su aviso). También se abre con «Comparar» desde «Te toca» de Inicio.
 */
export function SimilarQueue({
  involving,
  first,
  onClose,
}: {
  involving?: string
  /** La otra ficha del aviso que se tocó: esa pareja va primero. */
  first?: string
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const similar = useQuery({
    queryKey: [...SIMILAR_KEY(store.id), involving ?? ""],
    queryFn: () =>
      api<{ pairs: SimilarPair[] }>(
        `/api/tiendas/${store.id}/clientes/parecidas${involving ? `?de=${involving}` : ""}`,
      ),
  })
  const has = (p: SimilarPair, id?: string) => Boolean(id) && (p.a.id === id || p.b.id === id)
  const pairs = [...(similar.data?.pairs ?? [])].sort(
    (x, y) => Number(has(y, first)) - Number(has(x, first)),
  )
  const pair = pairs[0]
  // Contestadas todas, se cierra.
  const done = similar.data !== undefined && !similar.isFetching && !pair
  useEffect(() => {
    if (done) onClose()
  }, [done, onClose])
  if (similar.isError)
    return (
      <DetailDrawer open dock={false} size="lg" title="¿Es la misma clienta?" onClose={onClose}>
        <ErrorState error={similar.error} onRetry={() => void similar.refetch()} />
      </DetailDrawer>
    )
  if (!pair) return null
  return (
    <CompareSheet
      key={`${pair.a.id}|${pair.b.id}`}
      pair={pair}
      remaining={pairs.length - 1}
      onClose={onClose}
      onAnswered={(answer, keptId) => {
        // Desde la ficha: si quedó dentro de otra, se va a esa.
        if (involving && answer === "misma" && keptId && keptId !== involving)
          void navigate({
            to: "/tiendas/$id/clientes/$customerId",
            params: { id: store.id, customerId: keptId },
            search: (previous: Record<string, unknown>) => previous,
            replace: true,
          })
      }}
    />
  )
}

/**
 * «Es la misma que otra ficha»: cuando no hay sugerencia (llegó con otro nombre y sin teléfono)
 * o para volver a unir lo que se separó. Se busca la otra ficha y se compara antes de decidir.
 */
function PickOtherSheet({ customer, onClose }: { customer: CustomerDetail; onClose: () => void }) {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const inputId = useId()
  const [typed, setTyped] = useState("")
  const [debounced, setDebounced] = useState("")
  const [other, setOther] = useState<CustomerSummary | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(typed.trim()), 300)
    return () => clearTimeout(timer)
  }, [typed])
  const found = useQuery({
    queryKey: [...CUSTOMERS_KEY(store.id), debounced],
    queryFn: () =>
      api<CustomerList>(
        `/api/tiendas/${store.id}/clientes?buscar=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 2,
  })
  const results = (found.data?.customers ?? []).filter((c) => c.id !== customer.id).slice(0, 8)
  if (other)
    return (
      <CompareSheet
        pair={{ a: cardOf(customer), b: other }}
        onClose={onClose}
        onAnswered={(answer, keptId) => {
          onClose()
          if (answer === "misma" && keptId && keptId !== customer.id)
            void navigate({
              to: "/tiendas/$id/clientes/$customerId",
              params: { id: store.id, customerId: keptId },
              search: (previous: Record<string, unknown>) => previous,
              replace: true,
            })
        }}
      />
    )
  return (
    <DetailDrawer
      open
      dock={false}
      title="¿Es la misma que otra ficha?"
      description={`Busca la otra ficha de ${customer.name.split(" ")[0]}: antes de unirlas, las ves lado a lado.`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={inputId}>Su nombre o su teléfono</FieldLabel>
          <Input
            id={inputId}
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
        </Field>
        <div aria-live="polite" className="flex flex-col gap-2">
          {results.length > 0 ? (
            <ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setOther(c)}
                    className="flex w-full flex-col items-start px-3 py-2 text-left text-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset"
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {[
                        channelsText(c.channels),
                        c.phones[0],
                        purchasesText(c.purchases, c.lastPurchaseAt, store.timeZone),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : debounced.length >= 2 && found.data ? (
            <p className="text-sm text-muted-foreground">No encontramos otra ficha con eso.</p>
          ) : null}
        </div>
      </div>
    </DetailDrawer>
  )
}

/* ------------------------------------------------------------------------ editar */

function EditCustomerSheet({
  customer,
  onClose,
}: {
  customer: CustomerDetail
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const refresh = useRefreshCustomers()
  const save = useMutation({
    mutationFn: (body: { name: string; phone: string; note: string }) =>
      api(`/api/tiendas/${store.id}/clientes/${customer.id}`, { method: "PATCH", body }),
  })
  const form = useAppForm({
    defaultValues: { name: customer.name, phone: customer.phone ?? "", note: customer.note },
    validators: {
      // El largo y el teléfono los revisa el servidor; aquí, que no quede sin nombre.
      onSubmit: z.object({
        name: z.string().trim().min(1, "Escribe su nombre"),
        phone: z.string(),
        note: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      await refresh()
      toast.success("Ficha guardada")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Editar la ficha"
      description="Corregir su nombre o su teléfono no cambia los pedidos ya anotados."
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="name">
          {(field) => <field.TextField label="Nombre" maxLength={120} />}
        </form.AppField>
        <form.AppField name="phone">
          {(field) => (
            <field.TextField
              label="Teléfono (opcional)"
              maxLength={30}
              inputMode="tel"
              placeholder="+51 987 654 321"
              description={
                customer.country
                  ? undefined
                  : "Con el código del país, «Escribirle» abre su WhatsApp."
              }
            />
          )}
        </form.AppField>
        <form.AppField name="note">
          {(field) => (
            <field.TextareaField
              label="Lo que sabemos"
              rows={4}
              maxLength={1000}
              placeholder="Talla 38. Prefiere Shalom y paga el envío en destino."
              description="Es del equipo: la clienta no lo ve."
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}
