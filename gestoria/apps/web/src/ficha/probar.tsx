import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useIsMobile,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { DetailDrawer, ErrorState, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronUp, CircleAlert, Info, RotateCcw, Store } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { api } from "../lib/api"
import { helpPanel } from "../lib/ayuda"
import { anchorOf } from "../lib/ficha"
import { type AnswerStatus, type ConversationView, type SofiOverview, usd } from "../lib/sofi"
import {
  type CartLine,
  type CartQuote,
  type Choice,
  firstChoice,
  type Showcase,
  type TestCart,
} from "../lib/vitrina"
import { ChatPhone } from "../vitrina/chat"
import { type SheetKind, Sheets } from "../vitrina/hojas"
import { PhoneFrame } from "../vitrina/marcos"
import { ProductPhone } from "../vitrina/producto"
import { useFichaContext } from "./contexto"
import { goTo, SofiDot } from "./piezas"

/**
 * «Probar como clienta» (lienzo «La ficha del producto», tablero 11; prototipo aprobado
 * `ficha/probar.tsx`): lo mismo que vive la clienta con un producto, en su celular. «WhatsApp»
 * es el chat con Sofi y «Vitrina», la página del producto por link, con el mismo carrito.
 *
 * Es la conversación de prueba de siempre (canal «prueba»): pasa por la misma Sofi de un chat de
 * verdad (`apps/api/src/sofi/`), con sus herramientas, el precio de `precio.ts`, la única oferta
 * con plazo y la revisión antes de salir. No mueve stock, no cobra (el pago se simula y lo dice),
 * no se entrega, no avisa y no cuenta en Pedidos, Reportes ni Argos: no es una venta. Nunca es un
 * panel aparte de preguntas: la ficha la abre al lado y Configuración › Sofi la muestra con un
 * selector de producto (`ClientTestPiece`), las dos con esta misma pieza.
 */

export const VIEW_KEY = (storeId: string, id: string | null) => ["conversacion", storeId, id]
export const SHOWCASE_KEY = (storeId: string, productId: string) => ["vitrina", storeId, productId]
const CART_KEY = (storeId: string, id: string | null) => ["carrito-prueba", storeId, id]

/** La prueba de cada producto sigue abierta al volver (en este navegador), en la ficha y en Sofi. */
function useTestId(storeId: string, productId: string) {
  const key = `gestoria.prueba.${storeId}.${productId}`
  const read = () => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }
  const [state, setState] = useState<{ key: string; id: string | null }>(() => ({
    key,
    id: read(),
  }))
  // Otro producto (el selector de Configuración): su propia prueba.
  const id = state.key === key ? state.id : read()
  const save = (next: string | null) => {
    setState({ key, id: next })
    try {
      if (next) window.sessionStorage.setItem(key, next)
      else window.sessionStorage.removeItem(key)
    } catch {}
  }
  return [id, save] as const
}

export function useShowcase(storeId: string, productId: string) {
  return useQuery({
    queryKey: SHOWCASE_KEY(storeId, productId),
    queryFn: () => api<Showcase>(`/api/tiendas/${storeId}/productos/${productId}/vitrina`),
    // Los enlaces de las fotos vencen a los 10 minutos.
    staleTime: 4 * 60_000,
    refetchInterval: 8 * 60_000,
  })
}

/** Lo que podría escribir la clienta, según cómo va la conversación. */
function suggestions(
  page: Showcase,
  view: ConversationView | null,
  cart: TestCart | null,
  extra: string[],
) {
  const said = (view?.messages ?? []).filter((m) => m.author === "sofi")
  const last = said.at(-1)?.text.toLowerCase() ?? ""
  if (cart?.state === "por_pagar") return []
  if (cart?.paid) return last.includes("¿te sumo") ? ["Sí, súmalo", "No, gracias"] : []
  const color = page.product.colors.at(-1)?.value
  const size = page.product.sizes[Math.min(3, page.product.sizes.length - 1)]
  const want = `Quiero la ${color ? `${color} ` : ""}${size ? `en ${size}` : ""}`.trim()
  if (said.length === 0)
    return [
      color ? `¿Tienes la ${color}${size ? ` en ${size}` : ""}?` : "¿Qué colores tienes?",
      ...(page.media.videos.length ? ["¿Tienes video de cómo se ve puesta?"] : []),
      "¿Me haces precio?",
      want,
      ...extra,
    ]
  if (last.includes("envío gratis") && last.includes("si lo pagas"))
    return ["Envío gratis", "Lo voy a pensar"]
  if (last.includes("¿lo confirmo")) return ["Sí, confirmo"]
  return ["¿Me haces precio?", "Lo voy a pensar", want, ...extra]
}

/** Lo que sabe Sofi de este producto, para «Qué usó Sofi» (la ficha da también lo que falta). */
export interface TestReadiness {
  done: number
  total: number
  sellsAlone: boolean
  /** Lo que todavía no sabe; solo dentro de la ficha. */
  unknown?: string[]
}

export interface ClientTestProps {
  storeId: string
  productId: string
  readiness: TestReadiness | null
  /** Cambia la ficha: «Completar» lo que le faltó. */
  edit: boolean
  /** Lleva al dato de la ficha del que salió una respuesta (o a «Lo que Sofi no supo»). */
  onGo: (target: string) => void
  /** Más ideas de lo que podría escribir la clienta (Configuración: cambios, una persona). */
  extraQuick?: string[]
  /** El alto del celular: lo decide quien lo muestra (el cajón de la ficha o Configuración). */
  phoneClassName: string
  /**
   * En el cajón del teléfono: todo en una fila arriba y el chat sin su cabecera, para que la
   * conversación tenga más de la mitad del alto.
   */
  compact?: boolean
}

/**
 * La pieza de «Probar como clienta»: la cabecera (WhatsApp o Vitrina, empezar de nuevo), el
 * celular con su chat, la vitrina y sus hojas, y «Qué usó Sofi» con el «Por qué» de la última
 * respuesta. Quien la usa decide dónde va cada parte.
 */
function useClientTest({
  storeId,
  productId,
  readiness,
  edit,
  onGo,
  extraQuick = [],
  phoneClassName,
  compact = false,
}: ClientTestProps): { header: ReactNode; body: ReactNode; footer: ReactNode } {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useTestId(storeId, productId)
  const [tab, setTab] = useState<"chat" | "vitrina">("chat")
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const [lines, setLines] = useState<CartLine[]>([])
  const [deliveryId, setDeliveryId] = useState<string | null>(null)
  const [zone, setZone] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const showcase = useShowcase(storeId, productId)
  const page = showcase.data?.product.id === productId ? showcase.data : null
  const [chosen, setChoice] = useState<{ productId: string; choice: Choice } | null>(null)
  const choice = chosen?.productId === productId ? chosen.choice : page ? firstChoice(page) : null
  const choose = (next: Choice) => setChoice({ productId, choice: next })
  // Otro producto: su carrito de la vitrina empieza vacío.
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de producto
  useEffect(() => {
    setLines([])
    setSheet(null)
    setTab("chat")
  }, [productId])
  const overview = useQuery({
    queryKey: ["sofi", storeId],
    queryFn: () => api<SofiOverview>(`/api/tiendas/${storeId}/sofi`),
  })
  const view = useQuery({
    queryKey: VIEW_KEY(storeId, conversationId),
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (
        await api<{ conversation: ConversationView }>(
          `/api/tiendas/${storeId}/conversaciones/${conversationId}`,
        )
      ).conversation,
  })
  const cart = useQuery({
    queryKey: CART_KEY(storeId, conversationId),
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (
        await api<{ cart: TestCart | null }>(
          `/api/tiendas/${storeId}/conversaciones/${conversationId}/carrito`,
        )
      ).cart,
  })
  // Una prueba que ya no está (se borró la tienda de ejemplo, otra sesión): se empieza otra.
  useEffect(() => {
    if (view.isError && (view.error as { status?: number }).status === 404) setConversationId(null)
  }, [view.isError, view.error, setConversationId])

  // En la vitrina se elige lo que tiene precio: lo que «se acuerda» se ve con Sofi en el chat.
  const delivery =
    page?.store.deliveries.find((d) => d.id === deliveryId && d.cost !== "se_acuerda") ??
    page?.store.deliveries.find((d) => d.cost !== "se_acuerda") ??
    null
  const order = cart.data ?? null
  const openOrder = order?.state === "por_pagar" ? order : null
  // Lo que cuesta lo elegido en la vitrina lo dice el servidor, con la misma cuenta de «Pagar
  // ahora» (precio por cantidad, promociones, revendedora, envío gratis de su zona).
  const quote = useQuery({
    queryKey: ["carrito-vitrina", storeId, lines, delivery?.id ?? null, zone],
    enabled: !openOrder && lines.length > 0 && Boolean(delivery),
    queryFn: () =>
      api<{ quote: CartQuote | null; problem: string | null }>(
        `/api/tiendas/${storeId}/vitrina/carrito/calcular`,
        { method: "POST", body: { lines, deliveryMethodId: delivery?.id, zone } },
      ),
  })
  // Una cotización de otro carrito (mientras llega la nueva) no da total: no se muestra uno que cambia.
  const quoteFresh = quote.data ?? null

  const begin = async () => {
    if (conversationId) return conversationId
    const { id } = await api<{ id: string }>(`/api/tiendas/${storeId}/sofi/pruebas`, {
      method: "POST",
    })
    setConversationId(id)
    return id
  }
  const refreshCart = (id: string) =>
    queryClient.invalidateQueries({ queryKey: CART_KEY(storeId, id) })

  const send = useMutation({
    mutationFn: async (text: string) => {
      const id = await begin()
      return api<{ conversation: ConversationView; result: { status: AnswerStatus } }>(
        `/api/tiendas/${storeId}/conversaciones/${id}/cliente`,
        { method: "POST", body: { text, desde: productId, carrito: lines } },
      )
    },
    onMutate: (text) => setPending(text),
    onSuccess: async (data) => {
      queryClient.setQueryData(VIEW_KEY(storeId, data.conversation.id), data.conversation)
      await refreshCart(data.conversation.id)
    },
    onSettled: () => setPending(null),
  })
  const checkout = useMutation({
    mutationFn: async () => {
      if (openOrder) return openOrder
      const id = await begin()
      const placed = await api<{ cart: TestCart }>(
        `/api/tiendas/${storeId}/conversaciones/${id}/carrito`,
        { method: "POST", body: { lines, deliveryMethodId: delivery?.id, zone } },
      )
      queryClient.setQueryData(CART_KEY(storeId, id), placed.cart)
      setLines([])
      return placed.cart
    },
    onSuccess: () => setSheet("pago"),
  })
  const pay = useMutation({
    mutationFn: (paymentMethodId: string) =>
      api<{ conversation: ConversationView; cart: TestCart | null }>(
        `/api/tiendas/${storeId}/conversaciones/${conversationId}/pagar`,
        { method: "POST", body: { orderId: cart.data?.id, paymentMethodId } },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(VIEW_KEY(storeId, data.conversation.id), data.conversation)
      queryClient.setQueryData(CART_KEY(storeId, data.conversation.id), data.cart)
      setSheet("pedido")
    },
  })
  const giveBack = useMutation({
    mutationFn: () =>
      api<{ conversation: ConversationView }>(
        `/api/tiendas/${storeId}/conversaciones/${conversationId}/devolver`,
        { method: "POST" },
      ),
    onSuccess: (data) =>
      queryClient.setQueryData(VIEW_KEY(storeId, data.conversation.id), data.conversation),
  })

  const restart = () => {
    setConversationId(null)
    setLines([])
    setSheet(null)
    setTab("chat")
    if (page) choose(firstChoice(page))
    send.reset()
    checkout.reset()
    pay.reset()
    giveBack.reset()
  }

  const messages = view.data?.messages ?? []
  const lastSofi = [...messages].reverse().find((m) => m.author === "sofi")
  const used = lastSofi?.used ?? []
  const missed = lastSofi?.missed ?? []
  const basis = lastSofi?.basis
  const why = basis
    ? [
        ...basis.why,
        ...basis.stopped
          .slice(0, 1)
          .map(() => "La comprobación frenó una respuesta y la corrigió."),
      ]
    : []
  const unknown = readiness?.unknown ?? []
  const count = openOrder
    ? openOrder.lines.reduce((n, l) => n + l.quantity, 0)
    : lines.reduce((n, l) => n + l.quantity, 0)
  const handedOff = view.data?.handler === "persona"
  const blocked = !overview.data
    ? null
    : !overview.data.modelReady
      ? "Sofi todavía no puede responder: falta configurar su modelo en el servidor."
      : handedOff
        ? "Sofi la pasó a una persona. Devuélvesela o empieza de nuevo para seguir probando."
        : null
  const quick = useMemo(
    () => (page ? suggestions(page, view.data ?? null, order, extraQuick) : []),
    [page, view.data, order, extraQuick],
  )
  const failure = send.error ?? checkout.error ?? pay.error ?? giveBack.error
  const cost = view.data?.costMicros

  const header = (
    <div className={cn("flex gap-2", compact ? "flex-row-reverse items-center" : "flex-col")}>
      <div className="flex shrink-0 items-center justify-end gap-1">
        <Popover>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Cómo funciona la prueba" />}
          >
            <Info aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-2 rounded-2xl p-4 text-sm">
            <p className="font-semibold">Es la conversación de verdad, de prueba</p>
            <p className="text-muted-foreground">
              Pasa por la misma Sofi de un chat de verdad: mismas herramientas, mismas reglas de
              precio, la misma vitrina y el mismo carrito. No es una venta: no cobra ni entrega, no
              mueve el stock, no avisa y no entra a Pedidos ni a Reportes.
            </p>
          </PopoverContent>
        </Popover>
        {handedOff ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => giveBack.mutate()}
            disabled={giveBack.isPending}
          >
            Devolver a Sofi
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          onClick={restart}
          aria-label={compact ? "Empezar de nuevo" : undefined}
          title={compact ? "Empezar de nuevo" : undefined}
        >
          <RotateCcw aria-hidden />
          {compact ? null : "Empezar de nuevo"}
        </Button>
      </div>
      <ToggleGroup
        value={[tab]}
        onValueChange={(value) => value[0] && setTab(value[0] as "chat" | "vitrina")}
        className="w-full min-w-0 rounded-full bg-muted p-1"
        aria-label="Cómo llega la clienta"
      >
        <ToggleGroupItem
          value="chat"
          className="h-8 flex-1 rounded-full text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs"
        >
          WhatsApp
        </ToggleGroupItem>
        <ToggleGroupItem
          value="vitrina"
          className="h-8 flex-1 rounded-full text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs"
        >
          <Store className="size-3.5" aria-hidden />
          Vitrina
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )

  const footer = (
    <Collapsible defaultOpen={!isMobile} className="-mx-1">
      <CollapsibleTrigger className="group flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/40">
        {readiness ? (
          <SofiDot
            done={readiness.done}
            total={readiness.total}
            sellsAlone={readiness.sellsAlone}
            size={20}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Qué usó Sofi
          {missed.length ? <span className="text-warning"> · le faltó {missed.length}</span> : null}
        </span>
        {readiness ? (
          <span className="text-xs text-muted-foreground">
            sabe {readiness.done} de {readiness.total}
          </span>
        ) : null}
        <ChevronUp
          className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex max-h-44 flex-col gap-2 overflow-y-auto px-1 pt-1 pb-1">
          {!used.length && !missed.length && !why.length ? (
            <p className="text-xs text-muted-foreground">
              Pregunta algo como clienta y aquí ves de qué dato de la ficha salió cada respuesta y
              por qué respondió así.
            </p>
          ) : null}
          {used.length ? (
            <ul className="flex flex-wrap gap-1" aria-label="Lo que usó Sofi">
              {used.map((u) => (
                <li key={u.label}>
                  <button
                    type="button"
                    onClick={() => onGo(u.target)}
                    className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  >
                    <Check className="size-3 text-success" aria-hidden />
                    {u.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {/* «Por qué» (Configuración › Sofi, #744): solo lo anotado en su última respuesta. */}
          {why.length || basis?.tools.length ? (
            <div className="rounded-lg border border-dashed bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground">
              {why.length ? (
                <p>
                  <span className="font-medium text-foreground">Por qué: </span>
                  {why.join(" ")}
                </p>
              ) : null}
              {basis?.tools.length ? <p>{basis.tools.join(" · ")}.</p> : null}
            </div>
          ) : null}
          {missed.map((m) => (
            <div key={m.question} className="flex items-center gap-2 text-sm">
              <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1">Le faltó: «{m.question}»</span>
              {edit ? (
                <Button size="xs" variant="outline" onClick={() => onGo("no-supo")}>
                  Completar
                </Button>
              ) : null}
            </div>
          ))}
          {unknown.length ? (
            <p className="text-xs text-muted-foreground">
              Aún no sabe: {unknown.map((label) => label.toLowerCase()).join(", ")}.
            </p>
          ) : null}
          {cost ? (
            <p className="text-xs text-muted-foreground">Esta prueba costó {usd(cost)}.</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )

  const body = (
    <>
      <div className={cn("flex bg-muted/40 p-1", phoneClassName)}>
        {showcase.isError ? (
          <ErrorState error={showcase.error} onRetry={() => void showcase.refetch()} />
        ) : !page || !choice ? (
          <p className="m-auto text-sm text-muted-foreground">Abriendo el celular de la clienta…</p>
        ) : (
          <PhoneFrame bare className="h-full">
            {tab === "chat" ? (
              <ChatPhone
                storeId={storeId}
                storeName={page.store.name}
                brandColor={page.store.color}
                view={view.data ?? null}
                cart={order}
                currency={page.store.currency}
                pending={pending}
                quick={quick}
                blocked={blocked}
                compact={compact}
                onSend={(text) => send.mutate(text)}
                onOpenCart={() => {
                  setTab("vitrina")
                  setSheet("carrito")
                }}
              />
            ) : (
              <ProductPhone
                page={page}
                choice={choice}
                onChoose={choose}
                onWant={(variantId) => {
                  if (openOrder) {
                    setSheet("carrito")
                    return
                  }
                  setLines((now) =>
                    now.some((l) => l.variantId === variantId)
                      ? now.map((l) =>
                          l.variantId === variantId
                            ? { ...l, quantity: Math.min(20, l.quantity + 1) }
                            : l,
                        )
                      : [...now, { variantId, quantity: 1 }],
                  )
                }}
                cart={{
                  count,
                  totalCents: openOrder
                    ? openOrder.totalCents
                    : (quoteFresh?.quote?.totalCents ?? null),
                }}
                deal={
                  openOrder?.deal && !openOrder.deal.expired
                    ? {
                        label: openOrder.deal.freeDelivery
                          ? "Envío gratis acordado con Sofi"
                          : "Lo acordado con Sofi",
                        expiresAt: openOrder.deal.expiresAt,
                      }
                    : null
                }
                order={order?.paid ? { number: order.number } : null}
                onOpenCart={() => setSheet("carrito")}
                onOpenOrder={() => setSheet("pedido")}
                onChat={() => setTab("chat")}
                sheets={
                  <Sheets
                    storeId={storeId}
                    page={page}
                    sheet={sheet}
                    onSheet={setSheet}
                    order={order}
                    lines={lines}
                    onLines={setLines}
                    deliveryId={delivery?.id ?? null}
                    onDelivery={(id) => {
                      setDeliveryId(id)
                      setZone(null)
                    }}
                    zone={zone}
                    onZone={setZone}
                    quote={quoteFresh?.quote ?? null}
                    quoting={quote.isFetching}
                    quoteProblem={
                      quote.isError
                        ? submitErrorMessage(quote.error)
                        : (quoteFresh?.problem ?? null)
                    }
                    onCheckout={() => checkout.mutate()}
                    onPay={(id) => pay.mutate(id)}
                    busy={checkout.isPending || pay.isPending}
                    error={
                      checkout.error || pay.error
                        ? submitErrorMessage(checkout.error ?? pay.error)
                        : null
                    }
                    onChat={
                      messages.length
                        ? () => {
                            setSheet(null)
                            setTab("chat")
                          }
                        : undefined
                    }
                  />
                }
              />
            )}
          </PhoneFrame>
        )}
      </div>
      {failure && tab === "chat" ? (
        <p role="alert" className="px-1 pt-2 text-sm text-danger">
          {submitErrorMessage(failure)}
        </p>
      ) : null}
    </>
  )
  return { header, body, footer }
}

/**
 * El celular a la medida de quien lo muestra: en el teléfono, casi todo el alto para la
 * conversación; en la computadora, lo que cabe al lado sin pasar de un celular de verdad.
 */
const PHONE_IN_DRAWER =
  "h-[calc(100dvh-15rem)] min-h-[26rem] sm:h-[min(760px,calc(100dvh-24rem))] sm:min-h-[26rem]"

/** «Probar como clienta» en la ficha: al lado, en la columna lateral (en el celular, un cajón). */
export function ProbarPanel({ onClose }: { onClose: () => void }) {
  const { store, sheet: product, edit } = useFichaContext()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  // Mientras está abierta, la Ayuda habla de «Probar como clienta» (su pantalla en la guía).
  useEffect(() => {
    helpPanel.current = "probar-como-clienta"
    void queryClient.invalidateQueries({ queryKey: ["help-screen"] })
    return () => {
      helpPanel.current = null
      void queryClient.invalidateQueries({ queryKey: ["help-screen"] })
    }
  }, [queryClient])
  const { header, body, footer } = useClientTest({
    storeId: store.id,
    productId: product.id,
    readiness: {
      done: product.readiness.done,
      total: product.readiness.total,
      sellsAlone: product.readiness.sellsAlone,
      unknown: product.readiness.items.filter((i) => !i.ok).map((i) => i.label),
    },
    edit,
    onGo: (target) => {
      if (isMobile) onClose()
      setTimeout(() => goTo(anchorOf(target)), isMobile ? 280 : 0)
    },
    phoneClassName: PHONE_IN_DRAWER,
    compact: isMobile,
  })
  return (
    <DetailDrawer
      open
      onClose={onClose}
      size="md"
      title="Probar como clienta"
      // En el teléfono el alto es para la conversación: lo que es lo dice «Cómo funciona la prueba».
      description={isMobile ? undefined : "Lo mismo que vive la clienta, con la ficha de ahora"}
      // Escribir como clienta o elegir un color no es un dato que se pierda: cerrar no pregunta.
      headerContent={<div data-draft-ignore>{header}</div>}
      footer={<div data-draft-ignore>{footer}</div>}
    >
      <div data-draft-ignore>{body}</div>
    </DetailDrawer>
  )
}

/**
 * «Probar a Sofi» de Configuración › Sofi: la misma pieza, en la página, con el producto que se
 * elige. Lo que usó Sofi lleva a la ficha de ese producto.
 */
export function ClientTestPiece({
  storeId,
  productId,
  readiness,
  extraQuick,
  onGo,
  edit,
  title,
}: {
  storeId: string
  productId: string
  readiness: TestReadiness | null
  extraQuick?: string[]
  onGo: (target: string) => void
  edit: boolean
  /** El selector de producto y el título, arriba de la pieza. */
  title: ReactNode
}) {
  const { header, body, footer } = useClientTest({
    storeId,
    productId,
    readiness,
    edit,
    onGo,
    extraQuick,
    phoneClassName:
      "h-[calc(100dvh-14rem)] min-h-[30rem] max-h-[46rem] @3xl:h-[min(720px,calc(100dvh-16rem))] @3xl:min-h-[28rem]",
  })
  return (
    <div className="flex flex-col gap-3" data-draft-ignore>
      {title}
      {header}
      {body}
      {footer}
    </div>
  )
}
