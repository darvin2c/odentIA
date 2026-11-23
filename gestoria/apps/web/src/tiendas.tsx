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
  EmptyState,
  ErrorState,
  PersonAvatar,
  SectionNav,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router"
import {
  Bot,
  ChartColumn,
  Copy,
  CreditCard,
  LogOut,
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
  type TeamMember,
} from "./lib/api"
import { authClient, forgetToken } from "./lib/cuenta"
import { browserCountry, countryOptions } from "./lib/tienda"
import { GroupSignature, Logo } from "./marca"

/** Lo que la persona ve al entrar: sus tiendas y sus invitaciones. */
export function useMe() {
  return useQuery({ queryKey: ["yo"], queryFn: () => api<Me>("/api/yo") })
}

async function signOut() {
  forgetToken()
  await authClient.signOut().catch(() => undefined)
  window.location.assign("/login")
}

/** El marco de las pantallas con sesión: la marca, la persona y salir. */
export function Shell({
  children,
  store,
  wide = false,
}: {
  children: ReactNode
  store?: MyStore
  /** El catálogo y su producto usan más ancho en el escritorio. */
  wide?: boolean
}) {
  const width = wide ? "max-w-6xl" : "max-w-4xl"
  const me = useMe()
  return (
    <div className="flex min-h-dvh flex-col bg-surface-muted">
      <header className="border-b bg-card">
        <div className={`mx-auto flex h-14 w-full ${width} items-center gap-3 px-4`}>
          <Link to="/" aria-label="Tus tiendas" className="shrink-0">
            <Logo className="w-28 sm:w-32" />
          </Link>
          {store ? (
            <span
              className="min-w-0 truncate border-l pl-3 text-sm font-semibold"
              title={store.name}
            >
              {store.name}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {me.data ? (
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {me.data.person.name}
              </span>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut aria-hidden />
              Salir
            </Button>
          </div>
        </div>
      </header>
      <main className={`mx-auto flex w-full ${width} min-w-0 flex-1 flex-col gap-6 px-4 py-6`}>
        {children}
      </main>
      <footer className="flex justify-center px-4 pb-5">
        <GroupSignature />
      </footer>
    </div>
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

  if (me.isPending || only) return <Shell>{null}</Shell>
  if (me.isError)
    return (
      <Shell>
        <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />
      </Shell>
    )
  const { stores, invitations, person } = me.data
  const nothing = stores.length === 0 && invitations.length === 0

  return (
    <Shell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">
          Hola, {person.name.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          {nothing
            ? "Crea tu tienda para empezar a vender."
            : "Elige con qué tienda vas a trabajar."}
        </p>
      </div>

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
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currencies = useCurrencies()
  const [name, setName] = useState("")
  const [currency, setCurrency] = useState("PEN")
  const countries = useMemo(countryOptions, [])
  const [country, setCountry] = useState(browserCountry)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useMutation({
    mutationFn: () =>
      api<{ store: MyStore }>("/api/tiendas", {
        method: "POST",
        body: { name, currency, country: country || null },
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
    <Shell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Crea tu tienda</h1>
        <p className="text-sm text-muted-foreground">
          Quedas como su dueño. Después invitas a tu equipo.
        </p>
      </div>
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
            <select
              id="country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="h-9 w-full rounded-md border border-input-border bg-input/30 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              aria-describedby="country-help"
            >
              <option value="">Sin elegir</option>
              {countries.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
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
    </Shell>
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
  return [
    { label: "Pedidos", to: `/tiendas/${id}/pedidos`, icon: ReceiptText },
    { label: "Sofi", to: `/tiendas/${id}/sofi`, icon: Bot },
    { label: "Catálogo", to: `/tiendas/${id}/catalogo`, icon: Package },
    { label: "Pagos y entregas", to: `/tiendas/${id}/pagos-y-entregas`, icon: Truck },
    // Reportes y Argos: solo Dueño y Administrador.
    ...(store.permissions.includes("reportes.ver")
      ? [{ label: "Reportes", to: `/tiendas/${id}/reportes`, icon: ChartColumn }]
      : []),
    { label: "Equipo", to: `/tiendas/${id}/equipo`, icon: Users },
    // El plan, lo cobrado y los pagos: solo el Dueño.
    ...(store.permissions.includes("plan")
      ? [{ label: "Plan y pagos", to: `/tiendas/${id}/plan`, icon: CreditCard }]
      : []),
  ]
}

/** El enlace de cada sección, con el del router (lo que recibe se lo pasa tal cual). */
function SectionLink({
  to,
  search: _search,
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
    <Link to={to} {...rest}>
      {children}
    </Link>
  )
}

/**
 * La tienda: su nombre, el rol de quien está y sus secciones (lienzo B, tableros 6 y 7). Lo que
 * llega después (WhatsApp) se suma como otra sección.
 */
export function StoreLayout() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { pathname } = useLocation()
  const me = useMe()
  const store = me.data?.stores.find((s) => s.id === id)

  if (me.isPending) return <Shell wide>{null}</Shell>
  if (me.isError)
    return (
      <Shell>
        <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />
      </Shell>
    )
  if (!store)
    return (
      <Shell>
        <ErrorState
          title="No encontramos esa tienda en tu cuenta"
          message="Puede que te hayan quitado del equipo."
        />
        <Button variant="outline" render={<Link to="/" />} className="self-start">
          Ver tus tiendas
        </Button>
      </Shell>
    )
  return (
    <Shell store={store} wide>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-2xl font-extrabold tracking-[-0.02em]">{store.name}</h1>
          <p className="text-sm text-muted-foreground">
            Eres {ROLES[store.role].name}. Vende en {store.currency}.
          </p>
        </div>
        {me.data.stores.length > 1 || me.data.invitations.length > 0 ? (
          <Button variant="outline" size="sm" render={<Link to="/" />}>
            Cambiar de tienda
          </Button>
        ) : null}
      </div>
      <StoreContext.Provider value={{ store, meId: me.data.person.userId }}>
        <SectionNav
          label={`Secciones de ${store.name}`}
          items={storeSections(store)}
          pathname={pathname}
          LinkComponent={SectionLink}
          mobilePosition="header"
        >
          <div className="flex min-w-0 flex-col gap-6">
            <Outlet />
          </div>
        </SectionNav>
      </StoreContext.Provider>
    </Shell>
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
    queryFn: () =>
      api<{ members: TeamMember[]; invitations: PendingInvitation[] }>(
        `/api/tiendas/${store.id}/equipo`,
      ),
  })
  const [inviting, setInviting] = useState(false)

  return (
    <section aria-labelledby="equipo" className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 id="equipo" className="text-lg font-bold">
            Tu equipo
          </h2>
          <p className="text-sm text-muted-foreground">
            Quién atiende tu tienda y qué puede hacer.
          </p>
        </div>
        {canManage ? (
          <Button onClick={() => setInviting(true)}>
            <UserPlus aria-hidden />
            Invitar
          </Button>
        ) : null}
      </div>
      {team.isPending ? <p className="text-sm text-muted-foreground">Cargando tu equipo…</p> : null}
      {team.isError ? <ErrorBlock error={team.error} onRetry={() => void team.refetch()} /> : null}
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
      {inviting ? <InviteDialog store={store} onClose={() => setInviting(false)} /> : null}
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

  if (me.isPending) return <Shell>{null}</Shell>
  if (me.isError)
    return (
      <Shell>
        <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />
      </Shell>
    )
  if (invitation)
    return (
      <Shell>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-[-0.02em]">
            Te invitaron a {invitation.storeName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Al aceptar, entras a su equipo con tu cuenta.
          </p>
        </div>
        <InvitationCard invitation={invitation} />
      </Shell>
    )
  return (
    <Shell>
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
