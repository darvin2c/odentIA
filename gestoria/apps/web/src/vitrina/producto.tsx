import { cn } from "@odentia/ui"
import { Clock, Play, ShoppingBag, Truck } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { money } from "../lib/tienda"
import {
  bubble,
  type Choice,
  clock,
  deliveryFrom,
  mediaFor,
  type Showcase,
  shownPrice,
  swatch,
  tint,
  variantOf,
} from "../lib/vitrina"
import { brandStyle, Logo, SofiFig, SofiMini } from "./marcos"

/**
 * La página de un producto en la vitrina de la tienda («Vitrina viva»; prototipo aprobado,
 * `vitrina/tienda.tsx`), en el celular y en la web. Es una pieza: la usan la vista previa y
 * «Probar como clienta» de la ficha, y la usará el catálogo por link. Todo sale de la página que
 * da el servidor (`Showcase`, solo lo vendible); quien la usa decide qué hace «Lo quiero», el
 * carrito y el chat.
 */

export interface ProductPageProps {
  page: Showcase
  choice: Choice
  onChoose: (choice: Choice) => void
  /** «Lo quiero» con la variante elegida. */
  onWant?: (variantId: string) => void
  /** El carrito: cuántos lleva y el total; sin nada, la barra invita a preguntarle a Sofi. */
  cart?: { count: number; totalCents: number | null }
  /** Lo acordado con Sofi que vence (el carrito lo muestra con su reloj). */
  deal?: { label: string; expiresAt: string } | null
  /** El pedido ya pagado: la barra lo sigue. */
  order?: { number: string } | null
  onOpenCart?: () => void
  onOpenOrder?: () => void
  /** Ir al chat con Sofi (en la prueba, la pestaña de WhatsApp). */
  onChat?: () => void
  /** Las hojas del carrito, el pago y el pedido, dentro del celular. */
  sheets?: ReactNode
}

/** El reloj de lo acordado, cada segundo. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** La galería que se pasa con el dedo: al cambiar de color, entra la foto de ese color. */
function Gallery({ page, choice }: { page: Showcase; choice: Choice }) {
  const { photos, videos } = mediaFor(page, choice.color)
  const color = page.product.colors.find((c) => c.value === choice.color)
  const slides = [
    ...photos
      .slice(0, 1)
      .map((p) => ({ kind: "foto" as const, id: p.id, src: p.vitrina, poster: "" })),
    ...videos
      .slice(0, 1)
      .map((v) => ({ kind: "video" as const, id: v.id, src: v.video, poster: v.poster })),
    ...photos
      .slice(1)
      .map((p) => ({ kind: "foto" as const, id: p.id, src: p.vitrina, poster: "" })),
  ]
  const [index, setIndex] = useState(0)
  const track = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de color vuelve a la primera
  useEffect(() => {
    track.current?.scrollTo({ left: 0 })
    setIndex(0)
  }, [choice.color])
  const promo = page.product.variants.find(
    (v) => v.promotion && (choice.color === null || v.color === choice.color),
  )?.promotion
  return (
    <div className="gal" style={{ backgroundColor: tint(color?.hex ?? null) }}>
      <div
        ref={track}
        className="gal-track"
        onScroll={(e) =>
          setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))
        }
      >
        {slides.length === 0 ? (
          <div className="gal-slide">
            <ShoppingBag className="size-16 opacity-30" aria-hidden />
          </div>
        ) : null}
        {slides.map((m) => (
          <div key={`${choice.color}-${m.id}`} className="gal-slide">
            {m.kind === "video" ? (
              <video
                src={m.src}
                poster={m.poster}
                muted
                loop
                playsInline
                autoPlay
                aria-label="Video del producto"
              />
            ) : (
              <img
                src={m.src}
                alt={`${page.product.name}${choice.color ? ` ${choice.color}` : ""}`}
              />
            )}
          </div>
        ))}
      </div>
      {promo ? (
        <span className="gal-chip sale">−{promo.percentOff} %</span>
      ) : videos.length ? (
        <span className="gal-chip">
          <Play className="mr-1 inline size-3 fill-current" aria-hidden />
          Con video
        </span>
      ) : null}
      {slides.length > 1 ? (
        <div className="gal-dots" aria-hidden>
          {slides.map((m, j) => (
            <i key={m.id} className={cn(j === index && "on")} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Los colores y las tallas, con lo que hay en cada una. */
function Options({
  page,
  choice,
  onChoose,
  web,
}: {
  page: Showcase
  choice: Choice
  onChoose: (choice: Choice) => void
  web?: boolean
}) {
  const { product } = page
  const chosen = variantOf(page, choice)
  return (
    <>
      {product.colors.length ? (
        <div>
          <p className="opt-l">
            {product.rowLabel}: <b>{choice.color}</b>
          </p>
          <div className="tones" role="radiogroup" aria-label={product.rowLabel}>
            {product.colors.map((c) => (
              // biome-ignore lint/a11y/useSemanticElements: la muestra del color es un botón dibujado con su hex (como el prototipo); se anuncia como opción de un grupo
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={c.value === choice.color}
                aria-label={c.value}
                className={cn("tone", c.value === choice.color && "on")}
                style={{ background: swatch(c.hex, c.hex2) }}
                onClick={() => onChoose({ ...choice, color: c.value })}
              />
            ))}
          </div>
        </div>
      ) : null}
      {product.sizes.length > 1 ? (
        <div>
          <p className="opt-l">
            {product.columnLabel ?? "Talla"}
            {choice.size ? (
              <>
                : <b>{choice.size}</b>
              </>
            ) : null}
          </p>
          <div
            className="sizes"
            style={
              web
                ? { gridTemplateColumns: "repeat(8, minmax(0,1fr))" }
                : product.sizes.some((z) => z.length > 3)
                  ? { gridTemplateColumns: "repeat(3, minmax(0,1fr))" }
                  : undefined
            }
          >
            {product.sizes.map((size) => {
              const variant = variantOf(page, { color: choice.color, size })
              const out = !variant?.available
              return (
                <button
                  key={size}
                  type="button"
                  className={cn("sz", out && "out", choice.size === size && "on")}
                  aria-pressed={choice.size === size}
                  aria-label={`${product.columnLabel ?? "Talla"} ${size}${out ? ", agotada" : ""}`}
                  onClick={() => onChoose({ ...choice, size })}
                >
                  {size}
                </button>
              )
            })}
          </div>
          {chosen ? (
            <p className={cn("avail mt-2", !chosen.available ? "" : chosen.left ? "low" : "ok")}>
              {!chosen.available
                ? `Se agotó la ${choice.size}${choice.color ? ` en ${choice.color}` : ""}.`
                : chosen.left
                  ? `${chosen.left === 1 ? "Queda 1" : `Quedan ${chosen.left}`} en tu ${choice.size}.`
                  : `Hay en tu ${choice.size}.`}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** Lo que diría Sofi junto a la foto, con la ficha de ahora (no es el chat: no inventa nada). */
function Bubble({
  page,
  choice,
  onChoose,
}: {
  page: Showcase
  choice: Choice
  onChoose: (choice: Choice) => void
}) {
  const said = bubble(page, choice)
  return (
    <div className="say" key={said.text}>
      <SofiFig />
      <div className="say-b">
        <p className="say-who">Sofi de {page.store.name}</p>
        <p className="say-t">{said.text}</p>
        {said.action ? (
          <div className="say-a">
            <button
              type="button"
              className="btn sm"
              onClick={() => onChoose({ ...choice, color: said.action!.color })}
            >
              {said.action.label}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** «Lo quiero»: sin talla o sin stock, dice qué falta en vez de agregar. */
function useWant(page: Showcase, choice: Choice, onWant?: (variantId: string) => void) {
  const [missing, setMissing] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: lo que falta se recalcula al elegir
  useEffect(() => setMissing(null), [choice.color, choice.size])
  const want = () => {
    const variant = variantOf(page, choice)
    if (!variant)
      return setMissing(`Elige tu ${(page.product.columnLabel ?? "talla").toLowerCase()}`)
    if (!variant.available) return setMissing("Esa no hay: elige otra")
    setMissing(null)
    onWant?.(variant.id)
  }
  return { missing, want }
}

function PriceLine({ page, choice }: { page: Showcase; choice: Choice }) {
  const { currency } = page.store
  const shown = shownPrice(page, choice)
  if (!shown) return null
  return (
    <p className="price">
      <b>{money(shown.priceCents, currency)}</b>
      {shown.priceCents < shown.listCents ? <s>{money(shown.listCents, currency)}</s> : null}
    </p>
  )
}

function Deliveries({ page }: { page: Showcase }) {
  const { currency } = page.store
  if (!page.store.deliveries.length) return null
  const free = page.store.deliveries.find((d) => d.freeFromCents)
  return (
    <section className="box">
      <h3>Cuándo llega</h3>
      {page.store.deliveries.slice(0, 3).map((d) => {
        const from = deliveryFrom(d)
        return (
          <div key={d.id} className="row">
            <span>
              <Truck
                className="mr-2 inline size-4 align-[-3px]"
                style={{ color: "var(--vv-brand-ink)" }}
                aria-hidden
              />
              {d.name}
              {d.eta ? <span className="fine"> · {d.eta}</span> : null}
            </span>
            <b>
              {from === null
                ? "Se acuerda"
                : from === 0
                  ? "Gratis"
                  : `${d.cost === "por_zona" ? "desde " : ""}${money(from, currency)}`}
            </b>
          </div>
        )
      })}
      {free?.freeFromCents ? (
        <p className="fine">
          Desde {money(free.freeFromCents, currency)}, {free.name.toLowerCase()} es gratis.
        </p>
      ) : null}
    </section>
  )
}

/** La vitrina en el celular de la clienta: la tienda con su marca, el producto y la barra de abajo. */
export function ProductPhone(props: ProductPageProps) {
  const { page, choice, onChoose, cart, deal, order } = props
  const { product, store } = page
  const now = useNow(Boolean(deal))
  const { missing, want } = useWant(page, choice, props.onWant)
  const count = cart?.count ?? 0
  const [pulse, setPulse] = useState(0)
  const previous = useRef(count)
  useEffect(() => {
    if (count > previous.current) setPulse((v) => v + 1)
    previous.current = count
  }, [count])
  const tier = product.quantityPrices[0]
  return (
    <div className="vv" style={{ ...brandStyle(store.color), height: "100%" }}>
      <div style={{ position: "absolute", inset: 0, overflowY: "auto", scrollbarWidth: "none" }}>
        <header className="hd gut">
          <Logo name={store.name} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p className="hd-name">{store.name}</p>
            {store.payments.length ? (
              <p className="hd-sub">Pagas con {store.payments.slice(0, 3).join(", ")}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Tu carrito, ${count} ${count === 1 ? "producto" : "productos"}`}
            onClick={props.onOpenCart}
          >
            <ShoppingBag className="size-5" aria-hidden />
            {count ? (
              <span key={pulse} className={cn("badge", pulse && "pulse")}>
                {count}
              </span>
            ) : null}
          </button>
        </header>
        <Gallery page={page} choice={choice} />
        <div className="gut" style={{ marginTop: -34, position: "relative", zIndex: 2 }}>
          <Bubble page={page} choice={choice} onChoose={onChoose} />
        </div>
        <div className="gut flex flex-col" style={{ gap: 18, paddingTop: 14, paddingBottom: 140 }}>
          <div className="flex flex-col" style={{ gap: 6 }}>
            <h2 className="name">{product.name || "Producto sin nombre"}</h2>
            <PriceLine page={page} choice={choice} />
            {product.stateText ? <p className="sold">{product.stateText}</p> : null}
            {tier ? (
              <span className="tier" style={{ alignSelf: "flex-start" }}>
                {tier.minQuantity} o más: {money(tier.unitPriceCents, store.currency)} cada uno
              </span>
            ) : null}
          </div>
          <Options page={page} choice={choice} onChoose={onChoose} />
          {missing ? <p className="hint">{missing}</p> : null}
          <div className="acts">
            <button type="button" className="btn grow" onClick={want}>
              Lo quiero
            </button>
            <button
              type="button"
              className="btn line"
              onClick={() =>
                document
                  .getElementById(`vv-det-${product.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              Ver detalle
            </button>
          </div>
          <div
            id={`vv-det-${product.id}`}
            className="flex flex-col"
            style={{ gap: 14, scrollMarginTop: 70 }}
          >
            {product.description ? <p style={{ fontSize: 15.5 }}>{product.description}</p> : null}
            {product.facts.length ? (
              <section className="box">
                <h3>Cómo es</h3>
                {product.facts.map((f) => (
                  <div key={f.label} className="row">
                    <span>{f.label}</span>
                    <b style={{ textAlign: "right" }}>{f.value}</b>
                  </div>
                ))}
              </section>
            ) : null}
            {product.answers.length ? (
              <section className="flex flex-col" style={{ gap: 12 }}>
                <h3>Lo que más preguntan</h3>
                {product.answers.map((a) => (
                  <div key={a.question}>
                    <p className="qa-q">{a.question}</p>
                    <div className="qa-a">
                      <SofiMini size={26} />
                      <p>{a.answer}</p>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
            <Deliveries page={page} />
            {store.payments.length ? (
              <section className="box">
                <h3>Cómo pagas</h3>
                <div className="pay">
                  {store.payments.map((p) => (
                    <span key={p}>{p}</span>
                  ))}
                </div>
              </section>
            ) : null}
            <p className="fine" style={{ textAlign: "center", paddingTop: 8 }}>
              Hecho con <b>gestorIA</b>
            </p>
          </div>
        </div>
      </div>
      <div className="bar">
        {deal && count && !order ? (
          <div className="bar-up gut">
            <Clock
              className="size-[18px] shrink-0"
              style={{ color: "var(--vv-brand-ink)" }}
              aria-hidden
            />
            <p>
              {deal.label} · vence en{" "}
              <span className="cd">{clock(new Date(deal.expiresAt).getTime() - now)}</span>
            </p>
            <button type="button" className="btn sm" onClick={props.onOpenCart}>
              Pagar
            </button>
          </div>
        ) : null}
        <div className="bar-main gut">
          {order ? (
            <>
              <button type="button" className="bar-mid" onClick={props.onOpenOrder}>
                <small>Tu pedido {order.number}</small>
                <strong>Pagado</strong>
              </button>
              <button type="button" className="btn" onClick={props.onOpenOrder}>
                <Truck className="size-[18px]" aria-hidden />
                Sigue tu pedido
              </button>
            </>
          ) : count ? (
            <>
              <button type="button" className="bar-mid" onClick={props.onOpenCart}>
                <small>
                  Tu carrito{" "}
                  <span key={pulse} className={cn("inline-block", pulse && "pulse")}>
                    ({count})
                  </span>
                </small>
                {cart?.totalCents != null ? <b>{money(cart.totalCents, store.currency)}</b> : null}
              </button>
              <button type="button" className="btn" onClick={props.onOpenCart}>
                Pagar ahora
              </button>
            </>
          ) : (
            <button
              type="button"
              className="bar-mid"
              onClick={props.onChat}
              style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
            >
              <SofiMini size={34} />
              <span className="flex flex-col">
                <strong>¿Dudas? Pregúntale a Sofi</strong>
                <small>Responde con lo que dice {store.name}</small>
              </span>
            </button>
          )}
        </div>
      </div>
      {props.sheets}
    </div>
  )
}

/** La misma página en la web de la tienda, en computadora, con «Tu marca». */
export function ProductWeb({ page, choice, onChoose, onWant, cart }: ProductPageProps) {
  const { product, store } = page
  const { missing, want } = useWant(page, choice, onWant)
  const { photos, videos } = mediaFor(page, choice.color)
  const thumbs = [
    ...photos
      .slice(0, 1)
      .map((p) => ({ id: p.id, thumb: p.miniatura, big: p.vitrina, video: false })),
    ...videos.slice(0, 1).map((v) => ({ id: v.id, thumb: v.poster, big: v.video, video: true })),
    ...photos.slice(1).map((p) => ({ id: p.id, thumb: p.miniatura, big: p.vitrina, video: false })),
  ]
  const [selected, setSelected] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de color vuelve a la primera
  useEffect(() => setSelected(0), [choice.color])
  const current = thumbs[selected] ?? thumbs[0]
  const color = product.colors.find((c) => c.value === choice.color)
  const promo = product.variants.find(
    (v) => v.promotion && (choice.color === null || v.color === choice.color),
  )?.promotion
  const count = cart?.count ?? 0
  return (
    <div className="vv vvw" style={brandStyle(store.color)}>
      <header className="top">
        <Logo name={store.name} size={40} />
        <span className="hd-name" style={{ fontSize: 22 }}>
          {store.name}
        </span>
        <nav className="nav" aria-label="Categorías">
          {product.category ? (
            <span style={{ color: "var(--vv-ink)", fontWeight: 700 }}>{product.category}</span>
          ) : null}
        </nav>
        <span className="grow" />
        <span
          className="flex items-center gap-2 text-sm"
          style={{ color: "var(--vv-ink-2)", fontWeight: 600 }}
        >
          <SofiMini size={22} />
          Sofi responde a toda hora
        </span>
        <span className="icon-btn" role="img" aria-label={`Tu carrito, ${count}`}>
          <ShoppingBag className="size-5" aria-hidden />
          {count ? <span className="badge">{count}</span> : null}
        </span>
      </header>
      <div className="cover">
        <div style={{ position: "relative", zIndex: 1, maxWidth: 560 }}>
          <p className="disp" style={{ fontSize: 34, lineHeight: 1 }}>
            {store.name}
          </p>
          {product.category ? (
            <p style={{ marginTop: 8, opacity: 0.92 }}>{product.category}</p>
          ) : null}
        </div>
      </div>
      <p className="crumbs">
        Inicio{product.category ? ` / ${product.category}` : ""} /{" "}
        <span style={{ color: "var(--vv-ink)" }}>{product.name}</span>
      </p>
      <div className="pdp">
        <div className="thumbs" role="tablist" aria-label="Fotos">
          {thumbs.map((m, j) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={j === selected}
              className={cn(j === selected && "on")}
              onClick={() => setSelected(j)}
              aria-label={m.video ? "Video" : `Foto ${j + 1}`}
            >
              <img src={m.thumb} alt="" />
            </button>
          ))}
        </div>
        <div className="big gal" style={{ backgroundColor: tint(color?.hex ?? null) }}>
          <div
            className="gal-slide"
            key={`${choice.color}-${current?.id}`}
            style={{ width: "100%" }}
          >
            {current?.video ? (
              <video src={current.big} poster={current.thumb} muted loop playsInline autoPlay />
            ) : current ? (
              <img src={current.big} alt={product.name} />
            ) : (
              <ShoppingBag className="size-24 opacity-30" aria-hidden />
            )}
          </div>
          {promo ? <span className="gal-chip sale">−{promo.percentOff} %</span> : null}
          {current?.video ? (
            <span className="gal-chip" style={{ left: "auto", right: 16 }}>
              {fmtTime(videos[0]?.durationMs ?? 0)}
            </span>
          ) : null}
        </div>
        <div className="side">
          <div className="flex flex-col" style={{ gap: 8 }}>
            <h1 className="name" style={{ margin: 0 }}>
              {product.name}
            </h1>
            <PriceLine page={page} choice={choice} />
            {product.stateText ? <p className="sold">{product.stateText}</p> : null}
          </div>
          <Bubble page={page} choice={choice} onChoose={onChoose} />
          <Options page={page} choice={choice} onChoose={onChoose} web />
          {missing ? <p className="hint">{missing}</p> : null}
          <div className="acts">
            <button type="button" className="btn grow" onClick={want}>
              Lo quiero
            </button>
            <span className="btn line">
              <SofiMini size={20} />
              Pregúntale a Sofi
            </span>
          </div>
          <Deliveries page={page} />
          {product.description ? <p className="muted">{product.description}</p> : null}
        </div>
      </div>
      {product.combina.length ? (
        <>
          <h3 style={{ padding: "0 48px", fontSize: 24 }}>Combina con</h3>
          <div className="more">
            {product.combina.slice(0, 4).map((other) => (
              <div key={other.id} className="card flex flex-col gap-2">
                {other.photo ? <img src={other.photo} alt="" /> : <span className="card-empty" />}
                <span style={{ fontWeight: 600 }}>{other.name}</span>
                <b className="disp" style={{ fontSize: 18, fontWeight: 700 }}>
                  {money(other.priceCents, store.currency)}
                </b>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <footer className="foot">
        <Logo name={store.name} size={28} />
        <span>
          <b style={{ color: "var(--vv-ink)" }}>{store.name}</b> · Hecho con gestorIA
        </span>
      </footer>
    </div>
  )
}
