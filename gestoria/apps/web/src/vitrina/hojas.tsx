import { cn } from "@odentia/ui"
import {
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  MessageCircle,
  Minus,
  Plus,
  Smartphone,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { money } from "../lib/tienda"
import {
  type CartLine,
  clock,
  deliveryFrom,
  localTotals,
  mediaFor,
  type Showcase,
  type TestCart,
} from "../lib/vitrina"
import { Photo } from "../piezas"
import { Logo } from "./marcos"

/**
 * El carrito, el pago y el pedido de la vitrina (prototipo aprobado, `vitrina/tienda.tsx`, «Hojas»),
 * en una hoja dentro del celular. El carrito es el mismo del chat: el pedido que anotó Sofi con lo
 * acordado y su plazo, o lo que la clienta eligió en la vitrina. En la prueba, «Pagar ahora» no
 * cobra: lo dice en la hoja.
 */

export type SheetKind = "carrito" | "pago" | "pedido"

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  // El foco entra a la hoja al abrirla y vuelve a lo que la abrió al cerrarla. Escape cierra solo
  // la hoja, no el panel de afuera.
  const closer = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closer.current?.focus()
    return () => before?.focus?.()
  }, [])
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          e.stopPropagation()
          onClose()
        }}
      >
        <span className="grab" aria-hidden />
        <button ref={closer} type="button" className="x" aria-label="Cerrar" onClick={onClose}>
          <X className="size-5" aria-hidden />
        </button>
        <div className="sheet-in">{children}</div>
      </div>
    </>
  )
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export interface SheetsProps {
  storeId: string
  page: Showcase
  sheet: SheetKind | null
  onSheet: (sheet: SheetKind | null) => void
  /** El pedido de la conversación: lo acordado con Sofi o el de la vitrina. */
  order: TestCart | null
  /** Lo elegido en la vitrina, antes de que haya pedido. */
  lines: CartLine[]
  onLines: (lines: CartLine[]) => void
  deliveryId: string | null
  onDelivery: (id: string) => void
  /** La zona, si la entrega es por zona. */
  zone: string | null
  onZone: (zone: string) => void
  /** «Pagar ahora» del carrito: anota el pedido si todavía no hay y pasa a pagar. */
  onCheckout: () => void
  onPay: (method: "Yape" | "Tarjeta") => void
  busy: boolean
  error: string | null
  /** Ir al chat (la pestaña de WhatsApp de la prueba); solo si ya hay chat. */
  onChat?: () => void
}

export function Sheets(props: SheetsProps) {
  const { page, sheet, order, storeId } = props
  const now = useNow()
  const close = () => props.onSheet(null)
  const { currency } = page.store
  const m = (cents: number) => money(cents, currency)
  const link = page.store.link ? `${page.store.link}.gestoria24.com` : null
  // En la vitrina se elige lo que tiene precio: lo que «se acuerda» se ve con Sofi en el chat.
  const options = page.store.deliveries.filter((d) => d.cost !== "se_acuerda")
  const delivery = options.find((d) => d.id === props.deliveryId) ?? options[0] ?? null
  const local = localTotals(page, props.lines, delivery, props.zone)
  const needsZone = delivery?.cost === "por_zona" && !props.zone
  const open = order && order.state === "por_pagar" ? order : null
  const dealLive = open?.deal && new Date(open.deal.expiresAt).getTime() > now ? open.deal : null

  if (sheet === "carrito")
    return (
      <Sheet title="Tu carrito" onClose={close}>
        <h2>Tu carrito</h2>
        {link ? (
          <p className="fine" style={{ marginTop: -8 }}>
            {link}
          </p>
        ) : null}
        {open && props.onChat ? (
          <div className="hold" style={{ flexDirection: "row", alignItems: "center" }}>
            <MessageCircle className="size-5 shrink-0" aria-hidden />
            <p className="grow">
              <b>Tu carrito está en el chat</b>
              <br />
              <span className="muted">Sofi ya lo vio</span>
            </p>
            <button type="button" className="btn line sm" onClick={props.onChat}>
              Ver el chat
            </button>
          </div>
        ) : null}
        {dealLive ? (
          <div className="hold">
            <p>
              <Clock className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
              <b>
                {dealLive.freeDelivery
                  ? "Envío gratis acordado con Sofi"
                  : `${m(dealLive.discountCents)} menos, acordado con Sofi`}
              </b>{" "}
              · vence en{" "}
              <span className="cd">{clock(new Date(dealLive.expiresAt).getTime() - now)}</span>
            </p>
            <p className="muted">Si no se paga a tiempo, vuelve al precio de siempre.</p>
          </div>
        ) : open?.deal ? (
          <div className="hold">
            <p>
              <b>Lo acordado con Sofi venció</b>
            </p>
            <p className="muted">Pídele en el chat que lo vuelva a ver.</p>
          </div>
        ) : null}
        {open ? (
          open.lines.map((line) => (
            <div key={line.variantId} className="it">
              <Photo storeId={storeId} photoId={line.photoId} alt="" className="size-[72px]" />
              <div>
                <p style={{ fontWeight: 700 }}>{line.productName}</p>
                <p className="muted">{line.variantName}</p>
                <p className="disp" style={{ fontSize: 17, fontWeight: 700 }}>
                  {line.gift ? "De regalo" : m(line.unitCents)}
                  {line.quantity > 1 ? <span className="fine"> × {line.quantity}</span> : null}
                </p>
              </div>
            </div>
          ))
        ) : local.priced.length === 0 ? (
          <p className="muted">Tu carrito está vacío.</p>
        ) : (
          local.priced.map(({ line, variant }) => {
            const photo = mediaFor(page, variant.color).photos[0]
            return (
              <div key={line.variantId} className="it">
                {photo ? <img src={photo.miniatura} alt="" /> : <span />}
                <div>
                  <p style={{ fontWeight: 700 }}>{page.product.name}</p>
                  <p className="muted">
                    {[variant.color, variant.size].filter(Boolean).join(", ") || "Única"}
                  </p>
                  <p className="disp" style={{ fontSize: 17, fontWeight: 700 }}>
                    {m(variant.priceCents)}
                  </p>
                </div>
                <div className="stepper">
                  <button
                    type="button"
                    aria-label="Uno menos"
                    onClick={() =>
                      props.onLines(
                        props.lines.flatMap((l) =>
                          l.variantId === line.variantId
                            ? l.quantity > 1
                              ? [{ ...l, quantity: l.quantity - 1 }]
                              : []
                            : [l],
                        ),
                      )
                    }
                  >
                    <Minus className="size-4" aria-hidden />
                  </button>
                  <span style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>
                    {line.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label="Uno más"
                    onClick={() =>
                      props.onLines(
                        props.lines.map((l) =>
                          l.variantId === line.variantId
                            ? { ...l, quantity: Math.min(20, l.quantity + 1) }
                            : l,
                        ),
                      )
                    }
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>
              </div>
            )
          })
        )}
        {!open && local.missingForFree ? (
          <div className="flex flex-col gap-1.5">
            <p style={{ fontWeight: 600, fontSize: 14 }}>
              Te faltan {m(local.missingForFree)} para el envío gratis
            </p>
            <div className="freebar">
              <i
                style={{
                  width: `${Math.min(100, (local.subtotal / (local.subtotal + local.missingForFree)) * 100)}%`,
                }}
              />
            </div>
          </div>
        ) : null}
        <p className="disp" style={{ fontSize: 18, fontWeight: 700 }}>
          Cómo te llega
        </p>
        {open ? (
          <div className="ship on" aria-current="true">
            <i aria-hidden />
            <span style={{ textAlign: "left" }}>
              <b style={{ display: "block", fontSize: 14.5 }}>{open.deliveryName}</b>
              <small className="muted">Lo acordado con Sofi</small>
            </span>
            <b>{open.deliveryCents ? m(open.deliveryCents) : "Gratis"}</b>
          </div>
        ) : (
          options.slice(0, 3).map((d) => {
            const on = d.id === delivery?.id
            const from = deliveryFrom(d)
            return (
              <button
                key={d.id}
                type="button"
                className={cn("ship", on && "on")}
                onClick={() => props.onDelivery(d.id)}
                aria-pressed={on}
              >
                <i aria-hidden />
                <span style={{ textAlign: "left" }}>
                  <b style={{ display: "block", fontSize: 14.5 }}>{d.name}</b>
                  {d.eta ? <small className="muted">{d.eta}</small> : null}
                </span>
                <b>
                  {from === null
                    ? "Se acuerda"
                    : from === 0 || (on && local.free)
                      ? "Gratis"
                      : `${d.cost === "por_zona" ? "desde " : ""}${m(from)}`}
                </b>
              </button>
            )
          })
        )}
        {!open && delivery?.cost === "por_zona" ? (
          <div className="pay" role="group" aria-label="Tu zona">
            {delivery.zones.map((z) => (
              <button
                key={z.name}
                type="button"
                className={cn("zone", props.zone === z.name && "on")}
                aria-pressed={props.zone === z.name}
                onClick={() => props.onZone(z.name)}
              >
                {z.name} · {m(z.priceCents)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="sum">
          <div>
            <span>Productos</span>
            <span>{m(open ? open.subtotalCents : local.subtotal)}</span>
          </div>
          {open?.discountCents ? (
            <div style={{ color: "var(--vv-ok)" }}>
              <span>Acordado con Sofi</span>
              <span>−{m(open.discountCents)}</span>
            </div>
          ) : null}
          <div>
            <span>Envío</span>
            <span>
              {open
                ? open.deliveryCents
                  ? m(open.deliveryCents)
                  : "Gratis"
                : !local.shippingKnown
                  ? "Se acuerda"
                  : local.shipping
                    ? m(local.shipping)
                    : "Gratis"}
            </span>
          </div>
          <div className="t">
            <span>Total</span>
            <b>{m(open ? open.totalCents : local.total)}</b>
          </div>
        </div>
        {!open && needsZone ? <p className="hint">Elige tu zona</p> : null}
        {props.error ? (
          <p className="hint" role="alert">
            {props.error}
          </p>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={(!open && (local.priced.length === 0 || needsZone)) || props.busy}
          onClick={props.onCheckout}
        >
          Pagar ahora · {m(open ? open.totalCents : local.total)}
        </button>
      </Sheet>
    )

  if (sheet === "pago" && open)
    return (
      <Sheet title="Pagar" onClose={close}>
        <h2>Pagar {m(open.totalCents)}</h2>
        <p className="muted">
          {page.store.name} · Pedido {open.number}
        </p>
        <div className="gate">
          {(
            [
              ["Yape", Smartphone],
              ["Tarjeta", CreditCard],
            ] as const
          ).map(([method, Icon]) => (
            <button
              key={method}
              type="button"
              disabled={props.busy}
              onClick={() => props.onPay(method)}
            >
              <Icon className="size-5" aria-hidden />
              <span className="grow" style={{ textAlign: "left" }}>
                Pagar con {method}
              </span>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          ))}
        </div>
        {props.error ? (
          <p className="hint" role="alert">
            {props.error}
          </p>
        ) : null}
        <p className="proto">
          Pago de prueba: no se cobra. No es una venta: no mueve el stock ni cuenta en Reportes.
        </p>
      </Sheet>
    )

  if (sheet === "pedido" && order)
    return (
      <Sheet title="Tu pedido" onClose={close}>
        <div className="flex items-center gap-3" style={{ paddingRight: 48 }}>
          <Logo name={page.store.name} size={44} />
          <div>
            <p className="fine" style={{ fontWeight: 700 }}>
              {page.store.name}
            </p>
            <h2 style={{ padding: 0 }}>Tu pedido {order.number}</h2>
          </div>
        </div>
        <ol className="steps">
          {(
            [
              ["Confirmado", "", "done"],
              [
                "Pagado",
                order.paid ? "Pago de prueba" : "Falta pagar",
                order.paid ? "done" : "now",
              ],
              ["Preparando", "La tienda lo alista y lo empaca", order.paid ? "now" : ""],
              ["Salió", "La tienda te avisa", ""],
              ["Entregado", "", ""],
            ] as const
          ).map(([title, detail, step]) => (
            <li key={title} className={cn("step", step)}>
              <span className="dot">
                {step === "done" ? <Check className="size-4" aria-hidden /> : null}
              </span>
              <span>
                <b>{title}</b>
                {detail ? <p className="muted">{detail}</p> : null}
              </span>
            </li>
          ))}
        </ol>
        <div className="box" style={{ background: "var(--vv-screen)" }}>
          <div className="row">
            <span>{order.paid ? "Pagaste" : "Total"}</span>
            <b>{m(order.totalCents)}</b>
          </div>
        </div>
        {props.onChat ? (
          <button type="button" className="btn" onClick={props.onChat}>
            <MessageCircle className="size-5" aria-hidden />
            Ver lo que te escribió Sofi
          </button>
        ) : null}
        <p className="proto">Prueba: no se cobró nada ni se movió el stock.</p>
      </Sheet>
    )
  return null
}
