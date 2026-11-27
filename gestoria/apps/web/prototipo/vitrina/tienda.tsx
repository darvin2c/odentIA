import { cn } from "@odentia/ui"
import { Check, ChevronRight, Clock, CreditCard, MessageCircle, Minus, Play, Plus, ShoppingBag, Smartphone, Truck, X } from "lucide-react"
import { type CSSProperties, type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react"
import { type Dato, DISTRITOS, foto, type Media, type Producto, type Rubro, videoSrc } from "../datos"
import { autoUnit, basePrice, key, money, promoFor } from "../precio"
import { type Compra, cuentas, globo, lineaTexto, reloj, useAhora } from "./compra"
import { Logo, marca, SofiFig, SofiMini, vendidos } from "./marcos"
import { type Ctx, pagar } from "./sofi-chat"

/**
 * La vitrina: el catálogo por link de la tienda, con su marca. La ve la clienta y la usa la prueba:
 * todo sale de la ficha de ahora (fotos, colores con su código, tallas con su stock, precio y promoción,
 * y lo que diría Sofi). El carrito es el mismo del chat.
 */

type Set = Dispatch<SetStateAction<Compra>>

const tint = (hex: string, pct = 16) => `color-mix(in oklab, ${hex} ${pct}%, white)`

function useSel(p: Producto, c: Compra) {
  const color = p.colors.find((x) => x.id === c.sel.color) ?? p.colors[0]
  const size = c.sel.size && p.sizes.includes(c.sel.size) ? c.sel.size : null
  return { color, size }
}

function precioDe(p: Producto, color: string, size: string | null) {
  // Sin talla elegida, el precio de siempre: no el de una promoción que es solo para una talla.
  const z = size ?? p.sizes.find((s) => !p.promos.some((x) => x.alcance === `col:${s}`)) ?? p.sizes[0] ?? "Única"
  const base = basePrice(p, color, z)
  const pr = promoFor(p, color, z)
  const [auto] = autoUnit(p, color, z, 1)
  return { base, auto, pr }
}

/** Galería que se pasa con el dedo; al cambiar de color, la foto de ese color entra con su animación. */
function Galeria({ p, color, alto }: { p: Producto; color: string; alto?: string }) {
  const c = p.colors.find((x) => x.id === color)
  const fotos = [...p.media.filter((m) => m.color === color), ...p.media.filter((m) => m.color !== color)]
  const [i, setI] = useState(0)
  const track = useRef<HTMLDivElement>(null)
  useEffect(() => {
    track.current?.scrollTo({ left: 0 })
    setI(0)
  }, [color])
  const pr = p.promos.find((x) => x.alcance === `row:${color}` || x.alcance === "todo")
  return (
    <div className="gal" style={{ backgroundColor: c ? tint(c.hex, c.hex.toLowerCase() === "#ffffff" ? 0 : 18) : undefined }}>
      <div ref={track} className="gal-track" onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}>
        {fotos.map((m: Media) => (
          <div key={`${color}-${m.id}`} className="gal-slide" style={alto ? { aspectRatio: alto } : undefined}>
            {m.kind === "video" ? (
              <video src={videoSrc(m.src)} poster={foto(m.poster ?? "")} muted loop playsInline autoPlay aria-label="Video del producto" />
            ) : (
              <img src={foto(m.src)} alt={`${p.name}${c ? ` ${c.name}` : ""}`} />
            )}
          </div>
        ))}
      </div>
      {pr ? <span className="gal-chip sale">−{pr.pct} %</span> : p.media.some((m) => m.kind === "video") ? (
        <span className="gal-chip">
          <Play className="mr-1 inline size-3 fill-current" aria-hidden />
          Con video
        </span>
      ) : null}
      {fotos.length > 1 ? (
        <div className="gal-dots" aria-hidden>
          {fotos.map((m, j) => (
            <i key={m.id} className={cn(j === i && "on")} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Opciones({ x, c, set, web }: { x: Ctx; c: Compra; set: Set; web?: boolean }) {
  const { p, R } = x
  const { color, size } = useSel(p, c)
  const n = color && size ? (p.stock[key(color.id, size)] ?? 0) : null
  return (
    <>
      {p.colors.length ? (
        <div>
          <p className="opt-l">
            {R.row}: <b>{color?.name}</b>
          </p>
          <div className="tones" role="radiogroup" aria-label={R.row}>
            {p.colors.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={k.id === color?.id}
                aria-label={k.name}
                className={cn("tone", k.id === color?.id && "on")}
                style={{ background: k.hex2 ? `linear-gradient(135deg, ${k.hex} 50%, ${k.hex2} 50%)` : k.hex }}
                onClick={() => set((cc) => ({ ...cc, sel: { ...cc.sel, color: k.id } }))}
              />
            ))}
          </div>
        </div>
      ) : null}
      {R.col && p.sizes.length > 1 ? (
        <div>
          <p className="opt-l">
            {R.col}
            {size ? (
              <>
                : <b>{size}</b>
              </>
            ) : null}
          </p>
          <div className="sizes" style={web ? { gridTemplateColumns: "repeat(8, minmax(0,1fr))" } : p.sizes.some((z) => z.length > 3) ? { gridTemplateColumns: "repeat(3, minmax(0,1fr))" } : undefined}>
            {p.sizes.map((z) => {
              const out = (p.stock[key(color?.id ?? "", z)] ?? 0) === 0
              return (
                <button
                  key={z}
                  type="button"
                  className={cn("sz", out && "out", size === z && "on")}
                  aria-pressed={size === z}
                  aria-label={`${R.col} ${z}${out ? ", agotada" : ""}`}
                  onClick={() => set((cc) => ({ ...cc, sel: { ...cc.sel, size: z } }))}
                >
                  {z}
                </button>
              )
            })}
          </div>
          {n != null ? (
            <p className={cn("avail mt-2", n === 0 ? "" : n <= 3 ? "low" : "ok")}>{n === 0 ? `Se agotó la ${size} en ${color?.name}.` : n <= 3 ? `${n === 1 ? "Queda 1" : `Quedan ${n}`} en tu ${size}.` : `Hay en tu ${size}.`}</p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function Globo({ x, c, set }: { x: Ctx; c: Compra; set: Set }) {
  const { color, size } = useSel(x.p, c)
  const g = globo(x.p, x.R, x.tpl, color?.id ?? "", size)
  return (
    <div className="say" key={g.text}>
      <SofiFig />
      <div className="say-b">
        <p className="say-who">Sofi de {x.R.store.name}</p>
        <p className="say-t">{g.text}</p>
        {g.action ? (
          <div className="say-a">
            <button type="button" className="btn sm" onClick={() => set((cc) => ({ ...cc, sel: { ...cc.sel, color: g.action!.color } }))}>
              {g.action.label}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function useQuiero(x: Ctx, c: Compra, set: Set) {
  const [falta, setFalta] = useState(false)
  const { color, size } = useSel(x.p, c)
  const quiero = () => {
    const z = x.R.col && x.p.sizes.length > 1 ? size : (x.p.sizes[0] ?? "Única")
    if (!z) return setFalta(true)
    if ((x.p.stock[key(color?.id ?? "", z)] ?? 0) === 0) return setFalta(true)
    setFalta(false)
    set((cc) => {
      const ya = cc.items.find((l) => l.pid === x.p.id && l.color === color?.id && l.size === z && !l.fijo)
      return { ...cc, items: ya ? cc.items.map((l) => (l === ya ? { ...l, qty: l.qty + 1 } : l)) : [...cc.items, { id: `${Date.now()}`, pid: x.p.id, color: color?.id ?? "", size: z, qty: 1 }] }
    })
  }
  return { falta: falta && !size ? `Elige tu ${x.R.col?.toLowerCase() ?? "opción"}` : falta ? "Esa no hay: elige otra" : "", quiero }
}

function Hoja({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div className="sheet" role="dialog" aria-label={title}>
        <span className="grab" aria-hidden />
        <button type="button" className="x" aria-label="Cerrar" onClick={onClose}>
          <X className="size-5" aria-hidden />
        </button>
        <div className="sheet-in">{children}</div>
      </div>
    </>
  )
}

/** El carrito, el pago (simulado en la prueba) y el pedido: las tres en la misma hoja y el mismo link. */
export function Hojas({ x, c, set, onChat }: { x: Ctx; c: Compra; set: Set; onChat?: () => void }) {
  const now = useAhora()
  const { R, all } = x
  const k = cuentas(all, c, now)
  const link = `${R.store.slug}.gestoria24.com/carrito/B7K2`
  const close = () => set((cc) => ({ ...cc, sheet: null }))
  if (c.sheet === "carrito")
    return (
      <Hoja title="Tu carrito" onClose={close}>
        <h2>Tu carrito</h2>
        <p className="fine" style={{ marginTop: -8 }}>
          {link}
        </p>
        {c.msgs.length && onChat ? (
          <div className="hold" style={{ flexDirection: "row", alignItems: "center" }}>
            <MessageCircle className="size-5 shrink-0" aria-hidden />
            <p className="grow">
              <b>Tu carrito está en el chat</b>
              <br />
              <span className="muted">Sofi ya lo vio</span>
            </p>
            <button type="button" className="btn line sm" onClick={onChat}>
              Ver el chat
            </button>
          </div>
        ) : null}
        {k.vigente ? (
          <div className="hold">
            <p>
              <Clock className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
              <b>{k.vigente.kind === "envio" ? "Envío gratis acordado con Sofi" : k.vigente.kind === "descuento" ? `${money(k.vigente.amount)} menos, acordado con Sofi` : "Separado para ti"}</b> · vence en <span className="cd">{reloj(k.vigente.until - now)}</span>
            </p>
            <p className="muted">Si no se paga a tiempo, vuelve a la venta y al precio de siempre.</p>
          </div>
        ) : null}
        {k.lineas.length === 0 ? <p className="muted">Tu carrito está vacío.</p> : null}
        {k.lineas.map(({ l, p, u }) =>
          p ? (
            <div key={l.id} className="it">
              <img src={foto(p.media.find((m) => m.color === l.color && m.kind === "foto")?.src ?? p.media[0]?.src ?? "")} alt="" />
              <div>
                <p style={{ fontWeight: 700 }}>{p.name}</p>
                <p className="muted">{lineaTexto(p, l, R).replace(`${p.name}`, "").replace(/^[\s,]+/, "") || "Única"}</p>
                <p className="disp" style={{ fontSize: 17, fontWeight: 700 }}>
                  {money(u)}
                  {l.fijo ? <span className="fine"> · sumado al pedido</span> : null}
                </p>
              </div>
              {l.fijo ? null : (
                <div className="stepper" role="group" aria-label="Cantidad">
                  <button type="button" aria-label="Uno menos" onClick={() => set((cc) => ({ ...cc, items: cc.items.flatMap((y) => (y.id === l.id ? (y.qty > 1 ? [{ ...y, qty: y.qty - 1 }] : []) : [y])) }))}>
                    <Minus className="size-4" aria-hidden />
                  </button>
                  <span style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>{l.qty}</span>
                  <button type="button" aria-label="Uno más" onClick={() => set((cc) => ({ ...cc, items: cc.items.map((y) => (y.id === l.id ? { ...y, qty: y.qty + 1 } : y)) }))}>
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>
              )}
            </div>
          ) : null,
        )}
        {k.lineas.length && !k.gratisMonto && k.vigente?.kind !== "envio" ? (
          <div className="flex flex-col gap-1.5">
            <p style={{ fontWeight: 600, fontSize: 14 }}>Te faltan {money(k.falta)} para el envío gratis</p>
            <div className="freebar">
              <i style={{ width: `${Math.min(100, (k.sub / (k.sub + k.falta)) * 100)}%` }} />
            </div>
          </div>
        ) : null}
        <p className="disp" style={{ fontSize: 18, fontWeight: 700 }}>
          Cómo te llega
        </p>
        {[0, 4, 5].map((i) => {
          const [d, costo] = DISTRITOS[i]!
          const on = c.dist === i
          return (
            <button key={d} type="button" className={cn("ship", on && "on")} onClick={() => set((cc) => ({ ...cc, dist: i }))} aria-pressed={on}>
              <i aria-hidden />
              <span style={{ textAlign: "left" }}>
                <b style={{ display: "block", fontSize: 14.5 }}>{i === 0 ? "Envío en Lima" : d}</b>
                <small className="muted">{i === 0 ? "Llega mañana si pides antes de las 3 pm" : i === 4 ? "Llega en 2 a 4 días" : "De lunes a sábado, de 10 a 7"}</small>
              </span>
              <b>{(on && k.envio === 0 && costo) || !costo ? "Gratis" : money(costo)}</b>
            </button>
          )
        })}
        <div className="sum">
          <div>
            <span>Productos</span>
            <span>{money(k.sub)}</span>
          </div>
          {k.desc ? (
            <div style={{ color: "var(--vv-ok)" }}>
              <span>Acordado con Sofi</span>
              <span>−{money(k.desc)}</span>
            </div>
          ) : null}
          <div>
            <span>Envío</span>
            <span>{k.envio ? money(k.envio) : "Gratis"}</span>
          </div>
          <div className="t">
            <span>Total</span>
            <b>{money(k.total)}</b>
          </div>
        </div>
        <button type="button" className="btn" disabled={!k.lineas.length} onClick={() => set((cc) => ({ ...cc, sheet: "pago" }))}>
          Pagar ahora · {money(k.total)}
        </button>
      </Hoja>
    )
  if (c.sheet === "pago")
    return (
      <Hoja title="Pagar" onClose={close}>
        <h2>Pagar {money(k.total)}</h2>
        <p className="muted">{R.store.name} · {link}</p>
        <div className="gate">
          {[
            ["Yape", Smartphone],
            ["Tarjeta", CreditCard],
          ].map(([m, Icon]) => {
            const I = Icon as typeof Smartphone
            return (
              <button key={m as string} type="button" onClick={() => set((cc) => pagar(x, cc, m as string))}>
                <I className="size-5" aria-hidden />
                <span className="grow" style={{ textAlign: "left" }}>
                  Pagar con {m as string}
                </span>
                <ChevronRight className="size-4" aria-hidden />
              </button>
            )
          })}
        </div>
        <p className="proto">Prueba: no se cobra, no mueve el stock y no cuenta en Reportes.</p>
      </Hoja>
    )
  if (c.sheet === "pedido" && c.order)
    return (
      <Hoja title="Tu pedido" onClose={close}>
        <div className="flex items-center gap-3" style={{ paddingRight: 48 }}>
          <Logo R={R} size={44} />
          <div>
            <p className="fine" style={{ fontWeight: 700 }}>
              {R.store.name}
            </p>
            <h2 style={{ padding: 0 }}>Tu pedido {c.order.num}</h2>
          </div>
        </div>
        <ol className="steps">
          {[
            ["Confirmado", "Hoy", "done"],
            ["Pagado", `Con ${c.order.method} · hoy`, "done"],
            ["Preparando", "La tienda lo alista y lo empaca; sale mañana", "now"],
            ["Salió", "Te avisamos por WhatsApp", ""],
            ["Entregado", "Te preguntamos si te llegó bien", ""],
          ].map(([t, d, s]) => (
            <li key={t} className={cn("step", s)}>
              <span className="dot">{s === "done" ? <Check className="size-4" aria-hidden /> : null}</span>
              <span>
                <b>{t}</b>
                <p className="muted">{d}</p>
              </span>
            </li>
          ))}
        </ol>
        <div className="box" style={{ background: "var(--vv-screen)" }}>
          <div className="row">
            <span>Pagaste</span>
            <b>{money(c.order.total)}</b>
          </div>
        </div>
        {onChat ? (
          <button type="button" className="btn" onClick={onChat}>
            <MessageCircle className="size-5" aria-hidden />
            Sofi te escribió por WhatsApp
          </button>
        ) : null}
        <p className="proto">Prueba: no se cobró nada ni se movió el stock.</p>
      </Hoja>
    )
  return null
}

/** La vitrina en el celular de la clienta: la tienda con su marca, el producto y el carrito fijo abajo. */
export function TiendaCelular({ x, c, set, onChat }: { x: Ctx; c: Compra; set: Set; onChat?: () => void }) {
  const now = useAhora()
  const { p, R, all } = x
  const m = marca(R)
  const { color, size } = useSel(p, c)
  const { base, auto, pr } = precioDe(p, color?.id ?? "", size)
  const k = cuentas(all, c, now)
  const n = c.items.reduce((a, l) => a + l.qty, 0)
  const { falta, quiero } = useQuiero(x, c, set)
  const [pulse, setPulse] = useState(0)
  const prev = useRef(n)
  useEffect(() => {
    if (n > prev.current) setPulse((v) => v + 1)
    prev.current = n
  }, [n])
  const otros = all.filter((q) => q.id !== p.id)
  const preguntas = [
    ...x.tpl.filter((d) => d.need && typeof p.datos[d.id] === "string" && p.datos[d.id]).slice(0, 2).map((d) => [d.label.endsWith("?") ? d.label : `¿${d.label}?`, String(p.datos[d.id])]),
    ...p.preguntas.slice(0, 2).map((q) => [q.q, q.a]),
  ]
  return (
    <div className="vv" style={{ ...m.style, height: "100%" } as CSSProperties}>
      <div style={{ position: "absolute", inset: 0, overflowY: "auto", scrollbarWidth: "none" }}>
        <header className="hd gut">
          <Logo R={R} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p className="hd-name">{R.store.name}</p>
            <p className="hd-sub">{m.sub}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={`Tu carrito, ${n} productos`} onClick={() => set((cc) => ({ ...cc, sheet: "carrito" }))}>
            <ShoppingBag className="size-5" aria-hidden />
            {n ? (
              <span key={pulse} className={cn("badge", pulse && "pulse")}>
                {n}
              </span>
            ) : null}
          </button>
        </header>
        <Galeria p={p} color={color?.id ?? ""} />
        <div className="gut" style={{ marginTop: -34, position: "relative", zIndex: 2 }}>
          <Globo x={x} c={c} set={set} />
        </div>
        <div className="gut flex flex-col" style={{ gap: 18, paddingTop: 14, paddingBottom: 140 }}>
          <div className="flex flex-col" style={{ gap: 6 }}>
            <h2 className="name">{p.name || "Producto sin nombre"}</h2>
            <p className="price">
              <b>{money(auto)}</b>
              {auto < base ? <s>{money(base)}</s> : null}
            </p>
            {pr ? <span className="tier" style={{ alignSelf: "flex-start" }}>−{pr.pct} % · {pr.nombre}</span> : null}
            <p className="sold">{vendidos(p) == null ? "Nuevo en la tienda" : <><b>{vendidos(p)} personas</b> lo compraron este mes</>}</p>
            {p.tiers[0] ? <span className="tier" style={{ alignSelf: "flex-start" }}>{p.tiers[0].desde} o más: {money(p.tiers[0].precio)} cada uno</span> : null}
          </div>
          <Opciones x={x} c={c} set={set} />
          {falta ? <p className="hint">{falta}</p> : null}
          <div className="acts">
            <button type="button" className="btn grow" onClick={quiero}>
              Lo quiero
            </button>
            <button type="button" className="btn line" onClick={() => document.getElementById(`vv-det-${p.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Ver detalle
            </button>
          </div>
          <div className="cols" aria-label="Colecciones">
            {[
              ["Llegó hoy", otros[0] ?? p],
              ["Oferta de hoy", otros[1] ?? p],
              ["Lo más pedido", otros[2] ?? p],
            ].map(([t, q]) => (
              <span key={t as string} className="col">
                <img src={foto((q as Producto).media.find((mm) => mm.kind === "foto")?.src ?? "")} alt="" />
                {t as string}
              </span>
            ))}
          </div>
          <div id={`vv-det-${p.id}`} className="flex flex-col" style={{ gap: 14, scrollMarginTop: 70 }}>
            {p.texto ? <p style={{ fontSize: 15.5 }}>{p.texto}</p> : null}
            {preguntas.length ? (
              <section className="flex flex-col" style={{ gap: 12 }}>
                <h3>Lo que más preguntan</h3>
                {preguntas.map(([q, a]) => (
                  <div key={q}>
                    <p className="qa-q">{q}</p>
                    <div className="qa-a">
                      <SofiMini size={26} />
                      <p>{a}</p>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
            <section className="box">
              <h3>Cuándo llega</h3>
              {DISTRITOS.slice(0, 2).concat([DISTRITOS[4]!]).map(([d, costo]) => (
                <div key={d} className="row">
                  <span>
                    <Truck className="mr-2 inline size-4 align-[-3px]" style={{ color: "var(--vv-brand-ink)" }} aria-hidden />
                    {d}
                  </span>
                  <b>{money(costo)}</b>
                </div>
              ))}
              <p className="fine">Desde S/ 250, el envío es gratis en Lima.</p>
            </section>
            <section className="box">
              <h3>Cómo pagas</h3>
              <div className="pay">
                {["Yape", "Plin", "Tarjeta", "Al recibir"].map((y) => (
                  <span key={y}>{y}</span>
                ))}
              </div>
            </section>
            <p className="fine" style={{ textAlign: "center", paddingTop: 8 }}>
              Hecho con <b>gestorIA</b>
            </p>
          </div>
        </div>
      </div>
      <div className="bar">
        {k.vigente && c.items.length && !c.order ? (
          <div className="bar-up gut">
            <Clock className="size-[18px] shrink-0" style={{ color: "var(--vv-brand-ink)" }} aria-hidden />
            <p>
              {k.vigente.kind === "envio" ? "Envío gratis acordado con Sofi" : k.vigente.kind === "descuento" ? `${money(k.vigente.amount)} menos con Sofi` : "Separado para ti"} · vence en <span className="cd">{reloj(k.vigente.until - now)}</span>
            </p>
            <button type="button" className="btn sm" onClick={() => set((cc) => ({ ...cc, sheet: "carrito" }))}>
              Pagar
            </button>
          </div>
        ) : null}
        <div className="bar-main gut">
          {c.order ? (
            <>
              <button type="button" className="bar-mid" onClick={() => set((cc) => ({ ...cc, sheet: "pedido" }))}>
                <small>Tu pedido {c.order.num}</small>
                <strong>Pagado · sale mañana</strong>
              </button>
              <button type="button" className="btn" onClick={() => set((cc) => ({ ...cc, sheet: "pedido" }))}>
                <Truck className="size-[18px]" aria-hidden />
                Sigue tu pedido
              </button>
            </>
          ) : n ? (
            <>
              <button type="button" className="bar-mid" onClick={() => set((cc) => ({ ...cc, sheet: "carrito" }))}>
                <small>
                  Tu carrito <span key={pulse} className={cn("inline-block", pulse && "pulse")}>({n})</span>
                </small>
                <b>{money(k.total)}</b>
              </button>
              <button type="button" className="btn" onClick={() => set((cc) => ({ ...cc, sheet: "carrito" }))}>
                Pagar ahora
              </button>
            </>
          ) : (
            <button type="button" className="bar-mid" onClick={onChat} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <SofiMini size={34} />
              <span className="flex flex-col">
                <strong>¿Dudas? Pregúntale a Sofi</strong>
                <small>Responde con lo que dice {R.store.name}</small>
              </span>
            </button>
          )}
        </div>
      </div>
      <Hojas x={x} c={c} set={set} onChat={onChat} />
    </div>
  )
}

/** La misma página del producto en la web de la tienda, en computadora, con «Tu marca». */
export function TiendaWeb({ x, c, set }: { x: Ctx; c: Compra; set: Set }) {
  const { p, R, all } = x
  const m = marca(R)
  const { color, size } = useSel(p, c)
  const { base, auto, pr } = precioDe(p, color?.id ?? "", size)
  const n = c.items.reduce((a, l) => a + l.qty, 0)
  const { falta, quiero } = useQuiero(x, c, set)
  const fotos = [...p.media.filter((mm) => mm.color === color?.id), ...p.media.filter((mm) => mm.color !== color?.id)]
  const [sel, setSel] = useState(0)
  useEffect(() => setSel(0), [color?.id])
  const cur = fotos[sel] ?? fotos[0]
  const cats = [...new Set(all.map((q) => q.cat))].slice(0, 5)
  const portada = all.find((q) => q.id !== p.id)?.media.find((mm) => mm.kind === "foto")?.src ?? m.portada
  return (
    <div className="vv vvw" style={m.style}>
      <header className="top">
        <Logo R={R} size={40} />
        <span className="hd-name" style={{ fontSize: 22 }}>
          {R.store.name}
        </span>
        <nav className="nav" aria-label="Categorías">
          {cats.map((k) => (
            <span key={k} style={k === p.cat ? { color: "var(--vv-ink)", fontWeight: 700 } : undefined}>
              {k}
            </span>
          ))}
        </nav>
        <span className="grow" />
        <span className="flex items-center gap-2 text-sm" style={{ color: "var(--vv-ink-2)", fontWeight: 600 }}>
          <SofiMini size={22} />
          Sofi responde a toda hora
        </span>
        <span className="icon-btn" aria-label={`Tu carrito, ${n}`}>
          <ShoppingBag className="size-5" aria-hidden />
          {n ? <span className="badge">{n}</span> : null}
        </span>
      </header>
      <div className="cover">
        <div style={{ position: "relative", zIndex: 1, maxWidth: 560 }}>
          <p className="disp" style={{ fontSize: 34, lineHeight: 1 }}>
            {R.store.name}
          </p>
          <p style={{ marginTop: 8, opacity: 0.92 }}>{m.lema}</p>
        </div>
        {portada ? <img src={foto(portada)} alt="" /> : null}
      </div>
      <p className="crumbs">
        Inicio / {p.cat} / <span style={{ color: "var(--vv-ink)" }}>{p.name}</span>
      </p>
      <div className="pdp">
        <div className="thumbs" role="tablist" aria-label="Fotos">
          {fotos.map((mm, j) => (
            <button key={mm.id} type="button" className={cn(j === sel && "on")} onClick={() => setSel(j)} aria-label={`Foto ${j + 1}`}>
              <img src={foto(mm.kind === "video" ? (mm.poster ?? "") : mm.src)} alt="" />
            </button>
          ))}
        </div>
        <div className="big gal" style={{ backgroundColor: color ? tint(color.hex, color.hex.toLowerCase() === "#ffffff" ? 0 : 18) : undefined }}>
          <div className="gal-slide" key={`${color?.id}-${cur?.id}`} style={{ width: "100%" }}>
            {cur?.kind === "video" ? <video src={videoSrc(cur.src)} poster={foto(cur.poster ?? "")} muted loop playsInline autoPlay /> : cur ? <img src={foto(cur.src)} alt={p.name} /> : null}
          </div>
          {pr ? <span className="gal-chip sale">−{pr.pct} %</span> : null}
        </div>
        <div className="side">
          <div className="flex flex-col" style={{ gap: 8 }}>
            <h1 className="name" style={{ margin: 0 }}>
              {p.name}
            </h1>
            <p className="price">
              <b>{money(auto)}</b>
              {auto < base ? <s>{money(base)}</s> : null}
            </p>
            <p className="sold">{vendidos(p) == null ? "Nuevo en la tienda" : <><b>{vendidos(p)} personas</b> lo compraron este mes</>}</p>
          </div>
          <Globo x={x} c={c} set={set} />
          <Opciones x={x} c={c} set={set} web />
          {falta ? <p className="hint">{falta}</p> : null}
          <div className="acts">
            <button type="button" className="btn grow" onClick={quiero}>
              Lo quiero
            </button>
            <button type="button" className="btn line">
              <SofiMini size={20} />
              Pregúntale a Sofi
            </button>
          </div>
          <div className="box" style={{ background: "var(--vv-screen)" }}>
            <div className="row">
              <span>
                <Truck className="mr-2 inline size-4 align-[-3px]" aria-hidden />
                Lima: llega mañana
              </span>
              <b>{money(DISTRITOS[0]![1])}</b>
            </div>
            <div className="row">
              <span>Provincia, por agencia</span>
              <b>{money(DISTRITOS[4]![1])}</b>
            </div>
            <p className="fine">Pagas con Yape, Plin, tarjeta o al recibir. Desde S/ 250, el envío es gratis.</p>
          </div>
          {p.texto ? <p className="muted">{p.texto}</p> : null}
        </div>
      </div>
      {all.length > 1 ? (
        <>
          <h3 style={{ padding: "0 48px", fontSize: 24 }}>Combina con</h3>
          <div className="more">
            {all
              .filter((q) => q.id !== p.id)
              .slice(0, 4)
              .map((q) => (
                <div key={q.id} className="card flex flex-col gap-2">
                  <img src={foto(q.media.find((mm) => mm.kind === "foto")?.src ?? "")} alt="" />
                  <span style={{ fontWeight: 600 }}>{q.name}</span>
                  <b className="disp" style={{ fontSize: 18, fontWeight: 700 }}>
                    {money(q.list)}
                  </b>
                </div>
              ))}
          </div>
        </>
      ) : null}
      <footer className="foot">
        <Logo R={R} size={28} />
        <span>
          <b style={{ color: "var(--vv-ink)" }}>{R.store.name}</b> · Hecho con gestorIA
        </span>
      </footer>
    </div>
  )
}
