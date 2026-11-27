import { cn } from "@odentia/ui"
import { ArrowLeft, SendHorizontal } from "lucide-react"
import { type CSSProperties, type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react"
import { foto, videoSrc } from "../datos"
import { money } from "../precio"
import { type Compra, cuentas, type Msg } from "./compra"
import { Logo, marca, SofiMini } from "./marcos"
import { boton, type Ctx, escribe, info } from "./sofi-chat"

/**
 * El WhatsApp de la clienta con la tienda: sus mensajes a la derecha, los de Sofi a la izquierda, los
 * links con su vista previa y los botones dentro del mensaje. Colores neutros: no copia la marca de
 * WhatsApp. Lo de información se vuelve a calcular con la ficha de ahora.
 */
export function ChatCelular({ x, c, set, onVitrina }: { x: Ctx; c: Compra; set: Dispatch<SetStateAction<Compra>>; onVitrina: () => void }) {
  const { p, R, all } = x
  const m = marca(R)
  const [text, setText] = useState("")
  const [typing, setTyping] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const k = cuentas(all, c)

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" })
  }, [c.msgs.length, typing])

  const send = (t: string) => {
    if (!t.trim() || typing) return
    setText("")
    const r = escribe(x, c, t.trim())
    set(r.c)
    setTyping(true)
    setTimeout(() => {
      setTyping(false)
      set((cc) => ({ ...cc, msgs: [...cc.msgs, ...r.so] }))
    }, 750)
  }
  const tap = (kk: string) => {
    if (kk === "ver-carrito") {
      set((cc) => ({ ...cc, sheet: "carrito", tab: "vitrina" }))
      onVitrina()
      return
    }
    const r = boton(x, c, kk)
    set(r.c)
    setTyping(true)
    setTimeout(() => {
      setTyping(false)
      set((cc) => ({ ...cc, msgs: [...cc.msgs, ...r.so] }))
    }, 650)
  }

  const quick = c.quick.length ? c.quick : c.msgs.length ? [] : R.sugeridas.slice(0, 3).concat([`Quiero la ${p.colors.at(-1)?.name ?? ""} en ${p.sizes[3] ?? p.sizes[0]}`])
  const lastSo = c.msgs.map((mm) => mm.who).lastIndexOf("so")

  const render = (mm: Msg, i: number) => {
    if (mm.who === "dia")
      return (
        <p key={i} className="dia">
          {mm.text}
        </p>
      )
    const live = mm.q ? info(x, mm.q, !!mm.first) : null
    // «p. m.» ya trae su punto: no se repite al cerrar la frase.
    const t = (live ? live.text : mm.text).replace(/m\.\./g, "m.")
    const img = live ? live.img : mm.img
    const video = live ? live.video : mm.video
    return (
      <div key={i} className={cn("msg", mm.who)}>
        {mm.who === "so" ? (
          <p className="who">
            <SofiMini size={16} />
            Sofi
          </p>
        ) : null}
        {video ? <video className="media" src={videoSrc(video)} poster={foto(img ?? "")} controls muted playsInline /> : img ? <img className="media" src={foto(img)} alt="" /> : null}
        <span>{t}</span>
        {mm.card ? (
          <span className="lp">
            <img src={foto(c.items[0] ? (p.media.find((q) => q.color === c.items[0]!.color && q.kind === "foto")?.src ?? p.media[0]?.src ?? "") : (p.media[0]?.src ?? ""))} alt="" />
            <span>
              <b>Tu carrito en {R.store.name}</b>
              <span style={{ fontSize: 13, color: "var(--vv-ink-2)" }}>{money(k.total)}{k.vigente ? ` · vence en 24 h` : ""}</span>
              <span>{R.store.slug}.gestoria24.com/carrito/B7K2</span>
            </span>
          </span>
        ) : null}
        <span className="h">{new Date().toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" })}</span>
        {mm.btns && i === lastSo ? (
          <span className="msg-btns" role="group" aria-label="Respuestas">
            {mm.btns.map((b) => (
              <button key={b.k} type="button" onClick={() => tap(b.k)}>
                {b.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="vv" style={{ ...m.style, height: "100%" } as CSSProperties}>
      <div className="ch">
        <div className="ch-head gut">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <Logo R={R} size={38} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, lineHeight: 1.2 }}>{R.store.name}</p>
            <p className="ch-sub">Cuenta de empresa · responde Sofi</p>
          </div>
        </div>
        <p className="ch-strip">Prueba: no se envía nada ni se cobra.</p>
        <div ref={body} className="ch-body" aria-live="polite">
          {c.msgs.length === 0 ? <p className="dia">Escribe como clienta o toca una sugerencia</p> : null}
          {c.msgs.map(render)}
          {typing ? (
            <div className="msg so">
              <span className="typing" aria-label="Sofi está escribiendo">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}
        </div>
        {quick.length ? (
          <div className="quick">
            <p className="quick-l">Lo que podría escribir la clienta</p>
            <div className="quick-row">
              {quick.map((q) => (
                <button key={q} type="button" className="qchip" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <form
          className="ch-input"
          onSubmit={(e) => {
            e.preventDefault()
            send(text)
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe como clienta" aria-label="Mensaje de la clienta (prueba)" />
          <button type="submit" className="send" aria-label="Enviar">
            <SendHorizontal className="size-5" aria-hidden />
          </button>
        </form>
      </div>
    </div>
  )
}

/** En WhatsApp: cómo manda Sofi este producto cuando lo piden, con la ficha de ahora. */
export function ChatMuestra({ x }: { x: Ctx }) {
  const { p, R } = x
  const m = marca(R)
  const color = p.colors.at(-1) ?? p.colors[0]
  const size = p.sizes.find((z) => color && (p.stock[`${color.id}|${z}`] ?? 0) > 0) ?? p.sizes[0] ?? "Única"
  const n = color ? (p.stock[`${color.id}|${size}`] ?? 0) : 0
  const ph = p.media.find((q) => q.color === color?.id && q.kind === "foto") ?? p.media[0]
  const precio = color ? (p.prices[`${color.id}|${size}`] ?? p.list) : p.list
  const pide = `Hola, ¿tienes ${p.colors.length > 1 && color ? `la ${color.name}` : `${p.name.toLowerCase()}`}${R.col && size !== "Única" ? ` en ${size}` : ""}?`
  const resp = `¡Hola! Soy Sofi, de ${R.store.name}. Sí: ${p.name.toLowerCase()}${p.colors.length > 1 && color ? ` ${color.name}` : ""}${R.col && size !== "Única" ? ` ${size}` : ""} está a ${money(precio)}${n && n <= 5 ? ` y me ${n === 1 ? "queda 1" : `quedan ${n}`}` : ""}. ¿Te ${p.name.toLowerCase().startsWith("audí") ? "los" : "la"} separo?`
  return (
    <div className="vv" style={{ ...m.style, height: "100%" } as CSSProperties}>
      <div className="ch">
        <div className="ch-head gut">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <Logo R={R} size={38} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, lineHeight: 1.2 }}>{R.store.name}</p>
            <p className="ch-sub">Cuenta de empresa · responde Sofi</p>
          </div>
        </div>
        <div className="ch-body">
          <p className="dia">Hoy</p>
          <div className="msg me">
            <span>{pide}</span>
            <span className="h">10:41</span>
          </div>
          <div className="msg so">
            <p className="who">
              <SofiMini size={16} />
              Sofi
            </p>
            {ph ? <img className="media" src={foto(ph.kind === "video" ? (ph.poster ?? "") : ph.src)} alt="" /> : null}
            <span>{resp}</span>
            <span className="lp">
              {ph ? <img src={foto(ph.kind === "video" ? (ph.poster ?? "") : ph.src)} alt="" /> : <span />}
              <span>
                <b>{p.name}</b>
                <span style={{ fontSize: 13, color: "var(--vv-ink-2)" }}>{money(precio)} · {R.store.name}</span>
                <span>
                  {R.store.slug}.gestoria24.com/{p.web.slug || "nuevo"}
                </span>
              </span>
            </span>
            <span className="h">10:41</span>
            <span className="msg-btns">
              <button type="button">Sí, sepáramela</button>
              <button type="button">Ver en la vitrina</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
