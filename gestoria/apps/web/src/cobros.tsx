import { Badge, Button, cn, FieldGroup, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  addSubmitErrors,
  clearSubmitErrors,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  RadioChips,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  CircleDashed,
  Clipboard,
  CreditCard,
  ExternalLink,
  ImageUp,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ToggleField } from "./campos"
import { ApiError, api } from "./lib/api"
import {
  type Bank,
  cciCheck,
  cciDigits,
  cciIssue,
  cciReady,
  cciText,
  KINDS,
  type LinkStatus,
  MERCADO_PAGO_FEE,
  netOf,
  type PaymentKind,
  type PaymentMethod,
  phoneText,
  walletPreview,
  whoConfirms,
} from "./lib/cobros"
import { when } from "./lib/pedidos"
import { fractionDigits, money, PAYMENT_TYPES, type PaymentTypeCode } from "./lib/tienda"
import { shrinkPhoto } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6): las dos formas
 * de cobrar, una debajo de la otra. Arriba, el link que la clienta paga con Yape o tarjeta y que la
 * pasarela confirma sola (Mercado Pago, conectado entrando a la cuenta o con las claves de la
 * tienda, con su modo prueba de S/ 1). Abajo, lo que confirma una persona: Yape y Plin con su celular, su titular y su QR, la
 * transferencia con su banco y su CCI, y lo que se cobra al recibir. Al pie, la regla de siempre:
 * quién confirma cada pago y cuándo se entrega. Lo cambia quien tiene `configuracion`; soporte lo
 * mira sin cambiarlo.
 */

interface Lists {
  payments: PaymentMethod[]
  banks: Bank[]
}

const LISTS_KEY = (storeId: string) => ["pagos-y-entregas", storeId]
const LINK_KEY = (storeId: string) => ["link-de-pago", storeId]

export function PaymentMethodsPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const lists = useQuery({
    queryKey: LISTS_KEY(store.id),
    queryFn: () => api<Lists>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  const [editing, setEditing] = useState<PaymentMethod | "new" | null>(null)
  const byPerson = lists.data?.payments.filter((m) => m.kind !== "link") ?? []

  return (
    <>
      <StoreHeader title="Cobros" />
      <LinkCard storeId={store.id} currency={store.currency} canEdit={canEdit} />
      <section
        aria-labelledby="cobros-persona"
        className="elevated overflow-hidden rounded-xl border bg-card"
      >
        <CardHead
          id="cobros-persona"
          title="A tu número o al recibir"
          hint="Sin pasarela de por medio. Sofi los ofrece si la clienta no quiere el link."
          pill={<Badge variant="warning">Los confirma una persona</Badge>}
        />
        {lists.isPending ? (
          <SkeletonRegion message="Cargando tus formas de cobro">
            <div className="flex flex-col gap-3 px-5 py-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          </SkeletonRegion>
        ) : lists.isError ? (
          <div className="px-5 py-4">
            <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />
          </div>
        ) : byPerson.length === 0 ? (
          <div className="px-5 py-4">
            <EmptyState
              icon={CreditCard}
              title="Todavía no cobras a tu número"
              description="Agrega tu Yape o Plin con su QR, tu cuenta para transferencias o el pago al recibir."
            />
          </div>
        ) : (
          <ul className="flex flex-col divide-y border-t">
            {byPerson.map((method) => (
              <MethodRow
                key={method.id}
                storeId={store.id}
                method={method}
                banks={lists.data.banks}
                canEdit={canEdit}
                onOpen={() => setEditing(method)}
              />
            ))}
          </ul>
        )}
        {canEdit && lists.data ? (
          <div className="border-t px-3 py-2">
            <Button variant="ghost" onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              Agregar otra forma de cobro
            </Button>
          </div>
        ) : null}
      </section>
      <ConfirmTable />
      {editing && lists.data ? (
        <PaymentForm
          storeId={store.id}
          currency={store.currency}
          banks={lists.data.banks}
          method={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

function CardHead({
  id,
  title,
  hint,
  pill,
}: {
  id: string
  title: string
  hint: string
  pill: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {pill}
    </div>
  )
}

/** La marca de cada forma: una sigla en su color, como la reconoce la clienta. */
function Mark({ text, tone, className }: { text: string; tone: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold tracking-wide",
        tone,
        className,
      )}
    >
      {text}
    </span>
  )
}

function markOf(method: PaymentMethod, banks: Bank[]) {
  const kind = method.kind === "link" ? "otro" : method.kind
  if (method.kind === "transferencia") {
    const bank = banks.find((b) => b.code === method.bankCode)
    return { ...KINDS.transferencia, badge: bank?.short.slice(0, 3).toUpperCase() ?? "BAN" }
  }
  return KINDS[kind]
}

/** La línea de datos de cada forma: lo que verá la clienta, sin tener que abrirla. */
function lineOf(method: PaymentMethod, banks: Bank[]): string {
  if (method.kind === "yape" || method.kind === "plin")
    return [phoneText(method.phone), method.holder, method.qrAt ? "con tu QR" : "sin QR"]
      .filter(Boolean)
      .join(" · ")
  if (method.kind === "transferencia")
    return [
      banks.find((b) => b.code === method.bankCode)?.short,
      method.accountNumber ? `cuenta ${method.accountNumber}` : null,
      method.cci ? `CCI ${cciText(method.cci)}` : "sin CCI",
    ]
      .filter(Boolean)
      .join(" · ")
  return method.details || "Sin nota"
}

function MethodRow({
  storeId,
  method,
  banks,
  canEdit,
  onOpen,
}: {
  storeId: string
  method: PaymentMethod
  banks: Bank[]
  canEdit: boolean
  onOpen: () => void
}) {
  const mark = markOf(method, banks)
  return (
    <li
      className={cn(
        "@container flex items-center gap-3 px-5 py-3",
        method.isActive ? null : "text-muted-foreground",
      )}
    >
      <Mark
        text={mark.badge}
        tone={mark.tone}
        className={method.isActive ? undefined : "opacity-50"}
      />
      <button
        type="button"
        onClick={onOpen}
        disabled={!canEdit}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-default @xl:flex-row @xl:items-center @xl:gap-4"
      >
        <span className="flex w-full min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-x-2 font-semibold">
            {method.name}
            {method.isActive ? null : (
              <Badge variant="outline" className="font-normal">
                Apagado
              </Badge>
            )}
          </span>
          <span className="truncate text-sm text-muted-foreground">{lineOf(method, banks)}</span>
        </span>
        <span className="text-sm text-muted-foreground @xl:w-56 @xl:shrink-0 @xl:text-right">
          {whoConfirms(method)}
        </span>
      </button>
      <ActiveSwitch storeId={storeId} method={method} canEdit={canEdit} />
    </li>
  )
}

/** Encender o apagar guarda al momento; si falla, vuelve como estaba y lo dice. */
function ActiveSwitch({
  storeId,
  method,
  canEdit,
}: {
  storeId: string
  method: Pick<PaymentMethod, "id" | "name" | "isActive">
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (isActive: boolean) =>
      api(`/api/tiendas/${storeId}/medios-de-pago/${method.id}`, {
        method: "PATCH",
        body: { isActive },
      }),
    onSuccess: async (_, isActive) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) }),
        queryClient.invalidateQueries({ queryKey: LINK_KEY(storeId) }),
      ])
      toast.success(
        isActive ? `${method.name}: encendido` : `${method.name}: apagado, Sofi ya no lo ofrece`,
      )
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const shown = toggle.isPending ? Boolean(toggle.variables) : method.isActive
  if (!canEdit) return <Badge variant="outline">{method.isActive ? "Encendido" : "Apagado"}</Badge>
  return (
    <Switch
      checked={shown}
      disabled={toggle.isPending}
      onCheckedChange={(next) => toggle.mutate(next)}
      aria-label={`${method.name}: ${shown ? "encendido" : "apagado"}`}
    />
  )
}

/* ---------------------------------------------------------- el link: Mercado Pago */

/** Lo que vale el link de prueba: una unidad de la moneda (S/ 1), como lo crea el servidor. */
const trialCents = (currency: string) => 10 ** fractionDigits(currency)

function feeText(currency: string): string | null {
  if (currency !== MERCADO_PAGO_FEE.currency) return null
  return `Por cada ${money(10000, currency)} recibes ${money(netOf(10000), currency)} al instante · ${MERCADO_PAGO_FEE.percent} % + ${money(MERCADO_PAGO_FEE.fixedCents, currency)} + IGV, la comisión que publica Mercado Pago`
}

function LinkCard({
  storeId,
  currency,
  canEdit,
}: {
  storeId: string
  currency: string
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: LINK_KEY(storeId),
    queryFn: () => api<LinkStatus>(`/api/tiendas/${storeId}/link-de-pago`),
    // Mientras espera el pago de prueba (de los últimos 15 minutos), mira cada 5 segundos si
    // Mercado Pago avisó.
    refetchInterval: (query) => {
      const trial = query.state.data?.trial
      const recent = trial && Date.now() - new Date(trial.createdAt).getTime() < 15 * 60_000
      return recent && !trial.paidAt ? 5000 : false
    },
  })
  const connect = useMutation({
    mutationFn: (mode: "prueba" | "real") =>
      api<{ url: string }>(`/api/tiendas/${storeId}/link-de-pago/conectar`, {
        method: "POST",
        body: { mode },
      }),
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  // Un doble toque llega antes de que el botón se vea ocupado: el segundo no sale (y si sale, el
  // servidor devuelve el mismo link).
  const trialSent = useRef(false)
  const trial = useMutation({
    mutationFn: () =>
      api<{ trial: NonNullable<LinkStatus["trial"]> }>(
        `/api/tiendas/${storeId}/link-de-pago/prueba`,
        { method: "POST" },
      ),
    // El link se abre con «Abrir el link de prueba»: abrirlo solo, tras esperar, lo bloquea el navegador.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LINK_KEY(storeId) }),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: () => {
      trialSent.current = false
    },
  })
  const tryLink = () => {
    if (trialSent.current) return
    trialSent.current = true
    trial.mutate()
  }
  const [removing, setRemoving] = useState(false)
  // El cajón de las claves: para conectar en prueba o para «Cobrar de verdad».
  const [keys, setKeys] = useState<"prueba" | "real" | null>(null)
  const data = status.data
  const connection = data?.connection ?? null
  const fee = feeText(currency)
  // Entrar a la cuenta necesita la aplicación de gestorIA en Mercado Pago; si no está, o si la
  // tienda se conectó con sus claves, todo sigue por las claves.
  const byKeys = !data?.accountDoor || connection?.via === "claves"
  const reconnect = (mode: "prueba" | "real") => (byKeys ? setKeys(mode) : connect.mutate(mode))

  let body: ReactNode
  if (status.isPending) body = <LoadingState message="Mirando cómo está tu Mercado Pago…" />
  else if (status.isError)
    body = <ErrorState error={status.error} onRetry={() => void status.refetch()} />
  else if (!data?.available && !connection)
    body = (
      <p className="text-sm text-muted-foreground">
        Conectar Mercado Pago todavía no está disponible en gestorIA. Mientras tanto, cobra a tu
        número o al recibir.
      </p>
    )
  else if (!connection)
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Mark text="MP" tone="bg-[#00b1ea] text-white" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold">Cobrar con link</span>
            <span className="text-sm text-muted-foreground">
              El dinero llega a tu cuenta de Mercado Pago, no a gestorIA. Puedes desconectarla
              cuando quieras.
            </span>
            {fee ? <span className="text-sm text-muted-foreground">{fee}.</span> : null}
          </div>
        </div>
        {canEdit ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {data?.accountDoor ? (
                <Button
                  className="bg-[#00b1ea] text-white hover:bg-[#009fd3]"
                  disabled={connect.isPending}
                  onClick={() => connect.mutate("prueba")}
                >
                  {connect.isPending ? "Abriendo Mercado Pago…" : "Conectar con Mercado Pago"}
                </Button>
              ) : (
                <Button
                  className="bg-[#00b1ea] text-white hover:bg-[#009fd3]"
                  onClick={() => setKeys("prueba")}
                >
                  <KeyRound aria-hidden />
                  Conectar con mis claves
                </Button>
              )}
              <a
                href="https://www.mercadopago.com.pe"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                ¿No tienes cuenta? Créala gratis en Mercado Pago, con tu DNI.
              </a>
            </div>
            {data?.accountDoor ? (
              <button
                type="button"
                className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setKeys("prueba")}
              >
                ¿Prefieres usar tus propias claves?
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Lo conecta el Dueño o un Administrador.</p>
        )}
        <p className="text-xs text-muted-foreground">
          {data?.accountDoor
            ? "Entras con tu cuenta y das permiso para crear links de pago y ver si se pagaron. No copias ninguna clave."
            : "Copias una clave de tu panel de Mercado Pago y la pegas aquí: te guiamos paso a paso, sin saber programar."}{" "}
          Empieza en modo prueba, con un link de {money(trialCents(currency), currency)}.
        </p>
      </div>
    )
  else {
    const test = connection.mode === "prueba"
    const broken = connection.state !== "conectada"
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Mark text="MP" tone="bg-[#00b1ea] text-white" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 font-semibold">
              Mercado Pago
              {broken ? (
                <Badge variant="destructive">
                  {connection.state === "vencida" ? "Venció el permiso" : "Sin permiso"}
                </Badge>
              ) : test ? (
                <Badge className="bg-[#ede9fe] text-[#5b21b6]">Modo prueba</Badge>
              ) : (
                <Badge variant="success">Cobrando de verdad</Badge>
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {[
                connection.via === "claves"
                  ? "Conectada con tus claves"
                  : "Conectada entrando a tu cuenta",
                connection.account ? `Cuenta ${connection.account}` : null,
                "Yape y tarjeta en el link",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {fee && !broken ? <span className="text-sm text-muted-foreground">{fee}</span> : null}
          </div>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              {broken ? (
                <Button disabled={connect.isPending} onClick={() => reconnect(connection.mode)}>
                  Volver a conectar
                </Button>
              ) : test ? (
                <>
                  <Button
                    variant="outline"
                    disabled={trial.isPending}
                    aria-busy={trial.isPending || undefined}
                    onClick={tryLink}
                  >
                    {trial.isPending
                      ? "Creando el link…"
                      : `Probar con ${money(trialCents(currency), currency)}`}
                  </Button>
                  <Button disabled={connect.isPending} onClick={() => reconnect("real")}>
                    Cobrar de verdad
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {broken ? (
          <p role="status" className="rounded-lg bg-danger-soft px-3 py-2 text-sm">
            {connection.state === "vencida"
              ? "Mercado Pago ya no deja usar la conexión: venció su permiso. Vuelve a conectar para seguir cobrando con link; mientras tanto, los pedidos se cobran a tu número o al recibir."
              : connection.via === "claves"
                ? "Mercado Pago ya no reconoce tus claves: pudiste cambiarlas o borrar tu aplicación en su panel. Toca «Volver a conectar» y pega el Access Token de nuevo; mientras tanto, cobra a tu número o al recibir."
                : "Quitaste el permiso de gestorIA en Mercado Pago. Los links ya no se confirman solos: vuelve a conectar o cobra a tu número."}
          </p>
        ) : test ? (
          <TrialPanel trial={data?.trial ?? null} currency={currency} />
        ) : data?.method && canEdit ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-muted px-3 py-2.5 text-sm">
            <span>
              {data.method.isActive
                ? "Sofi ofrece el link primero; el pedido queda pagado solo."
                : "Sofi no ofrece el link: está apagado."}
            </span>
            <ActiveSwitch
              storeId={storeId}
              method={{ ...data.method, name: "El link de pago" }}
              canEdit={canEdit}
            />
          </div>
        ) : null}
        {canEdit ? (
          <div>
            <Button
              variant="ghost"
              className="text-danger"
              size="sm"
              onClick={() => setRemoving(true)}
            >
              Desconectar Mercado Pago
            </Button>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <section
      aria-labelledby="cobros-link"
      className="elevated overflow-hidden rounded-xl border bg-card"
    >
      <CardHead
        id="cobros-link"
        title="Con link: «Pagar ahora»"
        hint="La clienta paga con Yape o tarjeta y el pedido queda pagado solo. Nadie revisa nada."
        pill={<Badge variant="success">Lo confirma la pasarela, sola</Badge>}
      />
      <div className="border-t px-5 py-4">{body}</div>
      {removing && data ? (
        <DisconnectDrawer
          storeId={storeId}
          openLinks={data.openLinks}
          onClose={() => setRemoving(false)}
        />
      ) : null}
      {keys ? (
        <KeysDrawer
          storeId={storeId}
          currency={currency}
          mode={keys}
          onClose={() => setKeys(null)}
        />
      ) : null}
    </section>
  )
}

/** El panel de Mercado Pago Developers, donde la tienda tiene su aplicación y sus credenciales. */
const MP_PANEL = "https://www.mercadopago.com.pe/developers/panel/app"

const keysShape = z.object({ accessToken: z.string() })

/**
 * «Usar mis propias claves»: la tienda copia el Access Token de su aplicación en Mercado Pago
 * Developers y lo pega. Los pasos usan los nombres que ve en su panel. «Probar» pregunta a Mercado
 * Pago de qué cuenta es, sin guardar; conectar lo vuelve a revisar. Lo pegado nunca vuelve: el
 * servidor lo guarda cifrado.
 */
function KeysDrawer({
  storeId,
  currency,
  mode,
  onClose,
}: {
  storeId: string
  currency: string
  mode: "prueba" | "real"
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const real = mode === "real"
  const save = useMutation({
    mutationFn: (accessToken: string) =>
      api<{ account: string | null }>(`/api/tiendas/${storeId}/link-de-pago/claves`, {
        method: "POST",
        body: { mode, accessToken },
      }),
  })
  // Lo que dijo «Probar», para el token que se probó: si cambia lo pegado, ya no vale.
  const [tried, setTried] = useState<{ token: string; account: string | null } | null>(null)
  const form = useAppForm({
    defaultValues: { accessToken: "" },
    validators: { onSubmit: keysShape },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value.accessToken)
      await queryClient.invalidateQueries({ queryKey: LINK_KEY(storeId) })
      toast.success(
        real
          ? "Listo: ya cobras de verdad con Mercado Pago"
          : "Mercado Pago conectado en modo prueba",
      )
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const token = useStore(form.store, (s) => s.values.accessToken).trim()
  const probe = useMutation({
    mutationFn: (accessToken: string) =>
      api<{ account: string | null }>(`/api/tiendas/${storeId}/link-de-pago/claves/probar`, {
        method: "POST",
        body: { mode, accessToken },
      }),
    onSuccess: ({ account }, accessToken) => {
      clearSubmitErrors(form, (name) => name === "accessToken")
      setTried({ token: accessToken, account })
    },
    onError: (error) => {
      setTried(null)
      const fields = error instanceof ApiError ? error.shape.fields : {}
      if (fields.accessToken) addSubmitErrors(form, { accessToken: fields.accessToken })
      else toast.error(submitErrorMessage(error))
    },
  })
  const proven = tried && tried.token === token ? tried : null
  const where = real ? "Producción" : "Prueba"

  return (
    <FormDrawer
      {...surface}
      open
      title={real ? "Cobrar de verdad con tus claves" : "Conectar con tus claves"}
      description={
        real
          ? "Con el Access Token de producción, Sofi ofrece el link y cada pedido pagado queda pagado solo."
          : `Con el Access Token de prueba nada se cobra de verdad: pruebas con un link de ${money(trialCents(currency), currency)}.`
      }
      onClose={onClose}
      submitLabel={real ? "Cobrar de verdad" : "Conectar en modo prueba"}
    >
      <FieldGroup className="gap-5">
        <ol className="flex flex-col gap-3 text-sm">
          <KeysStep n={1}>
            Entra a tu panel de Mercado Pago Developers con tu cuenta de Mercado Pago y abre{" "}
            {"«Tus integraciones»"}.{" "}
            <a
              href={MP_PANEL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Abrir mi panel
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </KeysStep>
          <KeysStep n={2}>
            Elige tu aplicación. Si todavía no tienes una, créala con el nombre de tu tienda y elige
            Checkout Pro.
          </KeysStep>
          <KeysStep n={3}>
            En el menú de la izquierda abre «Credenciales» y, arriba, elige «{where}».
            {real
              ? " Si te pide «Activar ambiente de producción», complétalo con el rubro y la web de tu tienda."
              : null}
          </KeysStep>
          <KeysStep n={4}>Copia el «Access Token» (no la «Public Key») y pégalo aquí.</KeysStep>
        </ol>
        <form.AppField name="accessToken">
          {(field) => (
            <field.TextField
              label={real ? "Access Token de producción" : "Access Token de prueba"}
              placeholder="APP_USR-…"
              autoComplete="off"
              spellCheck={false}
              inputClassName="font-mono text-xs"
              description="Lo guardamos cifrado y no se vuelve a mostrar. gestorIA lo usa solo para crear tus links de pago y ver si se pagaron."
            />
          )}
        </form.AppField>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!token || probe.isPending}
            aria-busy={probe.isPending || undefined}
            onClick={() => probe.mutate(token)}
          >
            {probe.isPending ? "Preguntando a Mercado Pago…" : "Probar"}
          </Button>
          <span role="status" className="text-sm">
            {proven ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <Check aria-hidden className="size-4 shrink-0" />
                {proven.account
                  ? `Sirve: es la cuenta ${proven.account}`
                  : "Sirve: Mercado Pago la reconoce"}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Pregunta a Mercado Pago si sirve y de qué cuenta es, sin guardar.
              </span>
            )}
          </span>
        </div>
      </FieldGroup>
    </FormDrawer>
  )
}

function KeysStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold"
      >
        {n}
      </span>
      <span className="min-w-0 pt-0.5">{children}</span>
    </li>
  )
}

/** «Probar con S/ 1»: los pasos de la prueba, cada uno cuando de verdad pasó. */
function TrialPanel({ trial, currency }: { trial: LinkStatus["trial"]; currency: string }) {
  const paid = Boolean(trial?.paidAt)
  const steps: { done: boolean; text: string }[] = [
    { done: Boolean(trial), text: "Creamos el link en tu Mercado Pago" },
    { done: paid, text: "Lo pagas con la tarjeta de prueba de Mercado Pago" },
    {
      done: paid,
      text: paid
        ? `Mercado Pago nos avisó y le preguntamos si entró: entró ${money(trial?.paidCents ?? 0, currency)}`
        : "Mercado Pago nos avisa y le preguntamos si entró",
    },
    { done: paid, text: "Queda pagado, sin que nadie confirme" },
  ]
  return (
    <div className="flex flex-col gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <b className="flex-1 text-sm">
          {trial ? `Link de prueba · ${money(trial.amountCents, currency)}` : "La prueba"}
        </b>
        {trial?.paidAt ? (
          <Badge variant="success">Pagado solo · {when(trial.paidAt)}</Badge>
        ) : trial ? (
          <Badge variant="outline">Esperando el pago</Badge>
        ) : null}
      </div>
      <ol className="flex flex-col gap-1.5 text-sm">
        {steps.map((step) => (
          <li key={step.text} className="flex items-center gap-2">
            {step.done ? (
              <Check aria-hidden className="size-4 shrink-0 text-success" />
            ) : (
              <CircleDashed aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={step.done ? undefined : "text-muted-foreground"}>
              {step.text}
              <span className="sr-only">{step.done ? " (hecho)" : " (falta)"}</span>
            </span>
          </li>
        ))}
      </ol>
      {trial && !paid ? (
        <a
          href={trial.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ExternalLink aria-hidden className="size-4" />
          Abrir el link de prueba
        </a>
      ) : null}
      <p className="text-xs text-muted-foreground">
        En modo prueba, Sofi no manda links a tus clientas y los pedidos se cobran a tu número o al
        recibir. Cuando te guste, toca «Cobrar de verdad».
      </p>
    </div>
  )
}

/** Desconectar se confirma antes, en un cajón: dice qué pasa con los links ya enviados. */
function DisconnectDrawer({
  storeId,
  openLinks,
  onClose,
}: {
  storeId: string
  openLinks: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api(`/api/tiendas/${storeId}/link-de-pago`, { method: "DELETE" }),
  })
  return (
    <FormDrawer
      open
      dock={false}
      title="Desconectar Mercado Pago"
      onClose={onClose}
      submitLabel="Desconectar"
      isSubmitting={remove.isPending}
      error={remove.isError ? submitErrorMessage(remove.error) : null}
      onSubmit={(event) => {
        event.preventDefault()
        remove.mutate(undefined, {
          onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: LINK_KEY(storeId) })
            toast.success("Mercado Pago desconectado")
            onClose()
          },
        })
      }}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>
          {openLinks > 0
            ? `${openLinks === 1 ? "1 link enviado ya no se confirmará solo" : `${openLinks} links enviados ya no se confirmarán solos`}: si la clienta paga, el dinero llega a tu Mercado Pago y ese pago lo revisas tú.`
            : "No hay links enviados esperando pago."}
        </p>
        <p className="text-muted-foreground">
          Sofi deja de ofrecer el link. Tu cuenta de Mercado Pago no cambia: puedes volver a
          conectarla cuando quieras.
        </p>
      </div>
    </FormDrawer>
  )
}

/* ------------------------------------------------------ las formas que confirma una persona */

type Kind = Exclude<PaymentKind, "link">

const KIND_OPTIONS = (Object.keys(KINDS) as Kind[]).map((kind) => ({
  value: kind,
  label: KINDS[kind].name,
}))

const formShape = z.object({
  kind: z.custom<Kind>(),
  phone: z.string().nullable(),
  holder: z.string(),
  bankCode: z.string(),
  accountNumber: z.string(),
  cci: z.string(),
  name: z.string(),
  typeCode: z.custom<PaymentTypeCode>(),
  collection: z.enum(["comprobante", "al_recibir"]),
  details: z.string(),
  isActive: z.boolean(),
  qr: z.custom<QrChoice>(),
})
type FormValues = z.infer<typeof formShape>

/** Lo que falta o está mal, dicho en su campo al guardar (el CCI, contra la lista de bancos). */
function formSchemaOf(banks: Bank[]) {
  return formShape.superRefine((v, ctx) => {
    const need = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message })
    if (v.kind === "yape" || v.kind === "plin") {
      if (!v.phone) need("phone", "Escribe el celular con el que cobras")
      if (!v.holder.trim()) need("holder", "Escribe a nombre de quién está, como aparece en la app")
    }
    if (v.kind === "transferencia") {
      if (!v.bankCode) need("bankCode", "Elige tu banco de la lista")
      if (!v.accountNumber.trim()) need("accountNumber", "Escribe el número de cuenta")
      if (!v.holder.trim()) need("holder", "Escribe a nombre de quién está la cuenta")
      const issue = cciIssue(v.cci, v.bankCode, banks)
      if (issue) need("cci", issue)
    }
    if (v.kind === "otro" && !v.name.trim()) need("name", "Escribe cómo lo dirá Sofi")
  })
}

/** El QR elegido: una imagen nueva, quitar el que había, o dejarlo como está. */
type QrChoice = { blob: Blob; url: string } | "quitar" | null

/** Lo que va al servidor según la forma: solo sus datos. */
function bodyOf(v: FormValues) {
  switch (v.kind) {
    case "yape":
    case "plin":
      return { kind: v.kind, phone: v.phone, holder: v.holder, isActive: v.isActive }
    case "transferencia":
      return {
        kind: v.kind,
        bankCode: v.bankCode,
        accountNumber: v.accountNumber,
        cci: cciDigits(v.cci),
        holder: v.holder,
        isActive: v.isActive,
      }
    case "efectivo":
    case "pos":
      return { kind: v.kind, details: v.details, isActive: v.isActive }
    default:
      return {
        kind: "otro",
        name: v.name,
        typeCode: v.typeCode,
        collection: v.collection,
        details: v.details,
        isActive: v.isActive,
      }
  }
}

function PaymentForm({
  storeId,
  currency,
  banks,
  method,
  onClose,
}: {
  storeId: string
  currency: string
  banks: Bank[]
  method: PaymentMethod | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  // Si se creó y falló después (subir el QR), el reintento cambia la misma: no crea otra.
  const created = useRef<string | null>(null)
  const save = useMutation({
    mutationFn: async (value: FormValues) => {
      const body = bodyOf(value)
      const id = method?.id ?? created.current
      const saved = id
        ? await api<{ method: PaymentMethod }>(`/api/tiendas/${storeId}/medios-de-pago/${id}`, {
            method: "PATCH",
            body,
          })
        : await api<{ method: PaymentMethod }>(`/api/tiendas/${storeId}/medios-de-pago`, {
            method: "POST",
            body,
          })
      created.current = saved.method.id
      const wallet = value.kind === "yape" || value.kind === "plin"
      const qrPath = `/api/tiendas/${storeId}/medios-de-pago/${saved.method.id}/qr`
      if (wallet && value.qr && value.qr !== "quitar")
        await api(qrPath, {
          method: "POST",
          raw: { type: value.qr.blob.type, data: value.qr.blob },
        })
      if (wallet && value.qr === "quitar" && method?.qrAt) await api(qrPath, { method: "DELETE" })
      return saved.method
    },
  })
  const initialKind: Kind = method && method.kind !== "link" ? method.kind : "yape"
  const schema = useMemo(() => formSchemaOf(banks), [banks])
  const form = useAppForm({
    defaultValues: {
      kind: initialKind,
      phone: method?.phone ?? null,
      holder: method?.holder ?? "",
      bankCode: method?.bankCode ?? "",
      accountNumber: method?.accountNumber ?? "",
      cci: method?.cci ? cciText(method.cci) : "",
      name: method?.kind === "otro" ? method.name : "",
      typeCode: (method?.kind === "otro" ? method.typeCode : "68") as PaymentTypeCode,
      collection: (method?.kind === "otro" && method.collection === "al_recibir"
        ? "al_recibir"
        : "comprobante") as "comprobante" | "al_recibir",
      details:
        method?.kind === "otro" || method?.kind === "efectivo" || method?.kind === "pos"
          ? method.details
          : "",
      isActive: method?.isActive ?? true,
      qr: null as QrChoice,
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(method ? "Guardado" : `${KINDS[value.kind].name}: agregado`)
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const values = useStore(form.store, (s) => s.values)
  const kind = values.kind
  const wallet = kind === "yape" || kind === "plin"

  // El CCI completo se juzga mientras se escribe (y al cambiar de banco), como error del campo: rojo
  // y `aria-invalid`. Uno a medias se dice al salir del campo o al guardar.
  useEffect(() => {
    if (kind !== "transferencia" || !cciReady(values.cci)) return
    const issue = cciIssue(values.cci, values.bankCode, banks)
    if (issue) addSubmitErrors(form, { cci: issue })
    else clearSubmitErrors(form, (name) => name === "cci")
  }, [form, kind, values.cci, values.bankCode, banks])

  return (
    <FormDrawer
      {...surface}
      open
      title={method ? method.name : "Agregar forma de cobro"}
      description={method ? whoConfirms(method) : "Lo que confirma una persona de tu equipo."}
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        {method ? null : (
          <form.AppField name="kind">
            {(field) => (
              <field.Group legend="¿Cómo te paga?">
                {(control) => (
                  <RadioChips
                    id={control.id}
                    aria-label="¿Cómo te paga?"
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    options={KIND_OPTIONS}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        )}

        {wallet ? (
          <>
            <form.AppField name="phone">
              {(field) => (
                <field.PhoneField
                  label="Celular"
                  defaultCountry="PE"
                  countries={["PE"]}
                  description={`El número con el que cobras en ${KINDS[kind].name}.`}
                />
              )}
            </form.AppField>
            <form.AppField name="holder">
              {(field) => (
                <field.TextField
                  label="A nombre de"
                  maxLength={80}
                  placeholder="Rosa Quispe M."
                  description={`Como aparece en ${KINDS[kind].name}: la clienta lo compara antes de pagar.`}
                />
              )}
            </form.AppField>
            <form.AppField name="qr">
              {(field) => (
                <field.Control
                  label="Tu QR"
                  description={
                    kind === "yape"
                      ? "Lo bajas en Yape › Mi QR. Suéltalo aquí o pégalo con Ctrl+V."
                      : "Lo bajas en tu app de Plin. Suéltalo aquí o pégalo con Ctrl+V."
                  }
                >
                  {(control) => (
                    <QrPicker
                      control={control}
                      storeId={storeId}
                      current={method?.qrAt ? { id: method.id, at: method.qrAt } : null}
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
            <div className="flex flex-col gap-1.5 rounded-lg bg-surface-muted px-4 py-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Así lo recibe la clienta
              </span>
              <p className="text-sm">
                {walletPreview(kind, values.phone, values.holder, money(14100, currency))}
              </p>
              <p className="text-xs text-muted-foreground">
                Tu QR queda guardado: Sofi lo enviará cuando el chat por WhatsApp esté conectado.
              </p>
            </div>
          </>
        ) : null}

        {kind === "transferencia" ? (
          <>
            <form.AppField name="bankCode">
              {(field) => (
                <field.SelectField
                  label="Banco"
                  placeholder="Elige tu banco"
                  options={banks.map((bank) => ({ value: bank.code, label: bank.name }))}
                />
              )}
            </form.AppField>
            <form.AppField name="accountNumber">
              {(field) => (
                <field.TextField
                  label="Número de cuenta"
                  inputMode="numeric"
                  maxLength={30}
                  placeholder="191-2345678-0-12"
                />
              )}
            </form.AppField>
            <form.AppField
              name="cci"
              listeners={{
                onBlur: ({ value }) => {
                  const issue = cciIssue(value, form.getFieldValue("bankCode"), banks)
                  if (issue) addSubmitErrors(form, { cci: issue })
                },
              }}
            >
              {(field) => (
                <field.TextField
                  label="CCI (opcional)"
                  inputMode="numeric"
                  maxLength={26}
                  placeholder="002 191 002345678012 53"
                  description={
                    <CciHint value={field.state.value} bankCode={values.bankCode} banks={banks} />
                  }
                />
              )}
            </form.AppField>
            <form.AppField name="holder">
              {(field) => (
                <field.TextField
                  label="A nombre de"
                  maxLength={80}
                  placeholder="Rosa Quispe Mamani"
                  description="Como figura en el banco."
                />
              )}
            </form.AppField>
          </>
        ) : null}

        {kind === "otro" ? (
          <>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Nombre"
                  maxLength={80}
                  description="Como lo dirá Sofi a la clienta, por ejemplo «Agente BCP»."
                />
              )}
            </form.AppField>
            <form.AppField name="typeCode">
              {(field) => (
                <field.SelectField
                  label="Con qué paga"
                  options={(Object.keys(PAYMENT_TYPES) as PaymentTypeCode[]).map((code) => ({
                    value: code,
                    label: PAYMENT_TYPES[code],
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField name="collection">
              {(field) => (
                <field.Group legend="Cuándo paga">
                  {(control) => (
                    <RadioChips
                      id={control.id}
                      aria-label="Cuándo paga"
                      value={field.state.value}
                      options={[
                        { value: "comprobante", label: "Antes, con captura" },
                        { value: "al_recibir", label: "Al recibir" },
                      ]}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
          </>
        ) : null}

        {kind === "otro" || kind === "efectivo" || kind === "pos" ? (
          <form.AppField name="details">
            {(field) => (
              <field.TextareaField
                label={kind === "otro" ? "Lo que envía Sofi para pagar" : "Nota para Sofi"}
                rows={2}
                maxLength={kind === "otro" ? 500 : 300}
                placeholder={
                  kind === "pos"
                    ? "Kevin lleva el POS de la tienda"
                    : kind === "efectivo"
                      ? "Solo en tus zonas de Lima, con tu repartidor"
                      : ""
                }
              />
            )}
          </form.AppField>
        ) : null}

        <form.AppField name="isActive">
          {() => (
            <ToggleField
              label={(on) => (on ? "Encendido: Sofi lo ofrece" : "Apagado: Sofi no lo ofrece")}
            />
          )}
        </form.AppField>
        {method ? (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-danger"
            onClick={() => setRemoving(true)}
          >
            <Trash2 aria-hidden />
            Borrar
          </Button>
        ) : null}
      </FieldGroup>
      {removing && method ? (
        <DeleteDrawer
          storeId={storeId}
          method={method}
          onClose={() => setRemoving(false)}
          onDone={onClose}
        />
      ) : null}
    </FormDrawer>
  )
}

/**
 * La ayuda del CCI mientras se escribe: cuántos números lleva, o que está revisado. Lo que está mal
 * no va aquí: es el error del campo (`cciIssue`).
 */
function CciHint({ value, bankCode, banks }: { value: string; bankCode: string; banks: Bank[] }) {
  const digits = cciDigits(value).length
  if (cciCheck(value) === "ok" && !cciIssue(value, bankCode, banks))
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <Check aria-hidden className="size-3.5" />
        20 números, con sus dígitos de control revisados.
      </span>
    )
  if (digits > 0 && digits < 20)
    return `Llevas ${digits} de 20 números. Para que te transfieran desde otro banco.`
  return "Para que te transfieran desde otro banco. Lo revisamos con sus dígitos de control."
}

/**
 * El QR: se suelta, se pega o se elige. No se encuadra (lo que baja la app ya es el QR): se achica
 * y se sube al guardar. Muestra el de antes hasta que se cambie o se quite.
 */
function QrPicker({
  control,
  storeId,
  current,
  value,
  onChange,
}: {
  control: { id: string; describedBy?: string; invalid: boolean }
  storeId: string
  current: { id: string; at: string } | null
  value: QrChoice
  onChange: (value: QrChoice) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = useQuery({
    queryKey: ["qr", storeId, current?.id, current?.at],
    queryFn: () =>
      api<Blob>(
        `/api/tiendas/${storeId}/medios-de-pago/${current?.id}/qr?v=${encodeURIComponent(current?.at ?? "")}`,
        { as: "blob" },
      ),
    enabled: Boolean(current) && value === null,
  })
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!saved.data) return
    const url = URL.createObjectURL(saved.data)
    setSavedUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [saved.data])
  const take = async (file: File | undefined | null) => {
    if (!file) return
    setProblem(null)
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setProblem("Usa la imagen del QR en PNG, JPG o WebP.")
      return
    }
    try {
      const blob = file.size > 1_000_000 ? await shrinkPhoto(file) : file
      if (value && value !== "quitar") URL.revokeObjectURL(value.url)
      onChange({ blob, url: URL.createObjectURL(blob) })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "No se pudo abrir esa imagen.")
    }
  }
  const shown = value && value !== "quitar" ? value.url : value === null ? savedUrl : null
  const hintId = useId()
  // Pegar (Ctrl+V) una imagen con el formulario abierto la toma como QR, salvo que se esté
  // escribiendo en un campo: así no hace falta apuntar a una zona.
  const takeRef = useRef(take)
  takeRef.current = take
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable='true']")) return
      const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      )
      if (!file) return
      event.preventDefault()
      void takeRef.current(file)
    }
    document.addEventListener("paste", paste)
    return () => document.removeEventListener("paste", paste)
  }, [])
  return (
    <section
      id={control.id}
      aria-labelledby={hintId}
      aria-describedby={control.describedBy}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void take(event.dataTransfer.files[0])
      }}
      className={cn(
        "flex items-center gap-4 rounded-xl border-2 border-dashed p-3",
        dragging
          ? "border-primary bg-primary-soft"
          : control.invalid
            ? "border-destructive"
            : "border-border",
      )}
    >
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          void take(event.target.files?.[0])
          event.target.value = ""
        }}
      />
      {shown ? (
        <img
          src={shown}
          alt="Tu QR"
          className="size-24 shrink-0 rounded-lg border bg-white object-contain p-1"
        />
      ) : (
        <span className="flex size-24 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ImageUp aria-hidden className="size-7" />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <p id={hintId} className="text-sm text-muted-foreground">
          {shown
            ? value && value !== "quitar"
              ? "Se guarda al tocar «Guardar»."
              : "Guardado en tu tienda."
            : "Suelta la imagen aquí o pégala."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            {shown ? "Cambiar" : "Elegir imagen"}
          </Button>
          {shown ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(current ? "quitar" : null)}
            >
              Quitar
            </Button>
          ) : (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <Clipboard aria-hidden className="size-3.5" />
              Ctrl+V
            </span>
          )}
        </div>
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Borrar se confirma en un cajón: Sofi deja de ofrecerlo. */
function DeleteDrawer({
  storeId,
  method,
  onClose,
  onDone,
}: {
  storeId: string
  method: PaymentMethod
  onClose: () => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${storeId}/medios-de-pago/${method.id}`, { method: "DELETE" }),
  })
  return (
    <FormDrawer
      open
      dock={false}
      title={`¿Borrar «${method.name}»?`}
      onClose={onClose}
      submitLabel="Borrar"
      isSubmitting={remove.isPending}
      error={remove.isError ? submitErrorMessage(remove.error) : null}
      onSubmit={(event) => {
        event.preventDefault()
        remove.mutate(undefined, {
          onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
            toast.success(`${method.name}: borrado`)
            onClose()
            onDone()
          },
        })
      }}
    >
      <p className="text-sm">
        Sofi deja de ofrecerlo y se borran sus datos{method.qrAt ? " y su QR" : ""}. Si solo es por
        un tiempo, mejor apágalo. Los pedidos que ya se cobraron así no cambian.
      </p>
    </FormDrawer>
  )
}

/* -------------------------------------------------------------------- la regla, al pie */

const RULES: { how: string; who: string; when: string }[] = [
  {
    how: "Con su link (Yape o tarjeta), antes o en la puerta",
    who: "La pasarela, sola",
    when: "Al instante",
  },
  { how: "Efectivo en la puerta", who: "El repartidor, al recibirlo", when: "Al instante" },
  {
    how: "Tarjeta con el POS de la tienda",
    who: "El repartidor, con la foto del voucher",
    when: "Al instante",
  },
  {
    how: "Yape, Plin o transferencia a la tienda",
    who: "Una persona de la tienda, con la captura",
    when: "Cuando la tienda confirma",
  },
]

function ConfirmTable() {
  return (
    <section
      aria-labelledby="cobros-regla"
      className="@container elevated overflow-hidden rounded-xl border bg-card"
    >
      <div className="px-5 py-4">
        <h2 id="cobros-regla" className="text-base font-semibold">
          Quién confirma cada pago
        </h2>
        <p className="text-sm text-muted-foreground">
          Sin pago confirmado no se entrega. Sofi ofrece primero el link, después Yape o Plin a tu
          número y al final pagar al recibir, solo donde tu entrega lo acepta.
        </p>
      </div>
      <table className="w-full border-t text-sm">
        <thead className="hidden bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground @2xl:table-header-group">
          <tr>
            <th scope="col" className="px-5 py-2.5">
              Cómo paga la clienta
            </th>
            <th scope="col" className="px-5 py-2.5">
              Quién lo confirma
            </th>
            <th scope="col" className="px-5 py-2.5">
              Cuándo se puede entregar
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {RULES.map((rule) => (
            <tr key={rule.how} className="flex flex-col gap-0.5 px-5 py-3 @2xl:table-row @2xl:p-0">
              <th scope="row" className="text-left font-medium @2xl:px-5 @2xl:py-3">
                {rule.how}
              </th>
              <td className="text-muted-foreground @2xl:px-5 @2xl:py-3 @2xl:text-foreground">
                <span className="@2xl:hidden">Lo confirma: </span>
                {rule.who}
              </td>
              <td className="text-muted-foreground @2xl:px-5 @2xl:py-3 @2xl:text-foreground">
                <span className="@2xl:hidden">Se entrega: </span>
                {rule.when}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
