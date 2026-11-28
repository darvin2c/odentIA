import { cn } from "@odentia/ui"
import { ArrowLeft, SendHorizontal } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import type { ConversationMessage, ConversationView } from "../lib/sofi"
import { money } from "../lib/tienda"
import { mediaFor, type Showcase, shownPrice, type TestCart, variantOf } from "../lib/vitrina"
import { Photo } from "../piezas"
import { brandStyle, Logo, SofiMini } from "./marcos"

/**
 * El WhatsApp de la clienta con la tienda (prototipo aprobado, `vitrina/chat.tsx`): sus mensajes a
 * la derecha, los de Sofi a la izquierda con la foto o el video que mandó y la tarjeta del carrito
 * cuando anotó el pedido. Colores neutros: no copia la marca de WhatsApp. Son los mensajes de
 * verdad de la conversación de prueba: lo que responde Sofi sale de su misma tubería.
 */

const hour = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" })

export interface ChatPhoneProps {
  storeId: string
  storeName: string
  brandColor: string | null
  view: ConversationView | null
  cart: TestCart | null
  currency: string
  /** Lo que la clienta acaba de escribir, mientras Sofi responde. */
  pending: string | null
  /** Lo que podría escribir la clienta: toques que mandan el mensaje. */
  quick: string[]
  onSend: (text: string) => void
  onOpenCart: () => void
  /** No se puede escribir (Sofi sin modelo, o la atiende una persona): por qué. */
  blocked: string | null
}

function Bubble({
  message,
  storeId,
  view,
  cart,
  currency,
  storeName,
  onOpenCart,
}: {
  message: ConversationMessage
  storeId: string
  view: ConversationView
  cart: TestCart | null
  currency: string
  storeName: string
  onOpenCart: () => void
}) {
  if (message.author === "cliente")
    return (
      <div className="msg me">
        <span>{message.text}</span>
        <span className="h">{hour(message.createdAt)}</span>
      </div>
    )
  const orders = (message.orders ?? [])
    .map((id) => view.orders.find((o) => o.id === id))
    .filter((o) => o !== undefined)
  return (
    <div className="msg so">
      <p className="who">
        <SofiMini size={16} />
        {message.author === "persona" ? "Una persona del equipo" : "Sofi"}
      </p>
      {(message.media ?? []).map((m) =>
        m.kind === "video" && m.urls ? (
          <video
            key={m.id}
            className="media"
            src={m.urls.video}
            poster={m.urls.poster}
            controls
            muted
            playsInline
            aria-label={m.label ?? `Video de ${m.product}`}
          />
        ) : m.kind === "foto" ? (
          <Photo
            key={m.id}
            storeId={storeId}
            photoId={m.id}
            alt={`${m.product}${m.color ? ` ${m.color}` : ""}`}
            className="media"
          />
        ) : null,
      )}
      <span>{message.text}</span>
      {orders.map((order) => {
        const live = cart?.id === order.id ? cart : null
        const open = order.state === "por_pagar"
        return (
          <span key={order.id} className="lp">
            <span className="lp-pic">
              {live?.lines[0]?.photoId ? (
                <Photo storeId={storeId} photoId={live.lines[0].photoId} alt="" />
              ) : null}
            </span>
            <span>
              <b>{open ? `Tu carrito en ${storeName}` : `Tu pedido ${order.number}`}</b>
              <span style={{ fontSize: 13, color: "var(--vv-ink-2)" }}>
                {money(order.totalCents, currency)}
                {open && live?.deal && !live.deal.expired ? ` · vale hasta ${live.deal.until}` : ""}
                {order.state === "anulado"
                  ? " · anulado"
                  : !open
                    ? order.balance.paid
                      ? " · pagado"
                      : " · pago por confirmar"
                    : ""}
              </span>
              <span>Pedido {order.number}</span>
            </span>
          </span>
        )
      })}
      <span className="h">{hour(message.createdAt)}</span>
      {orders.some((o) => o.state === "por_pagar") ? (
        <span className="msg-btns">
          <button type="button" onClick={onOpenCart}>
            Ver y pagar
          </button>
        </span>
      ) : null}
    </div>
  )
}

export function ChatPhone(props: ChatPhoneProps) {
  const { view } = props
  const [text, setText] = useState("")
  const body = useRef<HTMLDivElement>(null)
  const count = (view?.messages.length ?? 0) + (props.pending ? 1 : 0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: baja al llegar un mensaje
  useEffect(() => {
    const el = body.current
    if (!el) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" })
  }, [count])
  const send = (value: string) => {
    const message = value.trim()
    if (!message || props.pending || props.blocked) return
    setText("")
    props.onSend(message)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(text)
  }
  return (
    <div className="vv" style={{ ...brandStyle(props.brandColor), height: "100%" }}>
      <div className="ch">
        <div className="ch-head gut">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <Logo name={props.storeName} size={38} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, lineHeight: 1.2 }}>{props.storeName}</p>
            <p className="ch-sub">Cuenta de empresa · responde Sofi</p>
          </div>
        </div>
        <p className="ch-strip">Prueba: no se envía nada ni se cobra.</p>
        <div
          ref={body}
          className="ch-body"
          role="log"
          aria-live="polite"
          aria-label="El chat de la prueba"
        >
          {count === 0 ? <p className="dia">Escribe como clienta o toca una sugerencia</p> : null}
          {view?.messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              storeId={props.storeId}
              view={view}
              cart={props.cart}
              currency={props.currency}
              storeName={props.storeName}
              onOpenCart={props.onOpenCart}
            />
          ))}
          {props.pending ? (
            <>
              <div className="msg me">
                <span>{props.pending}</span>
              </div>
              <div className="msg so">
                <span className="typing" role="status" aria-label="Sofi está escribiendo">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </>
          ) : null}
          {view?.handler === "persona" ? (
            <p className="dia">Sofi la pasó a una persona: {view.waitingReason ?? "sin motivo"}</p>
          ) : null}
        </div>
        {props.quick.length && !props.pending && !props.blocked ? (
          <div className="quick">
            <p className="quick-l">Lo que podría escribir la clienta</p>
            <div className="quick-row">
              {props.quick.map((q) => (
                <button key={q} type="button" className="qchip" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {props.blocked ? <p className="dia">{props.blocked}</p> : null}
        <form className="ch-input" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            placeholder="Escribe como clienta"
            aria-label="Mensaje de la clienta (prueba)"
            disabled={Boolean(props.blocked)}
          />
          <button
            type="submit"
            className="send"
            aria-label="Enviar"
            disabled={Boolean(props.pending) || Boolean(props.blocked)}
          >
            <SendHorizontal className="size-5" aria-hidden />
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * En WhatsApp, cuando la piden: cómo se ve este producto en un chat, con la ficha de ahora (la
 * foto del color, su precio y lo que queda). Es un ejemplo para la vista previa: no es una
 * respuesta de Sofi.
 */
export function ChatSample({ page }: { page: Showcase }) {
  const { product, store } = page
  const color = product.colors.at(-1)?.value ?? product.colors[0]?.value ?? null
  const size =
    product.sizes.find((z) => variantOf(page, { color, size: z })?.available) ??
    product.sizes[0] ??
    null
  const choice = { color, size }
  const variant = variantOf(page, choice) ?? shownPrice(page, choice)
  const photo = mediaFor(page, color).photos[0]
  const many = product.colors.length > 1 && color
  const asked = `Hola, ¿tienes ${many ? `la ${color}` : product.name.toLowerCase()}${size ? ` en ${size}` : ""}?`
  const left = variant?.left
    ? ` y me ${variant.left === 1 ? "queda 1" : `quedan ${variant.left}`}`
    : ""
  const said = variant
    ? `¡Hola! Soy Sofi, de ${store.name}. Sí: ${product.name.toLowerCase()}${many ? ` ${color}` : ""}${size ? ` ${size}` : ""} está a ${money(variant.priceCents, store.currency)}${left}. ¿Te la envío o la recoges?`
    : `¡Hola! Soy Sofi, de ${store.name}. ¿Qué talla buscas?`
  const url = store.link ? `${store.link}.gestoria24.com/${product.slug ?? ""}` : null
  return (
    <div className="vv" style={{ ...brandStyle(store.color), height: "100%" }}>
      <div className="ch">
        <div className="ch-head gut">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <Logo name={store.name} size={38} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, lineHeight: 1.2 }}>{store.name}</p>
            <p className="ch-sub">Cuenta de empresa · responde Sofi</p>
          </div>
        </div>
        <div className="ch-body">
          <p className="dia">Ejemplo, con la ficha de ahora</p>
          <div className="msg me">
            <span>{asked}</span>
          </div>
          <div className={cn("msg so")}>
            <p className="who">
              <SofiMini size={16} />
              Sofi
            </p>
            {photo ? <img className="media" src={photo.vitrina} alt="" /> : null}
            <span>{said}</span>
            {url ? (
              <span className="lp">
                {photo ? <img src={photo.miniatura} alt="" /> : <span />}
                <span>
                  <b>{product.name}</b>
                  {variant ? (
                    <span style={{ fontSize: 13, color: "var(--vv-ink-2)" }}>
                      {money(variant.priceCents, store.currency)} · {store.name}
                    </span>
                  ) : null}
                  <span>{url}</span>
                </span>
              </span>
            ) : null}
            <span className="msg-btns">
              <span className="msg-btn">La quiero</span>
              <span className="msg-btn">Ver en la vitrina</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
