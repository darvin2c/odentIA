import { Button, toast } from "@odentia/ui"
import { brandColorCss } from "@odentia/ui/lib/brand-color"
import {
  AppShell,
  type AppShellNavEntry,
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
  type Place,
  PlaceSwitcher,
  regionCountry,
  SideDockProvider,
  SideDockSlot,
  type StripNotice,
  SubmitButton,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router"
import {
  ArrowLeft,
  Banknote,
  ChartColumn,
  CreditCard,
  House,
  KeyRound,
  MailOpen,
  Package,
  Plus,
  ReceiptText,
  Settings,
  Store,
  Truck,
  UserRound,
} from "lucide-react"
import {
  createContext,
  type MouseEventHandler,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { z } from "zod"
import { HelpMenuItem, StoreHelpButton } from "./ayuda"
import type { Team } from "./equipo"
import { ApiError, api, type Me, type MyStore, type MySupportState, ROLES } from "./lib/api"
import { device } from "./lib/avisos"
import { configEntryFor } from "./lib/configuracion"
import { accountToken, authClient, forgetToken, forgetUser } from "./lib/cuenta"
import { DraftGuard } from "./lib/draft-guard"
import { atTime, endedMessage, sentence, stripMessage } from "./lib/soporte"

/** Lo que la persona ve al entrar: sus tiendas y sus invitaciones. */
export function useMe() {
  return useQuery({ queryKey: ["yo"], queryFn: () => api<Me>("/api/yo") })
}

/**
 * Cierra la sesión de la cuenta en este navegador. La entrada sigue recordando quién era. Antes,
 * este celular deja de recibir los avisos de quien sale (tablero 15); nunca frena el cierre.
 */
async function signOut() {
  await device.forgetOnSignOut()
  forgetToken()
  await authClient.signOut().catch(() => undefined)
  window.location.assign("/login")
}

/**
 * El enlace del router con lo que le pasan el armazón y el selector (`aria-current`, `title`,
 * `onClick`). `exact`: el armazón decide cuál es el destino activo, no cada prefijo de la ruta.
 */
export function RouterLink({
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
        <ErrorState
          error={error instanceof Error ? error : "No se pudo cargar"}
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}

/**
 * La franja de arriba de la tienda (`NoticeStrip`, una sola a la vista, la más grave primero),
 * con lo de soporte de gestorIA (ADR 0219; lienzo «gestorIA · Configuración, de nuevo», decisión
 * 10):
 *
 * - A soporte que mira: qué tienda, hasta cuándo y que no cambia nada. No se cierra; «Salir»
 *   termina solo esta mirada, nunca la sesión (que es la misma de la administración). Sigue al
 *   permiso: cada medio minuto y al vencer vuelve a preguntar, así lo que estaba a la vista no
 *   queda abierto después de que la tienda la saca o de que se termina el tiempo.
 * - A quien puede responderle (`equipo.gestionar`): el pedido de soporte para mirar la tienda, una
 *   sola vez aquí y no en cada apartado, y quién mira ahora. Se responde en Equipo y repartidores.
 */
function StoreStrip({ store }: { store: MyStore }) {
  const queryClient = useQueryClient()
  const watching = store.supportUntil
  const until = watching ?? ""
  const answers = store.permissions.includes("equipo.gestionar")
  const team = useQuery({
    queryKey: ["equipo", store.id],
    queryFn: () => api<Team>(`/api/tiendas/${store.id}/equipo`),
    enabled: answers,
    refetchInterval: answers ? 120_000 : false,
  })
  useEffect(() => {
    if (!watching) return
    const check = () => void queryClient.invalidateQueries({ queryKey: ["yo"] })
    const timer = window.setInterval(check, 30_000)
    const left = new Date(until).getTime() - Date.now()
    const atEnd = left > 0 ? window.setTimeout(check, left + 1_000) : undefined
    return () => {
      window.clearInterval(timer)
      if (atEnd) window.clearTimeout(atEnd)
    }
  }, [watching, until, queryClient])
  const leave = useMutation({
    mutationFn: () => api(`/api/tiendas/${store.id}/soporte/salir`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["yo"] }),
    onError: (error) => toast.error(error.message),
  })
  const notices: StripNotice[] = []
  if (watching)
    notices.push({
      id: "soporte-mirando",
      tone: "alarma",
      message: stripMessage(store.name, until),
      short: `Solo mirar · hasta ${atTime(until)}`,
      action: {
        label: "Salir",
        onSelect: () => {
          if (!leave.isPending) leave.mutate()
        },
      },
    })
  const toTeam = `/tiendas/${store.id}/configuracion/equipo`
  for (const row of team.data?.support ?? []) {
    if (row.status === "por_aceptar")
      notices.push({
        id: `soporte-pide-${row.id}`,
        tone: "aviso",
        message: `${row.staffName} pide mirar tu tienda ${row.minutes} minutos. Solo mira: no cambia nada.`,
        short: `Soporte pide mirar ${row.minutes} minutos`,
        action: { label: "Revisar", to: toTeam },
      })
    else if (row.status === "vigente" && row.expiresAt)
      notices.push({
        id: `soporte-vigente-${row.id}`,
        tone: "aviso",
        message: `${row.staffName} ${row.usedAt ? "está mirando" : "puede mirar"} tu tienda hasta ${sentence(atTime(row.expiresAt))}`,
        short: `Soporte mira hasta ${atTime(row.expiresAt)}`,
        action: { label: "Ver", to: toTeam },
      })
  }
  if (notices.length === 0) return null
  return <NoticeStrip label="Soporte de gestorIA" notices={notices} LinkComponent={RouterLink} />
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
                  void navigate({
                    to: "/tiendas/$id/configuracion/plan",
                    params: { id: store.id },
                  }),
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
        // Soporte mirando una tienda ajena no viene a crear la suya.
        ...(store.role === "support"
          ? []
          : [
              {
                label: "Crear otra tienda",
                icon: <Plus aria-hidden />,
                onSelect: () => void navigate({ to: "/tiendas/nueva" }),
              },
            ]),
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
export function Shell({
  me,
  store,
  bare = false,
  children,
}: {
  me: Me
  store?: MyStore
  /** La página pone su propio `PageShell` (las pantallas de la cuenta). */
  bare?: boolean
  children: ReactNode
}) {
  const { pathname } = useLocation()
  // La foto y el nombre, los de la cuenta: cambian en Mi perfil sin esperar otro token.
  const live = authClient.useSession().data?.user
  const canDispatch = store?.permissions.includes("entregas") ?? false
  const dispatch = useQuery({
    queryKey: ["despachos-resumen", store?.id],
    queryFn: () => api<{ missed: number }>(`/api/tiendas/${store?.id}/despachos/resumen`),
    enabled: canDispatch,
    refetchInterval: 120_000,
  })
  const items: AppShellNavEntry[] = store
    ? storeSections(store, dispatch.data?.missed ?? 0)
    : [{ label: "Tus tiendas", to: "/", icon: Store }]
  // `tienda` deja en la cuenta el enlace para volver a esta tienda, como «Mi perfil» de la
  // clínica; vacía, fuera de una tienda, olvida la de antes. Ya en la cuenta, se conserva.
  const from: { tienda?: string } = pathname.startsWith("/cuenta")
    ? {}
    : { tienda: store?.id ?? "" }
  return (
    <AppShell
      notice={store ? <StoreStrip store={store} /> : undefined}
      items={items}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{
        name: live?.name ?? me.person.name,
        email: live?.email ?? me.person.email,
        avatarUrl: live?.image ?? null,
        givenNames: live?.firstName ?? null,
        familyName: live?.lastName ?? null,
      }}
      userMenuItems={
        store?.role === "support"
          ? []
          : [
              {
                label: "Mi perfil",
                icon: UserRound,
                to: "/cuenta",
                ...(from ? { search: from } : {}),
              },
              {
                label: "Cambiar contraseña",
                icon: KeyRound,
                to: "/cuenta",
                search: { edit: "password", ...from },
              },
            ]
      }
      footerItems={store ? storeFooter(store) : undefined}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      switcher={store ? <StoreSwitcher me={me} store={store} /> : undefined}
      // La sesión es la misma en las apps abiertas desde aquí con el pase (ADR 0215): se cierra en
      // todas. Soporte llegó desde la administración: se le dice antes que también la cierra.
      signOutHint={
        store?.role === "support"
          ? "También cierra la administración: es la misma sesión. Para dejar de mirar, usa «Salir» arriba"
          : "Cierra tu sesión aquí y en las apps que abriste desde aquí"
      }
      onSignOut={() => void signOut()}
    >
      {/* La columna lateral, como en las clínicas: en una ventana ancha, lo que se abre al lado (la
          Ayuda, un formulario de la cuenta) va a la derecha de la página, que le cede el ancho, y
          salir con algo escrito pregunta antes. La Ayuda (ADR 0227) está en la cabecera de cada
          pantalla de la tienda; con la fila compacta (el teléfono), en su menú ⋯. */}
      <SideDockProvider draftGuard={DraftGuard}>
        <HeaderUtilitiesProvider
          value={
            store
              ? { utilities: <StoreHelpButton store={store} />, menuItems: <HelpMenuItem /> }
              : {}
          }
        >
          {/* La estructura no cambia al abrir o cerrar la columna: la página nunca se remonta. */}
          <div className="flex min-w-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {bare ? children : <PageShell className="flex flex-col gap-6">{children}</PageShell>}
            </div>
            <SideDockSlot />
          </div>
        </HeaderUtilitiesProvider>
      </SideDockProvider>
    </AppShell>
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

const newStoreSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de tu tienda").max(80, "Máximo 80 caracteres"),
  currency: z.string().min(1, "Elige la moneda en que vendes"),
  country: z.string().min(1, "Elige el país de tu tienda"),
})

function NewStoreForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currencies = useCurrencies()
  const form = useAppForm({
    // El país, el de la región del navegador, como en el teléfono: se cambia buscando en la lista.
    defaultValues: { name: "", currency: "PEN", country: regionCountry() as string },
    validators: { onSubmit: newStoreSchema },
    onSubmit: async ({ value }) => {
      const { store } = await api<{ store: MyStore }>("/api/tiendas", {
        method: "POST",
        body: { name: value.name.trim(), currency: value.currency, country: value.country },
      })
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      await navigate({ to: "/tiendas/$id", params: { id: store.id } })
    },
  })
  const surface = useFormSurface(form)
  return (
    <>
      <PageHeader
        title="Crea tu tienda"
        subtitle="Quedas como su dueño. Después invitas a tu equipo."
      />
      <form
        noValidate
        onSubmit={surface.onSubmit}
        className="flex max-w-md flex-col gap-5 rounded-xl border bg-card p-5"
        aria-label="Crea tu tienda"
      >
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label="Nombre de la tienda"
              id="store-name"
              autoFocus
              maxLength={80}
              placeholder="Por ejemplo, Calzados Rosa"
              description="Como lo ven tus clientes."
            />
          )}
        </form.AppField>
        <form.AppField name="currency">
          {(field) => (
            <field.SelectField
              label="Moneda en que vendes"
              id="currency"
              options={currencies.map((option) => ({ value: option.code, label: option.label }))}
              description="Todos tus precios y pedidos van en esta moneda."
            />
          )}
        </form.AppField>
        <form.AppField name="country">
          {(field) => (
            <field.Control
              label="País de tu tienda"
              id="country"
              description="Con él te cobramos el plan con el impuesto que corresponde."
            >
              {(control) => (
                <CountrySelect
                  id={control.id}
                  value={field.state.value as CountryCode}
                  onChange={(next) => field.handleChange(next)}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {surface.error ? (
          <p role="alert" className="text-sm text-danger">
            {surface.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <SubmitButton type="submit" pending={surface.isSubmitting}>
            Crear la tienda
          </SubmitButton>
          <Button variant="ghost" render={<Link to="/" />}>
            Cancelar
          </Button>
        </div>
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

/**
 * El menú del día (lienzo «gestorIA como odentIA», tablero 4): arriba lo diario, con Inicio
 * primero y Despachos antes de Pedidos, y en «Gestión» lo que se mira de la tienda, con Caja. Solo
 * lo que ya existe: la Bandeja se suma cuando llegue su pantalla, en su lugar. Configuración va
 * al pie (`storeFooter`). El número de Despachos es lo que no se entregó y todavía no
 * sale.
 */
function storeSections(store: MyStore, missed: number): AppShellNavEntry[] {
  const id = store.id
  // Soporte de gestorIA solo mira: sin pedidos, clientas ni conversaciones (`ventas.atender`).
  const attends = store.permissions.includes("ventas.atender")
  return [
    // Inicio (tablero 5): lo que le toca a cada rol, para todo el equipo que atiende.
    ...(attends ? [{ label: "Inicio", to: `/tiendas/${id}`, icon: House }] : []),
    ...(store.permissions.includes("entregas")
      ? [
          {
            label: "Despachos",
            to: `/tiendas/${id}/despachos`,
            icon: Truck,
            ...(missed > 0
              ? {
                  badge: missed,
                  badgeLabel: missed === 1 ? "1 no se entregó" : `${missed} no se entregaron`,
                }
              : {}),
          },
        ]
      : []),
    ...(attends
      ? [
          { label: "Pedidos", to: `/tiendas/${id}/pedidos`, icon: ReceiptText },
          // Del día a día (entrega 4): cada clienta con sus compras, para todo el equipo que atiende.
          { label: "Clientes", to: `/tiendas/${id}/clientes`, icon: UserRound },
        ]
      : []),
    {
      label: "Gestión",
      children: [
        { label: "Catálogo", to: `/tiendas/${id}/catalogo`, icon: Package },
        // Caja: lo cobrado del día y el efectivo de cada repartidor, solo Dueño y Administrador.
        ...(store.permissions.includes("caja")
          ? [{ label: "Caja", to: `/tiendas/${id}/caja`, icon: Banknote }]
          : []),
        // Reportes y Argos: solo Dueño y Administrador.
        ...(store.permissions.includes("reportes.ver")
          ? [{ label: "Reportes", to: `/tiendas/${id}/reportes`, icon: ChartColumn }]
          : []),
      ],
    },
  ]
}

/**
 * Al pie, como en las clínicas: Configuración, si quien está ve algún apartado (Ventas ve solo sus
 * avisos al celular: no ve lo que no puede tocar). La Ayuda está en la cabecera.
 */
function storeFooter(store: MyStore): AppShellNavItem[] {
  // Abre en «Lo que falta» o, si no la ve, en lo primero suyo: a Ventas, sus avisos al celular.
  const first = configEntryFor(store)
  return first
    ? [{ label: "Configuración", to: `/tiendas/${store.id}${first.path}`, icon: Settings }]
    : []
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
  if (!store) return <NotYours me={me.data} id={id} />
  // Quien solo mira (soporte) entra por el catálogo: Inicio, los pedidos y las clientas no son suyos.
  const inside = pathname.slice(`/tiendas/${id}`.length).replace(/\/$/, "")
  if (
    !store.permissions.includes("ventas.atender") &&
    (inside === "" ||
      inside === "/pedidos" ||
      inside.startsWith("/clientes") ||
      inside === "/despachos" ||
      inside === "/caja")
  )
    return <Navigate to="/tiendas/$id/catalogo" params={{ id }} replace />
  // El color de «Tu marca» pinta la app de todo el equipo, como el de cada clínica (los tonos para
  // que se lea salen de la misma cuenta). Sin color, el naranja de gestorIA.
  const brandCss = brandColorCss(store.brandColor)
  return (
    <StoreContext.Provider value={{ store, meId: me.data.person.userId }}>
      {brandCss ? <style>{brandCss}</style> : null}
      <Shell me={me.data} store={store}>
        <Outlet />
      </Shell>
    </StoreContext.Provider>
  )
}

/**
 * Una tienda que no está en la lista de la persona. Si alguna vez tuvo una entrada de soporte en
 * ella, el servidor dice cómo está la suya (ADR 0219): la tienda todavía no responde, hay que
 * abrirla desde la administración o el acceso terminó, con su motivo. A cualquier otra persona, que
 * no la encontramos.
 */
function NotYours({ me, id }: { me: Me; id: string }) {
  const queryClient = useQueryClient()
  const state = useQuery({
    queryKey: ["soporte-mio", id],
    queryFn: async () => {
      const first = await api<MySupportState>(`/api/tiendas/${id}/soporte/mio`)
      if (first.state !== "falta_codigo") return first
      // Un token pedido antes de abrirla desde la administración no trae el código: otro, una vez.
      await accountToken(true)
      return api<MySupportState>(`/api/tiendas/${id}/soporte/mio`)
    },
    retry: false,
    // Pedir el estado pide un token nuevo si falta el código: no a cada vuelta a la pestaña.
    refetchOnWindowFocus: false,
  })
  const ready = state.data?.state === "puede_mirar"
  useEffect(() => {
    if (ready) void queryClient.invalidateQueries({ queryKey: ["yo"] })
  }, [ready, queryClient])
  const retry = () =>
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["soporte-mio", id] }),
      queryClient.invalidateQueries({ queryKey: ["yo"] }),
    ])
  if (state.isPending || ready) return <Opening message="Abriendo la tienda…" />
  const found = state.data
  if (!found) {
    if (state.error instanceof ApiError && state.error.status !== 404)
      return <OpeningFailed error={state.error} onRetry={retry} />
    return (
      <Shell me={me}>
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
  }
  // Abierta desde un enlace (la administración), la pestaña se puede cerrar desde aquí.
  const closable = typeof window !== "undefined" && window.history.length <= 1
  const close = closable ? (
    <Button variant="outline" className="self-start" onClick={() => window.close()}>
      Cerrar esta pestaña
    </Button>
  ) : null
  return (
    <Shell me={me}>
      {found.state === "pendiente" ? (
        <>
          <PageHeader title="La tienda todavía no responde" />
          <p className="max-w-prose text-sm text-muted-foreground">
            Su Dueño o un Administrador decide si entras. Cuando te deje entrar, vuelve a abrirla
            desde la cuenta de la tienda en la administración.
          </p>
          <Button variant="outline" className="self-start" onClick={retry}>
            Volver a probar
          </Button>
        </>
      ) : found.state === "falta_codigo" ? (
        <>
          <PageHeader title="Para mirar esta tienda, ábrela desde la administración" />
          <p className="max-w-prose text-sm text-muted-foreground">
            Como soporte, se mira desde la cuenta de la tienda en la administración, con tu código.
            Tu acceso sigue hasta {sentence(atTime(found.until))}
          </p>
          {close}
        </>
      ) : found.state === "terminado" ? (
        <>
          <PageHeader title="El acceso terminó" />
          <div className="flex max-w-prose flex-col gap-2 text-sm">
            <p>{endedMessage(found)}</p>
            <p className="text-muted-foreground">
              Si hace falta seguir, pídelo otra vez desde la cuenta en la administración.
            </p>
          </div>
          {close}
        </>
      ) : null}
    </Shell>
  )
}

/**
 * El encabezado de cada sección de la tienda (`PageHeader`). Lo que soporte de gestorIA pide o
 * tiene abierto va una sola vez, en la franja de arriba (`StoreStrip`), y se responde en Equipo y
 * repartidores. Si se llegó desde los primeros pasos de Inicio, arriba va «Volver a Inicio».
 */
export function StoreHeader(props: PageHeaderProps) {
  const { store } = useStoreContext()
  const { search } = useLocation()
  // Abierto desde los primeros pasos de Inicio (`?desde=inicio`): un toque para volver a la lista.
  const fromHome = (search as Record<string, unknown>).desde === "inicio"
  return (
    <>
      {fromHome ? (
        <Link
          to="/tiendas/$id"
          params={{ id: store.id }}
          className="-mb-3 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 md:min-h-0"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Volver a Inicio
        </Link>
      ) : null}
      <PageHeader {...props} />
    </>
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
