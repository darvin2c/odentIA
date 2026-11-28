import { Badge, Button, cn, Field, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageNotice,
  PersonAvatar,
  SearchInput,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { ArrowLeft, MessageCircle, Plus, Repeat, UserRound } from "lucide-react"
import { type ReactNode, useEffect, useId, useState } from "react"
import { z } from "zod"
import { api } from "./lib/api"
import {
  CUSTOMER_KEY,
  CUSTOMERS_KEY,
  type CustomerDetail,
  type CustomerList,
  type CustomerSummary,
  channelsText,
  dayOf,
  historyText,
  owedText,
  purchasesText,
  reasonText,
  type SimilarPair,
  sinceText,
  whatsappLink,
} from "./lib/clientes"
import { HOME_KEY } from "./lib/inicio"
import { STATE_TONE, stateName } from "./lib/pedidos"
import { money } from "./lib/tienda"
import { NewOrderSheet, type OrderDraft } from "./pedidos"
import { ArgosKnows, WhenToWrite } from "./perfil"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Clientes (entrega 4 de «gestorIA como odentIA», tablero 8): cada clienta con todos sus canales
 * y sus compras, como la ficha de la persona en odentIA, sin nada clínico. Cada pedido que se anota
 * o que arma Sofi se suma a su ficha. Que dos fichas sean la misma lo dice una persona: el mismo
 * teléfono o el mismo nombre solo lo sugieren («¿Es la misma clienta?»), y se puede separar.
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

/* ------------------------------------------------------------------------- la lista */

/**
 * La lista y, al lado, la ficha abierta. En el celular, una o la otra: la ficha trae su
 * «Clientes» para volver.
 */
export function CustomersLayout() {
  const { store } = useStoreContext()
  const { customerId } = useParams({ strict: false }) as { customerId?: string }
  const { q = "" } = useSearch({ strict: false }) as { q?: string }
  const query = q.trim()
  const list = useQuery({
    queryKey: [...CUSTOMERS_KEY(store.id), query],
    queryFn: () =>
      api<CustomerList>(
        `/api/tiendas/${store.id}/clientes${query ? `?buscar=${encodeURIComponent(query)}` : ""}`,
      ),
    placeholderData: (previous) => previous,
  })
  const [comparing, setComparing] = useState(false)
  const customers = list.data?.customers ?? []
  const similar = list.data?.similar ?? 0

  return (
    <>
      <StoreHeader
        title="Clientes"
        subtitle="Cada clienta con sus compras, llegue por donde llegue."
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
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        <section
          aria-label="Clientas"
          className={cn("flex min-w-0 flex-col gap-3", customerId ? "hidden lg:flex" : "")}
        >
          <SearchInput
            label="Buscar en clientes"
            placeholder="Buscar por nombre o teléfono"
            isFetching={list.isFetching && !list.isPending}
          />
          {list.isPending ? <LoadingState message="Cargando clientes…" /> : null}
          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : null}
          {list.data && customers.length === 0 ? (
            query ? (
              <EmptyState
                icon={UserRound}
                title={`Nadie coincide con «${query}»`}
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
            <ul className="elevated flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
              {customers.map((c) => (
                <li key={c.id}>
                  <Link
                    to="/tiendas/$id/clientes/$customerId"
                    params={{ id: store.id, customerId: c.id }}
                    search={(previous: Record<string, unknown>) => previous}
                    aria-current={c.id === customerId ? "page" : undefined}
                    className={cn(
                      "flex flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset",
                      c.id === customerId &&
                        "bg-surface-muted shadow-[inset_3px_0_0_var(--primary)]",
                    )}
                  >
                    <span className="truncate font-semibold">{c.name}</span>
                    {c.channels.length > 0 || c.lastZone ? (
                      <span className="truncate text-sm text-muted-foreground">
                        {[channelsText(c.channels), c.lastZone].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {owedText(c, store.currency) ??
                        purchasesText(c.purchases, c.lastPurchaseAt, store.timeZone)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {list.data?.limited ? (
            <p className="text-xs text-muted-foreground">
              Se ven las {customers.length} con compras más recientes. Busca para encontrar a las
              demás.
            </p>
          ) : null}
        </section>
        <div className={cn("min-w-0", customerId ? "" : "hidden lg:block")}>
          <Outlet />
        </div>
      </div>
      {comparing ? <SimilarQueue onClose={() => setComparing(false)} /> : null}
    </>
  )
}

/** Sin una clienta elegida, en el escritorio: qué hacer. */
export function CustomersIndex() {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      Elige una clienta para ver su ficha.
    </div>
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
    <div className="flex flex-col gap-4">
      <Link
        to="/tiendas/$id/clientes"
        params={{ id: store.id }}
        search={(previous: Record<string, unknown>) => previous}
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground underline-offset-4 hover:underline lg:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Clientes
      </Link>
      {detail.isPending ? <LoadingState message="Abriendo su ficha…" /> : null}
      {detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}
      {detail.data ? <CustomerCard customer={detail.data} /> : null}
    </div>
  )
}

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

  return (
    <article
      aria-label={`Ficha de ${customer.name}`}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-6"
    >
      <header className="flex flex-wrap items-center gap-4">
        <PersonAvatar
          name={customer.name}
          className="size-12"
          fallbackClassName="text-base"
          decorative
        />
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <h2 className="truncate text-xl font-semibold">{customer.name}</h2>
          <p className="text-sm text-muted-foreground">{contact}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {write ? (
            <Button
              variant="outline"
              render={<a href={write} target="_blank" rel="noopener noreferrer" />}
            >
              <MessageCircle aria-hidden />
              Escribirle
            </Button>
          ) : null}
          <Button onClick={() => setRepeating(true)}>
            {customer.repeat ? <Repeat aria-hidden /> : <Plus aria-hidden />}
            {customer.repeat ? "Repetir pedido" : "Anotar un pedido"}
          </Button>
        </div>
      </header>

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

      {/* En ancho, la ficha a la izquierda y «Cuándo se le puede escribir» a la derecha; en el
          teléfono, una columna: lo que Argos sabe, cuándo escribirle y lo demás. */}
      <div className="@container">
        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:items-start">
          {customer.profile ? <ArgosKnows customer={customer} profile={customer.profile} /> : null}
          {customer.profile ? (
            <div className="min-w-0 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1">
              <WhenToWrite profile={customer.profile} />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-4 @3xl:col-start-1">
            <div className="flex flex-col gap-1 rounded-lg border bg-surface-muted px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Lo que sabemos
                </h3>
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Editar
                </Button>
              </div>
              {customer.note ? (
                <>
                  <p className="whitespace-pre-line text-sm">{customer.note}</p>
                  <p className="text-xs text-muted-foreground">
                    Nota del equipo, la clienta no la ve
                    {customer.noteByName && customer.noteAt
                      ? ` · escribió ${customer.noteByName.split(" ")[0]} ${dayOf(customer.noteAt, store.timeZone)}`
                      : ""}
                  </p>
                </>
              ) : joinedNotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Su talla, cómo prefiere recibir, lo que conviene recordar. Es del equipo: la
                  clienta no lo ve.
                </p>
              ) : null}
              {/* Lo que se anotó en una ficha que se le unió: unir no lo mueve ni lo borra. */}
              {joinedNotes.map((m) => (
                <div key={m.id} className="flex flex-col gap-0.5 border-t pt-2 first:border-t-0">
                  <p className="whitespace-pre-line text-sm">{m.note}</p>
                  <p className="text-xs text-muted-foreground">
                    De la ficha que se le unió
                    {m.channels.length > 0 ? `, por ${channelsText(m.channels)}` : ""}
                  </p>
                </div>
              ))}
            </div>

            <Section
              title={customer.purchases === 1 ? "1 compra" : `${customer.purchases} compras`}
            >
              {customer.orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todavía no compró.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {customer.orders.map((o) => (
                    <li key={o.id}>
                      <Link
                        to="/tiendas/$id/pedidos"
                        params={{ id: store.id }}
                        search={{ pedido: o.id }}
                        className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 text-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset sm:grid-cols-[3rem_minmax(0,1fr)_5.5rem_auto]"
                      >
                        <span className="font-mono tabular-nums">{o.number}</span>
                        <span className="min-w-0">
                          {dayOf(o.createdAt, store.timeZone)} · {o.text}
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
              )}
            </Section>

            {customer.addresses.length > 0 ? (
              <Section title="Direcciones">
                <ul className="flex flex-col gap-1 text-sm">
                  {customer.addresses.map((a, i) => (
                    <li key={`${a.deliveryName}-${a.zone}-${a.address}`}>
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

            <Section
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
            </Section>
          </div>
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
