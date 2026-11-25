import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  toast,
} from "@odentia/ui"
import {
  AppShell,
  type AppShellNavItem,
  Brand,
  type CountryCode,
  CountrySelect,
  EmptyState,
  ErrorState,
  HeaderUtilitiesProvider,
  LoadingState,
  NoticeStrip,
  PageHeader,
  type PageHeaderProps,
  PageShell,
  PersonAvatar,
  type Place,
  PlaceSwitcher,
  regionCountry,
  SubmitButton,
  useHeaderCompact,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router"
import {
  Bot,
  ChartColumn,
  Copy,
  CreditCard,
  LifeBuoy,
  MailOpen,
  MessageCircle,
  Package,
  Plus,
  ReceiptText,
  Store,
  Truck,
  UserPlus,
  Users,
} from "lucide-react"
import {
  createContext,
  type FormEvent,
  type MouseEventHandler,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  ApiError,
  api,
  invitationLink,
  type Me,
  type MyStore,
  type PendingInvitation,
  ROLES,
  type StoreRole,
  type SupportAccess,
  type TeamMember,
} from "./lib/api"
import { authClient, forgetToken, forgetUser } from "./lib/cuenta"
import { when } from "./lib/pedidos"

/** Lo que la persona ve al entrar: sus tiendas y sus invitaciones. */
export function useMe() {
  return useQuery({ queryKey: ["yo"], queryFn: () => api<Me>("/api/yo") })
}

/** Cierra la sesión de la cuenta en este navegador. La entrada sigue recordando quién era. */
async function signOut() {
  forgetToken()
  await authClient.signOut().catch(() => undefined)
  window.location.assign("/login")
}

/**
 * El enlace del router con lo que le pasan el armazón y el selector (`aria-current`, `title`,
 * `onClick`). `exact`: el armazón decide cuál es el destino activo, no cada prefijo de la ruta.
 */
function RouterLink({
  to,
  search,
  children,
  ...rest
}: {
  to: string
  search?: Record<string, string>
  className?: string
  children: ReactNode
  title?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}) {
  return (
    <Link to={to} search={search} activeOptions={{ exact: true }} {...rest}>
      {children}
    </Link>
  )
}

/** Mientras se sabe quién es y qué tiendas tiene: el aviso a la vista, sin el armazón. */
function Opening({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <LoadingState kind="indeterminate" message={message} className="w-full max-w-sm" />
    </div>
  )
}

/** Lo que no se pudo abrir antes de saber quién es: el error y «Reintentar», sin el armazón. */
function OpeningFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-md">
        <ErrorBlock error={error} onRetry={onRetry} />
      </div>
    </div>
  )
}

/**
 * «Pedir ayuda» en la cabecera (lienzo «Una cuenta, todas las apps», decisión 6): lleva a la
 * ayuda del soporte de gestorIA, en «Plan y pagos», mientras gestorIA no tenga su propia Ayuda.
 * Es del Dueño, como el plan (el servidor lo exige igual).
 */
function AskForHelp({ store }: { store: MyStore }) {
  const compact = useHeaderCompact()
  return (
    <Button
      variant="outline"
      className="elevated h-9 gap-2 rounded-full px-3"
      render={<Link to="/tiendas/$id/plan" params={{ id: store.id }} hash="plan-ayuda" />}
    >
      <LifeBuoy className="size-4" aria-hidden />
      <span className={compact ? "sr-only" : "max-md:sr-only"}>Pedir ayuda</span>
    </Button>
  )
}

/** La franja de soporte de gestorIA mirando la tienda: no se cierra y dice hasta cuándo. */
function SupportStrip({ until }: { until: string }) {
  const end = when(until).replace(/\.$/, "")
  return (
    <NoticeStrip
      label="Soporte de gestorIA"
      notices={[
        {
          id: "soporte-mirando",
          tone: "alarma",
          message: `Entraste como soporte de gestorIA, solo a mirar, hasta el ${end}. No puedes cambiar nada.`,
          short: `Solo mirar · hasta el ${end}`,
        },
      ]}
    />
  )
}

/**
 * El selector de tiendas, el mismo de las clínicas (`PlaceSwitcher`): la tienda y el rol de
 * quien está («Tienda · Dueño»), «Plan y pagos» si es del Dueño, sus otras tiendas y, al final,
 * sus invitaciones y crear otra.
 */
function StoreSwitcher({ me, store }: { me: Me; store: MyStore }) {
  const navigate = useNavigate()
  // Bajo el nombre cabe una palabra: «Soporte», no «Soporte de gestorIA» (lo dice la franja).
  const roleOf = (item: MyStore) => (item.role === "support" ? "Soporte" : ROLES[item.role].name)
  const places: Place[] = me.stores.map((item) => ({
    id: item.id,
    name: item.name,
    brand: "gestoria",
    role: roleOf(item),
    href: `/tiendas/${item.id}`,
  }))
  const invitations = me.invitations.length
  return (
    <PlaceSwitcher
      current={{ id: store.id, name: store.name, brand: "gestoria", role: roleOf(store) }}
      places={places}
      actions={
        store.permissions.includes("plan")
          ? [
              {
                label: "Plan y pagos",
                icon: <CreditCard aria-hidden />,
                onSelect: () =>
                  void navigate({ to: "/tiendas/$id/plan", params: { id: store.id } }),
              },
            ]
          : []
      }
      footerActions={[
        ...(invitations > 0
          ? [
              {
                label:
                  invitations === 1 ? "Ver tu invitación" : `Ver tus ${invitations} invitaciones`,
                icon: <MailOpen aria-hidden />,
                onSelect: () => void navigate({ to: "/" }),
              },
            ]
          : []),
        {
          label: "Crear otra tienda",
          icon: <Plus aria-hidden />,
          onSelect: () => void navigate({ to: "/tiendas/nueva" }),
        },
      ]}
      menuLabel="Menú de la tienda"
    />
  )
}

/**
 * El armazón de gestorIA, el mismo de las clínicas (`AppShell`; lienzo «Una cuenta, todas las
 * apps», tableros 6 y 7): la barra lateral con la marca, el selector de tiendas y las secciones
 * de la tienda; abajo, la persona con su nombre y su correo, Apariencia y «Cerrar sesión». Fuera
 * de una tienda (elegirla, crearla, una invitación), solo «Tus tiendas».
 */
export function Shell({ me, store, children }: { me: Me; store?: MyStore; children: ReactNode }) {
  const { pathname } = useLocation()
  const items: AppShellNavItem[] = store
    ? storeSections(store)
    : [{ label: "Tus tiendas", to: "/", icon: Store }]
  return (
    <AppShell
      notice={store?.supportUntil ? <SupportStrip until={store.supportUntil} /> : undefined}
      items={items}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{ name: me.person.name, email: me.person.email }}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={store ? <StoreSwitcher me={me} store={store} /> : undefined}
      onSignOut={() => void signOut()}
    >
      <HeaderUtilitiesProvider
        value={{
          utilities: store?.permissions.includes("plan") ? <AskForHelp store={store} /> : undefined,
        }}
      >
        <PageShell className="flex flex-col gap-6">{children}</PageShell>
      </HeaderUtilitiesProvider>
    </AppShell>
  )
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <ErrorState error={error instanceof Error ? error : "No se pudo cargar"} onRetry={onRetry} />
  )
}

/**
 * «Tus tiendas» (decisión 8: una persona puede tener o atender varias y elige al entrar). Con
 * una sola tienda y nada pendiente, entra directo a ella.
 */
export function StoresPage() {
  const me = useMe()
  const navigate = useNavigate()
  const only =
    me.data && me.data.stores.length === 1 && me.data.invitations.length === 0
      ? me.data.stores[0]
      : null
  useEffect(() => {
    if (only) void navigate({ to: "/tiendas/$id", params: { id: only.id }, replace: true })
  }, [only, navigate])

  if (me.isPending || only)
    return <Opening message={only ? "Abriendo tu tienda…" : "Cargando tus tiendas…"} />
  if (me.isError) return <OpeningFailed error={me.error} onRetry={() => void me.refetch()} />
  const { stores, invitations, person } = me.data
  const nothing = stores.length === 0 && invitations.length === 0

  return (
    <Shell me={me.data}>
      <PageHeader
        title={`Hola, ${person.name.split(" ")[0]}`}
        subtitle={
          nothing ? "Crea tu tienda para empezar a vender." : "Elige con qué tienda vas a trabajar."
        }
      />

      {invitations.length > 0 ? (
        <section aria-labelledby="invitaciones" className="flex flex-col gap-3">
          <h2 id="invitaciones" className="text-sm font-semibold">
            Te invitaron
          </h2>
          {invitations.map((invitation) => (
            <InvitationCard key={invitation.id} invitation={invitation} />
          ))}
        </section>
      ) : null}

      {stores.length > 0 ? (
        <section aria-labelledby="tiendas" className="flex flex-col gap-3">
          <h2 id="tiendas" className="text-sm font-semibold">
            Tus tiendas
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {stores.map((store) => (
              <li key={store.id}>
                <Link
                  to="/tiendas/$id"
                  params={{ id: store.id }}
                  className="flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
                    <Store className="size-5" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{store.name}</span>
                    <span className="text-sm text-muted-foreground">{ROLES[store.role].name}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {nothing ? (
        <EmptyState
          icon={Store}
          title="Todavía no tienes una tienda"
          description="Si alguien de tu equipo ya la creó, pídele que te invite con este mismo correo."
        >
          <Button render={<Link to="/tiendas/nueva" />}>
            <Plus aria-hidden />
            Crear mi tienda
          </Button>
        </EmptyState>
      ) : (
        <div>
          <Button variant="outline" render={<Link to="/tiendas/nueva" />}>
            <Plus aria-hidden />
            {stores.length > 0 ? "Crear otra tienda" : "Crear mi tienda"}
          </Button>
        </div>
      )}
    </Shell>
  )
}

function InvitationCard({ invitation }: { invitation: Me["invitations"][number] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const accept = useMutation({
    mutationFn: () =>
      api<{ storeId: string }>(`/api/invitaciones/${invitation.id}/aceptar`, { method: "POST" }),
    onSuccess: async ({ storeId }) => {
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      toast.success(`Ya eres parte de ${invitation.storeName}`)
      await navigate({ to: "/tiendas/$id", params: { id: storeId } })
    },
  })
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">{invitation.storeName}</span>
        <span className="text-sm text-muted-foreground">
          {invitation.invitedBy ? `${invitation.invitedBy} te invitó` : "Te invitaron"} como{" "}
          {ROLES[invitation.role].name}. {ROLES[invitation.role].can}
        </span>
        {accept.isError ? (
          <span role="alert" className="mt-1 text-sm text-danger">
            {accept.error.message}
          </span>
        ) : null}
      </div>
      <SubmitButton
        pending={accept.isPending}
        onClick={() => accept.mutate()}
        className="sm:shrink-0"
      >
        Aceptar
      </SubmitButton>
    </div>
  )
}

/** Las monedas de ISO 4217 con su nombre en español; las de la región primero. */
function useCurrencies() {
  return useMemo(() => {
    const names = new Intl.DisplayNames(["es"], { type: "currency" })
    const first = ["PEN", "USD", "BOB", "COP", "CLP", "MXN", "ARS", "EUR"]
    const all = Intl.supportedValuesOf("currency")
    const label = (code: string) => `${names.of(code) ?? code} (${code})`
    return [
      ...first.filter((code) => all.includes(code)).map((code) => ({ code, label: label(code) })),
      ...all.filter((code) => !first.includes(code)).map((code) => ({ code, label: label(code) })),
    ]
  }, [])
}

/** Crear la tienda: el nombre y la moneda en que vende (decisión 9: una sola). */
export function NewStorePage() {
  const me = useMe()
  if (me.isPending) return <Opening message="Cargando…" />
  if (me.isError) return <OpeningFailed error={me.error} onRetry={() => void me.refetch()} />
  return (
    <Shell me={me.data}>
      <NewStoreForm />
    </Shell>
  )
}

function NewStoreForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currencies = useCurrencies()
  const [name, setName] = useState("")
  const [currency, setCurrency] = useState("PEN")
  // El de la región del navegador, como en el teléfono: se cambia buscando en la lista.
  const [country, setCountry] = useState<CountryCode>(regionCountry)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useMutation({
    mutationFn: () =>
      api<{ store: MyStore }>("/api/tiendas", {
        method: "POST",
        body: { name, currency, country },
      }),
    onSuccess: async ({ store }) => {
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      await navigate({ to: "/tiendas/$id", params: { id: store.id } })
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) setErrors(error.fields)
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setErrors({ name: "Escribe el nombre de tu tienda" })
      return
    }
    setErrors({})
    create.mutate()
  }

  return (
    <>
      <PageHeader
        title="Crea tu tienda"
        subtitle="Quedas como su dueño. Después invitas a tu equipo."
      />
      <form noValidate onSubmit={onSubmit} className="max-w-md rounded-xl border bg-card p-5">
        <FieldGroup className="gap-5">
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="store-name">Nombre de la tienda</FieldLabel>
            <Input
              id="store-name"
              autoFocus
              maxLength={80}
              placeholder="Por ejemplo, Calzados Rosa"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "store-name-error" : "store-name-help"}
            />
            {errors.name ? (
              <FieldError id="store-name-error">{errors.name}</FieldError>
            ) : (
              <FieldDescription id="store-name-help">Como lo ven tus clientes.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={errors.currency ? true : undefined}>
            <FieldLabel htmlFor="currency">Moneda en que vendes</FieldLabel>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-9 w-full rounded-md border border-input-border bg-input/30 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              aria-describedby="currency-help"
            >
              {currencies.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.currency ? (
              <FieldError>{errors.currency}</FieldError>
            ) : (
              <FieldDescription id="currency-help">
                Todos tus precios y pedidos van en esta moneda.
              </FieldDescription>
            )}
          </Field>
          <Field data-invalid={errors.country ? true : undefined}>
            <FieldLabel htmlFor="country">País de tu tienda</FieldLabel>
            <CountrySelect
              id="country"
              value={country}
              onChange={setCountry}
              invalid={Boolean(errors.country)}
              aria-describedby="country-help"
            />
            {errors.country ? (
              <FieldError>{errors.country}</FieldError>
            ) : (
              <FieldDescription id="country-help">
                Con él te cobramos el plan con el impuesto que corresponde.
              </FieldDescription>
            )}
          </Field>
          {create.isError &&
          !(create.error instanceof ApiError && Object.keys(create.error.fields).length > 0) ? (
            <p role="alert" className="text-sm text-danger">
              {create.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="submit" pending={create.isPending}>
              Crear la tienda
            </SubmitButton>
            <Button variant="ghost" render={<Link to="/" />}>
              Cancelar
            </Button>
          </div>
        </FieldGroup>
      </form>
    </>
  )
}

/** La tienda en la que se trabaja, para cada pantalla de dentro. */
const StoreContext = createContext<{ store: MyStore; meId: string } | null>(null)

export function useStoreContext() {
  const value = useContext(StoreContext)
  if (!value) throw new Error("useStoreContext fuera de la tienda")
  return value
}

/** Cada destino de la tienda: sus pedidos, lo que vende, cómo cobra y entrega, y su equipo. */
function storeSections(store: MyStore) {
  const id = store.id
  // Soporte de gestorIA solo mira: sin pedidos ni conversaciones (`ventas.atender`).
  const attends = store.permissions.includes("ventas.atender")
  return [
    ...(attends
      ? [
          { label: "Pedidos", to: `/tiendas/${id}/pedidos`, icon: ReceiptText },
          { label: "Sofi", to: `/tiendas/${id}/sofi`, icon: Bot },
        ]
      : []),
    { label: "Catálogo", to: `/tiendas/${id}/catalogo`, icon: Package },
    { label: "Pagos y entregas", to: `/tiendas/${id}/pagos-y-entregas`, icon: Truck },
    // Reportes y Argos: solo Dueño y Administrador.
    ...(store.permissions.includes("reportes.ver")
      ? [{ label: "Reportes", to: `/tiendas/${id}/reportes`, icon: ChartColumn }]
      : []),
    { label: "Equipo", to: `/tiendas/${id}/equipo`, icon: Users },
    // «Plan y pagos» (solo el Dueño) va en el selector de la tienda, como en las clínicas.
  ]
}

/**
 * La tienda en el armazón: sus secciones en la barra lateral y su nombre y el rol de quien está
 * en el selector (lienzo B, tableros 6 y 7; «Una cuenta, todas las apps», tablero 6). Lo que
 * llega después (WhatsApp) se suma como otra sección.
 */
export function StoreLayout() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { pathname } = useLocation()
  const me = useMe()
  const store = me.data?.stores.find((s) => s.id === id)

  if (me.isPending) return <Opening message="Abriendo tu tienda…" />
  if (me.isError) return <OpeningFailed error={me.error} onRetry={() => void me.refetch()} />
  if (!store)
    return (
      <Shell me={me.data}>
        <PageHeader title="Tienda no encontrada" />
        <ErrorState
          title="No encontramos esa tienda en tu cuenta"
          message="Puede que te hayan quitado del equipo."
        />
        <Button variant="outline" render={<Link to="/" />} className="self-start">
          Ver tus tiendas
        </Button>
      </Shell>
    )
  // Quien solo mira (soporte) entra por el catálogo: los pedidos no son suyos.
  if (!store.permissions.includes("ventas.atender") && pathname.endsWith("/pedidos"))
    return <Navigate to="/tiendas/$id/catalogo" params={{ id }} replace />
  return (
    <StoreContext.Provider value={{ store, meId: me.data.person.userId }}>
      <Shell me={me.data} store={store}>
        <Outlet />
      </Shell>
    </StoreContext.Provider>
  )
}

/**
 * El encabezado de cada sección de la tienda (`PageHeader`) y, debajo, lo que soporte de
 * gestorIA pide o tiene abierto, para que el Dueño o un Administrador lo vea donde esté. En
 * Equipo ya se ve entero.
 */
export function StoreHeader(props: PageHeaderProps) {
  const { store } = useStoreContext()
  const { pathname } = useLocation()
  return (
    <>
      <PageHeader {...props} />
      {store.permissions.includes("equipo.gestionar") && !pathname.endsWith("/equipo") ? (
        <SupportAccessPanel store={store} only="actual" />
      ) : null}
    </>
  )
}

/** El equipo de la tienda (B1). */
export function TeamPage() {
  const { store, meId } = useStoreContext()
  return <Team store={store} meId={meId} />
}

function Team({ store, meId }: { store: MyStore; meId: string }) {
  const canManage = store.permissions.includes("equipo.gestionar")
  const team = useQuery({
    queryKey: ["equipo", store.id],
    queryFn: () => api<Team>(`/api/tiendas/${store.id}/equipo`),
  })
  const [inviting, setInviting] = useState(false)

  return (
    <>
      <StoreHeader
        title="Equipo"
        subtitle="Quién atiende tu tienda y qué puede hacer."
        primary={
          canManage
            ? { label: "Invitar", icon: <UserPlus aria-hidden />, onClick: () => setInviting(true) }
            : undefined
        }
      />
      <section aria-label="Tu equipo" className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        {team.isPending ? (
          <p className="text-sm text-muted-foreground">Cargando tu equipo…</p>
        ) : null}
        {team.isError ? (
          <ErrorBlock error={team.error} onRetry={() => void team.refetch()} />
        ) : null}
        {team.data ? (
          <>
            <ul className="flex flex-col divide-y">
              {team.data.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  store={store}
                  member={member}
                  isMe={member.userId === meId}
                  canManage={canManage}
                />
              ))}
            </ul>
            {team.data.invitations.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Invitaciones pendientes</h3>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {team.data.invitations.map((invitation) => (
                    <PendingRow
                      key={invitation.id}
                      store={store}
                      invitation={invitation}
                      canManage={canManage}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
        {team.data && team.data.support.length > 0 ? (
          <SupportAccessPanel store={store} only="todo" />
        ) : null}
      </section>
      {inviting ? <InviteDialog store={store} onClose={() => setInviting(false)} /> : null}
    </>
  )
}

interface Team {
  members: TeamMember[]
  invitations: PendingInvitation[]
  support: SupportAccess[]
}

const SUPPORT_STATUS: Record<SupportAccess["status"], string> = {
  por_aceptar: "Pide entrar",
  vigente: "Puede mirar",
  terminado: "Terminó",
  rechazado: "No lo dejaste",
}

/**
 * Soporte de gestorIA (ADR 0214): lo que pide la administración para mirar la tienda y lo que
 * pasó. Dejarlo entrar, no hacerlo o sacarlo es del Dueño o un Administrador. En cada sección de
 * la tienda se ve lo que está pendiente o vigente («actual»); en Equipo, también lo último.
 */
function SupportAccessPanel({ store, only }: { store: MyStore; only: "actual" | "todo" }) {
  const queryClient = useQueryClient()
  const canManage = store.permissions.includes("equipo.gestionar")
  const team = useQuery({
    queryKey: ["equipo", store.id],
    queryFn: () => api<Team>(`/api/tiendas/${store.id}/equipo`),
    enabled: store.permissions.includes("equipo.ver"),
  })
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "aceptar" | "rechazar" | "quitar" }) =>
      api(`/api/tiendas/${store.id}/soporte/${id}/${action}`, { method: "POST" }),
    onSuccess: async (_, { action }) => {
      await queryClient.invalidateQueries({ queryKey: ["equipo", store.id] })
      toast.success(
        action === "aceptar"
          ? "Listo: soporte ya puede mirar tu tienda."
          : action === "quitar"
            ? "Soporte ya no puede mirar tu tienda."
            : "Listo: soporte no entra.",
      )
    },
    onError: (error) => toast.error(error.message),
  })
  const rows = (team.data?.support ?? []).filter(
    (row) => only === "todo" || row.status === "por_aceptar" || row.status === "vigente",
  )
  if (rows.length === 0) return null
  return (
    <section
      aria-labelledby={`soporte-${only}`}
      className={only === "todo" ? "flex flex-col gap-2" : "rounded-xl border bg-card p-4"}
    >
      <h3 id={`soporte-${only}`} className="text-sm font-semibold">
        Soporte de gestorIA
      </h3>
      <ul className="flex flex-col divide-y">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
            <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
              <span className="font-medium">
                {row.status === "por_aceptar"
                  ? `${row.staffName} pide mirar tu tienda ${row.minutes} minutos`
                  : row.status === "vigente" && row.expiresAt
                    ? `${row.staffName} puede mirar tu tienda hasta el ${when(row.expiresAt)}`
                    : row.staffName}
              </span>
              <span className="text-muted-foreground">
                Para: {row.reason}. Solo mira la tienda, su equipo y su catálogo; no ve tus pedidos
                ni tus conversaciones, y no cambia nada.
              </span>
            </div>
            {only === "todo" ? <Badge variant="outline">{SUPPORT_STATUS[row.status]}</Badge> : null}
            {canManage && row.status === "por_aceptar" ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: row.id, action: "aceptar" })}
                >
                  Dejar entrar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: row.id, action: "rechazar" })}
                >
                  No
                </Button>
              </div>
            ) : null}
            {canManage && row.status === "vigente" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() => act.mutate({ id: row.id, action: "quitar" })}
              >
                Sacar ahora
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Los roles que quien está puede dar: solo un Dueño da el rol de Dueño. */
function assignable(store: MyStore): StoreRole[] {
  return store.role === "owner" ? ["sales", "admin", "owner"] : ["sales", "admin"]
}

function MemberRow({
  store,
  member,
  isMe,
  canManage,
}: {
  store: MyStore
  member: TeamMember
  isMe: boolean
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  const touchable = canManage && (member.role !== "owner" || store.role === "owner")
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["equipo", store.id] }),
      queryClient.invalidateQueries({ queryKey: ["yo"] }),
    ])
  const change = useMutation({
    mutationFn: (role: StoreRole) =>
      api(`/api/tiendas/${store.id}/equipo/${encodeURIComponent(member.userId)}`, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess: async () => {
      await refresh()
      toast.success(`Rol de ${member.name} cambiado`)
    },
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/equipo/${encodeURIComponent(member.userId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setRemoving(false)
      await refresh()
      toast.success(`${member.name} ya no es parte del equipo`)
    },
  })
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PersonAvatar name={member.name} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {member.name}
            {isMe ? <span className="text-muted-foreground"> (tú)</span> : null}
          </span>
          <span className="truncate text-sm text-muted-foreground">{member.email}</span>
        </div>
      </div>
      {touchable ? (
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`rol-${member.userId}`}>
            Rol de {member.name}
          </label>
          <select
            id={`rol-${member.userId}`}
            value={member.role}
            disabled={change.isPending}
            onChange={(e) => change.mutate(e.target.value as StoreRole)}
            className="h-8 rounded-md border border-input-border bg-input/30 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {assignable(store).map((role) => (
              <option key={role} value={role}>
                {ROLES[role].name}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
            Quitar
          </Button>
        </div>
      ) : (
        <Badge variant="outline">{ROLES[member.role].name}</Badge>
      )}
      <Dialog open={removing} onOpenChange={(open) => (open ? null : setRemoving(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Quitar a {member.name} del equipo?</DialogTitle>
            <DialogDescription>
              {isMe
                ? "Dejarás de ver esta tienda. Para volver, alguien del equipo tendrá que invitarte."
                : "Deja de ver esta tienda. Su cuenta sigue igual y puedes invitarla otra vez."}
            </DialogDescription>
          </DialogHeader>
          {remove.isError ? (
            <p role="alert" className="text-sm text-danger">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancelar
            </Button>
            <SubmitButton
              variant="destructive"
              pending={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Quitar del equipo
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

function ShareLink({ link, email, storeName }: { link: string; email: string; storeName: string }) {
  const text = `Te invito a ${storeName} en gestorIA. Entra con tu correo ${email}: ${link}`
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link)
            toast.success("Enlace copiado")
          } catch {
            toast.error("No se pudo copiar. Selecciona el enlace y cópialo.")
          }
        }}
      >
        <Copy aria-hidden />
        Copiar enlace
      </Button>
      <Button
        variant="outline"
        size="sm"
        render={
          <a
            href={`https://wa.me/?text=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noreferrer"
          />
        }
      >
        <MessageCircle aria-hidden />
        Enviar por WhatsApp
      </Button>
    </div>
  )
}

function PendingRow({
  store,
  invitation,
  canManage,
}: {
  store: MyStore
  invitation: PendingInvitation
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/invitaciones/${invitation.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["equipo", store.id] })
      toast.success("Invitación anulada")
    },
    onError: (error) => toast.error(error.message),
  })
  const resend = useMutation({
    mutationFn: () =>
      api<{ invitation: { id: string } }>(`/api/tiendas/${store.id}/invitaciones`, {
        method: "POST",
        body: { email: invitation.email, role: invitation.role },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["equipo", store.id] })
      toast.success("Invitación renovada por 7 días")
    },
    onError: (error) => toast.error(error.message),
  })
  const touchable = canManage && (invitation.role !== "owner" || store.role === "owner")
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{invitation.email}</span>
        <span className="text-xs text-muted-foreground">
          {ROLES[invitation.role].name} ·{" "}
          {invitation.expired
            ? "Venció"
            : `Vence el ${new Date(invitation.expiresAt).toLocaleDateString("es", { day: "numeric", month: "long" })}`}
        </span>
      </div>
      {touchable ? (
        <div className="flex flex-wrap items-center gap-2">
          {invitation.expired ? (
            <SubmitButton
              size="sm"
              variant="outline"
              pending={resend.isPending}
              onClick={() => resend.mutate()}
            >
              Invitar otra vez
            </SubmitButton>
          ) : (
            <ShareLink
              link={invitationLink(invitation.id)}
              email={invitation.email}
              storeName={store.name}
            />
          )}
          <SubmitButton
            size="sm"
            variant="ghost"
            pending={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            Anular
          </SubmitButton>
        </div>
      ) : null}
    </li>
  )
}

function InviteDialog({ store, onClose }: { store: MyStore; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<StoreRole>("sales")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const invite = useMutation({
    mutationFn: () =>
      api<{ invitation: { id: string; email: string } }>(`/api/tiendas/${store.id}/invitaciones`, {
        method: "POST",
        body: { email, role },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["equipo", store.id] })
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) setErrors(error.fields)
    },
  })
  const done = invite.data?.invitation

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setErrors({ email: "Escribe un correo válido, como nombre@tienda.com" })
      return
    }
    setErrors({})
    invite.mutate()
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Comparte la invitación</DialogTitle>
              <DialogDescription>
                Envía este enlace a <strong className="text-foreground">{done.email}</strong>. Para
                unirse, entra con ese mismo correo; si aún no tiene cuenta, la crea ahí mismo. Vale
                por 7 días.
              </DialogDescription>
            </DialogHeader>
            <Input
              readOnly
              value={invitationLink(done.id)}
              aria-label="Enlace de la invitación"
              onFocus={(e) => e.target.select()}
            />
            <ShareLink link={invitationLink(done.id)} email={done.email} storeName={store.name} />
            <DialogFooter>
              <Button onClick={onClose}>Listo</Button>
            </DialogFooter>
          </>
        ) : (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invitar a tu equipo</DialogTitle>
              <DialogDescription>
                Escribe su correo y elige qué podrá hacer en {store.name}.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-5">
              <Field data-invalid={errors.email ? true : undefined}>
                <FieldLabel htmlFor="invite-email">Correo</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? "invite-email-error" : undefined}
                />
                {errors.email ? (
                  <FieldError id="invite-email-error">{errors.email}</FieldError>
                ) : null}
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Rol</FieldLegend>
                <div className="flex flex-col gap-2">
                  {assignable(store).map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary-soft/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
                    >
                      <input
                        type="radio"
                        name="role"
                        value={option}
                        checked={role === option}
                        onChange={() => setRole(option)}
                        className="mt-1 accent-[var(--primary-fill)]"
                      />
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">{ROLES[option].name}</span>
                        <span className="text-sm text-muted-foreground">{ROLES[option].can}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {errors.role ? <FieldError>{errors.role}</FieldError> : null}
              </FieldSet>
            </FieldGroup>
            {invite.isError &&
            !(invite.error instanceof ApiError && Object.keys(invite.error.fields).length > 0) ? (
              <p role="alert" className="text-sm text-danger">
                {invite.error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <SubmitButton type="submit" pending={invite.isPending}>
                Crear la invitación
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * El enlace de una invitación. Lleva hasta aquí; aceptar exige haber entrado con la cuenta del
 * correo invitado. Si es otra cuenta, lo dice y deja entrar con la correcta.
 */
export function InvitationPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const me = useMe()
  const invitation = me.data?.invitations.find((i) => i.id === id)

  if (me.isPending) return <Opening message="Abriendo tu invitación…" />
  if (me.isError) return <OpeningFailed error={me.error} onRetry={() => void me.refetch()} />
  if (invitation)
    return (
      <Shell me={me.data}>
        <PageHeader
          title={`Te invitaron a ${invitation.storeName}`}
          subtitle="Al aceptar, entras a su equipo con tu cuenta."
        />
        <InvitationCard invitation={invitation} />
      </Shell>
    )
  return (
    <Shell me={me.data}>
      <PageHeader title="Invitación" />
      <ErrorState
        title="Esta invitación no está disponible"
        message={`Ya no está vigente, ya la aceptaste o es para otro correo. Entraste como ${me.data.person.email}.`}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" render={<Link to="/" />}>
          Ver tus tiendas
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            // Otra cuenta: la entrada ya no saluda a esta persona.
            forgetUser()
            forgetToken()
            await authClient.signOut().catch(() => undefined)
            window.location.assign(`/login?next=${encodeURIComponent(`/invitacion/${id}`)}`)
          }}
        >
          Entrar con otra cuenta
        </Button>
      </div>
    </Shell>
  )
}
