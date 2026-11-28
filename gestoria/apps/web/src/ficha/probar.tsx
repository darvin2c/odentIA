import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useIsMobile,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { DetailDrawer, ErrorState, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronUp, CircleAlert, Info, RotateCcw, Store } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../lib/api"
import { anchorOf } from "../lib/ficha"
import type { AnswerStatus, ConversationView, SofiOverview } from "../lib/sofi"
import {
  type CartLine,
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
 * `ficha/probar.tsx`): lo mismo que vive la clienta con este producto, en su celular. «WhatsApp»
 * es el chat con Sofi y «Vitrina», la página del producto por link, con el mismo carrito.
 *
 * Es la conversación de prueba de siempre (canal «prueba»): pasa por la misma Sofi de un chat de
 * verdad (`apps/api/src/sofi/`), con sus herramientas, el precio de `precio.ts`, la única oferta
 * con plazo y la revisión antes de salir. No mueve stock, no cobra (el pago se simula y lo dice),
 * no avisa y no cuenta en Reportes, Argos ni en lo que se cobra: no es una venta. Nunca es un panel aparte de preguntas.
 */

export const VIEW_KEY = (storeId: string, id: string | null) => ["conversacion", storeId, id]
export const SHOWCASE_KEY = (storeId: string, productId: string) => ["vitrina", storeId, productId]
const CART_KEY = (storeId: string, id: string | null) => ["carrito-prueba", storeId, id]

/** La prueba de cada producto sigue abierta al volver a la ficha (en este navegador). */
function useTestId(storeId: string, productId: string) {
  const key = `gestoria.prueba.${storeId}.${productId}`
  const [id, setId] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  })
  const save = (next: string | null) => {
    setId(next)
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
function suggestions(page: Showcase, view: ConversationView | null, cart: TestCart | null) {
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
    ]
  if (last.includes("envío gratis") && last.includes("si lo pagas"))
    return ["Envío gratis", "Lo voy a pensar"]
  if (last.includes("¿lo confirmo")) return ["Sí, confirmo"]
  return ["¿Me haces precio?", "Lo voy a pensar", want]
}

export function ProbarPanel({ onClose }: { onClose: () => void }) {
  const { store, sheet: product, edit } = useFichaContext()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useTestId(store.id, product.id)
  const [tab, setTab] = useState<"chat" | "vitrina">("chat")
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const [lines, setLines] = useState<CartLine[]>([])
  const [deliveryId, setDeliveryId] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const showcase = useShowcase(store.id, product.id)
  const page = showcase.data ?? null
  const [choice, setChoice] = useState<Choice | null>(null)
  useEffect(() => {
    if (page && !choice) setChoice(firstChoice(page))
  }, [page, choice])
  const overview = useQuery({
    queryKey: ["sofi", store.id],
    queryFn: () => api<SofiOverview>(`/api/tiendas/${store.id}/sofi`),
  })
  const view = useQuery({
    queryKey: VIEW_KEY(store.id, conversationId),
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (
        await api<{ conversation: ConversationView }>(
          `/api/tiendas/${store.id}/conversaciones/${conversationId}`,
        )
      ).conversation,
  })
  const cart = useQuery({
    queryKey: CART_KEY(store.id, conversationId),
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (
        await api<{ cart: TestCart | null }>(
          `/api/tiendas/${store.id}/conversaciones/${conversationId}/carrito`,
        )
      ).cart,
  })
  // Una prueba que ya no está (se borró la tienda de ejemplo, otra sesión): se empieza otra.
  useEffect(() => {
    if (view.isError && (view.error as { status?: number }).status === 404) setConversationId(null)
  }, [view.isError, view.error, setConversationId])

  const begin = async () => {
    if (conversationId) return conversationId
    const { id } = await api<{ id: string }>(`/api/tiendas/${store.id}/sofi/pruebas`, {
      method: "POST",
    })
    setConversationId(id)
    return id
  }
  const refreshCart = (id: string) =>
    queryClient.invalidateQueries({ queryKey: CART_KEY(store.id, id) })

  const send = useMutation({
    mutationFn: async (text: string) => {
      const id = await begin()
      return api<{ conversation: ConversationView; result: { status: AnswerStatus } }>(
        `/api/tiendas/${store.id}/conversaciones/${id}/cliente`,
        { method: "POST", body: { text, desde: product.id, carrito: lines } },
      )
    },
    onMutate: (text) => setPending(text),
    onSuccess: async (data) => {
      queryClient.setQueryData(VIEW_KEY(store.id, data.conversation.id), data.conversation)
      await refreshCart(data.conversation.id)
    },
    onSettled: () => setPending(null),
  })
  const checkout = useMutation({
    mutationFn: async () => {
      const open = cart.data?.state === "por_pagar" ? cart.data : null
      if (open) return open
      const id = await begin()
      const placed = await api<{ cart: TestCart }>(
        `/api/tiendas/${store.id}/conversaciones/${id}/carrito`,
        {
          method: "POST",
          body: {
            lines,
            deliveryMethodId: deliveryId ?? page?.store.deliveries[0]?.id,
          },
        },
      )
      queryClient.setQueryData(CART_KEY(store.id, id), placed.cart)
      setLines([])
      return placed.cart
    },
    onSuccess: () => setSheet("pago"),
  })
  const pay = useMutation({
    mutationFn: (method: "Yape" | "Tarjeta") =>
      api<{ conversation: ConversationView; cart: TestCart | null }>(
        `/api/tiendas/${store.id}/conversaciones/${conversationId}/pagar`,
        { method: "POST", body: { orderId: cart.data?.id, method } },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(VIEW_KEY(store.id, data.conversation.id), data.conversation)
      queryClient.setQueryData(CART_KEY(store.id, data.conversation.id), data.cart)
      setSheet("pedido")
    },
  })

  const restart = () => {
    setConversationId(null)
    setLines([])
    setSheet(null)
    setTab("chat")
    setChoice(page ? firstChoice(page) : null)
    send.reset()
    checkout.reset()
    pay.reset()
  }

  const messages = view.data?.messages ?? []
  const lastSofi = [...messages].reverse().find((m) => m.author === "sofi")
  const used = lastSofi?.used ?? []
  const missed = lastSofi?.missed ?? []
  const readiness = product.readiness
  const unknown = readiness.items.filter((i) => !i.ok)
  const order = cart.data ?? null
  const openOrder = order?.state === "por_pagar" ? order : null
  const count = openOrder
    ? openOrder.lines.reduce((n, l) => n + l.quantity, 0)
    : lines.reduce((n, l) => n + l.quantity, 0)
  const blocked = !overview.data
    ? null
    : !overview.data.modelReady
      ? "Sofi todavía no puede responder: falta configurar su modelo en el servidor."
      : view.data?.handler === "persona"
        ? "Sofi la pasó a una persona. Empieza de nuevo para seguir probando."
        : null
  const quick = useMemo(
    () => (page ? suggestions(page, view.data ?? null, order) : []),
    [page, view.data, order],
  )
  const failure = send.error ?? checkout.error ?? pay.error
  const go = (target: string) => {
    if (isMobile) onClose()
    setTimeout(() => goTo(anchorOf(target)), isMobile ? 280 : 0)
  }

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
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
              mueve el stock, no avisa y no cuenta en Reportes.
            </p>
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="sm" onClick={restart}>
          <RotateCcw aria-hidden />
          Empezar de nuevo
        </Button>
      </div>
      <ToggleGroup
        value={[tab]}
        onValueChange={(value) => value[0] && setTab(value[0] as "chat" | "vitrina")}
        className="w-full rounded-full bg-muted p-1"
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
    <Collapsible defaultOpen className="-mx-1">
      <CollapsibleTrigger className="group flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/40">
        <SofiDot
          done={readiness.done}
          total={readiness.total}
          sellsAlone={readiness.sellsAlone}
          size={20}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Qué usó Sofi
          {missed.length ? <span className="text-warning"> · le faltó {missed.length}</span> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          sabe {readiness.done} de {readiness.total}
        </span>
        <ChevronUp
          className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex max-h-44 flex-col gap-2 overflow-y-auto px-1 pt-1 pb-1">
          {!used.length && !missed.length ? (
            <p className="text-xs text-muted-foreground">
              Pregunta algo como clienta y aquí ves de qué dato de la ficha salió cada respuesta.
            </p>
          ) : null}
          {used.length ? (
            <ul className="flex flex-wrap gap-1" aria-label="Lo que usó Sofi">
              {used.map((u) => (
                <li key={u.label}>
                  <button
                    type="button"
                    onClick={() => go(u.target)}
                    className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  >
                    <Check className="size-3 text-success" aria-hidden />
                    {u.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {missed.map((m) => (
            <div key={m.question} className="flex items-center gap-2 text-sm">
              <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1">Le faltó: «{m.question}»</span>
              {edit ? (
                <Button size="xs" variant="outline" onClick={() => go("no-supo")}>
                  Completar
                </Button>
              ) : null}
            </div>
          ))}
          {unknown.length ? (
            <p className="text-xs text-muted-foreground">
              Aún no sabe: {unknown.map((i) => i.label.toLowerCase()).join(", ")}.
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )

  return (
    <DetailDrawer
      open
      onClose={onClose}
      size="md"
      title="Probar como clienta"
      description="Lo mismo que vive la clienta, con la ficha de ahora"
      headerContent={header}
      footer={footer}
    >
      <div className="flex h-[min(760px,calc(100dvh-16rem))] min-h-[30rem] bg-muted/40 p-1">
        {showcase.isError ? (
          <ErrorState error={showcase.error} onRetry={() => void showcase.refetch()} />
        ) : !page || !choice ? (
          <p className="m-auto text-sm text-muted-foreground">Abriendo el celular de la clienta…</p>
        ) : (
          <PhoneFrame bare className="h-full">
            {tab === "chat" ? (
              <ChatPhone
                storeId={store.id}
                storeName={page.store.name}
                brandColor={page.store.color}
                view={view.data ?? null}
                cart={order}
                currency={page.store.currency}
                pending={pending}
                quick={quick}
                blocked={blocked}
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
                onChoose={setChoice}
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
                  totalCents: openOrder ? openOrder.totalCents : null,
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
                    storeId={store.id}
                    page={page}
                    sheet={sheet}
                    onSheet={setSheet}
                    order={order}
                    lines={lines}
                    onLines={setLines}
                    deliveryId={deliveryId}
                    onDelivery={setDeliveryId}
                    onCheckout={() => checkout.mutate()}
                    onPay={(method) => pay.mutate(method)}
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
    </DetailDrawer>
  )
}
