// Seis canales, una ficha (odentIA, /omnicanal): a la izquierda los canales de la clínica y, por su
// cable, cada mensaje llega a la ficha de Lucía y se suma a una sola línea de tiempo (Instagram el
// lunes, WhatsApp de su mamá, el correo de confirmación). Abajo, «Responder por» elige el canal de la
// respuesta como en la Bandeja: un menú con el canal y si su ventana sigue abierta. Con movimiento
// reducido se ve el estado final, quieto. Los nombres, textos y estados son los de la aplicación.
import { useEffect, useId, useRef, useState } from "react"
import "./channels-to-record.css"

type Channel = "whatsapp" | "instagram" | "messenger" | "telegram" | "web" | "correo"

/** Colores de cada canal (los de su marca), solo para su icono y su cable. */
const CH: Record<Channel, { name: string; letter: string; color: string; text: string }> = {
  whatsapp: { name: "WhatsApp", letter: "W", color: "#25d366", text: "#15803d" },
  instagram: { name: "Instagram", letter: "I", color: "#d6249f", text: "#b5157f" },
  messenger: { name: "Messenger", letter: "M", color: "#0a7cff", text: "#0a6ad9" },
  telegram: { name: "Telegram", letter: "T", color: "#229ed9", text: "#1677a6" },
  web: { name: "Chat web", letter: "C", color: "#0e7490", text: "#0e7490" },
  correo: { name: "Correo", letter: "@", color: "#475569", text: "#475569" },
}
const ORDER: Channel[] = ["whatsapp", "instagram", "messenger", "telegram", "web", "correo"]

type Msg = { ch: Channel; who: "in" | "sofi" | "event"; meta: string; text: string }
// Datos de ejemplo: Clínica Sonrisa Norte, Lucía y Carmen son inventadas.
const ALL: Msg[] = [
  { ch: "instagram", who: "in", meta: "Instagram · Lucía · lunes 19:40", text: "Hola, ¿cuánto me falta para que me quiten los brackets?" },
  {
    ch: "instagram",
    who: "sofi",
    meta: "Sofi · Instagram",
    text: "Hola, Lucía. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. En tu control del martes 28 la Dra. Paredes te dirá cuánto falta. ¿Te lo recuerdo un día antes?",
  },
  { ch: "instagram", who: "in", meta: "Instagram · Lucía · 19:42", text: "Sí, porfa." },
  { ch: "whatsapp", who: "in", meta: "WhatsApp · Carmen, su mamá · hoy 08:10", text: "Hola, soy la mamá de Lucía. ¿Podemos pasar su control del martes al viernes?" },
  { ch: "whatsapp", who: "sofi", meta: "Sofi · WhatsApp", text: "Hola, Carmen. Claro: tengo el viernes 31 a las 16:00 con la Dra. Paredes. ¿Te lo dejo?" },
  { ch: "whatsapp", who: "in", meta: "WhatsApp · Carmen · 08:12", text: "Sí, por favor." },
  { ch: "whatsapp", who: "event", meta: "Agenda", text: "Cita movida por Sofi · viernes 31 · 16:00 · Control de ortodoncia" },
  {
    ch: "correo",
    who: "sofi",
    meta: "Sofi · Correo",
    text: "Confirmación para Carmen: control de ortodoncia de Lucía, viernes 31 a las 16:00, con la Dra. Paredes.",
  },
]
const LAST = ALL.length

/** «Responder por»: el canal, si su ventana sigue abierta y lo que dice la nota debajo del campo. */
const REPLY: { id: Channel; window: string; field: string; note: string }[] = [
  {
    id: "whatsapp",
    window: "abierto",
    field: "Escribe un mensaje… (Enter para enviar)",
    note: "Carmen escribió hoy: dentro de las 24 horas escribes libre.",
  },
  {
    id: "instagram",
    window: "pasaron 24 horas",
    field: "Instagram no deja escribirle hasta que vuelva a escribir",
    note: "Pasaron 24 horas desde que Lucía escribió por Instagram. Instagram no deja escribirle hasta que vuelva a escribir.",
  },
  {
    id: "correo",
    window: "abierto",
    field: "Escribe un correo… (Enter para enviar)",
    note: "Sale desde el correo de la clínica.",
  },
]

export default function ChannelsToRecord() {
  // Se arma en el servidor con la línea de tiempo completa: sin JavaScript o con movimiento reducido, se lee entera.
  const [step, setStep] = useState(LAST)
  const [reply, setReply] = useState<Channel>("whatsapp")
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    setStep(0)
    const timer = window.setInterval(() => {
      setStep((s) => {
        if (s >= LAST - 1) window.clearInterval(timer)
        return Math.min(s + 1, LAST)
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])

  // El menú se cierra con Escape o al tocar fuera, como los de la aplicación.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        box.current?.querySelector<HTMLButtonElement>(".cr-by-trigger")?.focus()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onDown)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onDown)
    }
  }, [open])

  const shown = ALL.slice(0, step)
  const moving = step < LAST
  const active = moving && shown.length ? shown[shown.length - 1].ch : null
  const counts: Partial<Record<Channel, number>> = {}
  for (const m of shown) if (m.who !== "event") counts[m.ch] = (counts[m.ch] ?? 0) + 1
  const used = Object.keys(counts).length
  const current = REPLY.find((r) => r.id === reply) ?? REPLY[0]
  const closed = current.window !== "abierto"

  return (
    <div className="cr">
      <ul className="cr-chs" aria-label="Canales de la clínica">
        {ORDER.map((k) => {
          const n = counts[k] ?? 0
          return (
            <li key={k} className={`cr-ch${k === active ? " on" : n ? " used" : ""}`}>
              <span className="cr-ico" aria-hidden="true" style={{ background: CH[k].color, opacity: n ? 1 : 0.45 }}>
                {CH[k].letter}
              </span>
              <span className="cr-ch-text">
                <b>{CH[k].name}</b>
                <span>{n ? `${n} ${n === 1 ? "mensaje" : "mensajes"}` : "Conectado"}</span>
              </span>
            </li>
          )
        })}
      </ul>
      <svg className="cr-wire" viewBox="0 0 80 352" width="80" height="352" aria-hidden="true">
        {ORDER.map((k, i) => {
          const y = 26 + i * 60
          const on = k === active
          return (
            <path
              key={k}
              d={`M0 ${y} C40 ${y} 40 176 76 176`}
              fill="none"
              stroke={on ? CH[k].color : counts[k] ? "#8fd0de" : "#d9e6ea"}
              strokeWidth={on ? 2.5 : 1.5}
              className={on ? "cr-flow" : undefined}
            />
          )
        })}
        <circle cx="76" cy="176" r="5" fill="var(--teal)" />
      </svg>
      <div className="cr-rec">
        <div className="cr-rec-head">
          <span className="cr-av" aria-hidden="true">
            LR
          </span>
          <span className="cr-who">
            <b>Lucía Ramos</b>
            <span>Paciente · 14 años · una ficha, una historia clínica</span>
          </span>
          <span className="cr-pills">
            <span>Conversaciones</span>
            <span className="cr-count">
              {used} {used === 1 ? "canal" : "canales"}
            </span>
          </span>
        </div>
        <div className="cr-thread" aria-live="polite">
          {shown.length === 0 && (
            <div className="cr-empty">
              <b>Todavía no ha escrito</b>
              <span>Cuando escriba, o le escriba el equipo, su conversación aparece aquí.</span>
            </div>
          )}
          {shown.map((m) =>
            m.who === "event" ? (
              <span key={m.text} className="cr-event">
                {m.text}
              </span>
            ) : (
              <div key={m.text} className={`cr-msg${m.who === "sofi" ? " out" : ""}`}>
                <span className="cr-meta" style={{ color: m.who === "sofi" ? "#0e7490" : CH[m.ch].text }}>
                  {m.meta.toUpperCase()}
                </span>
                <span className="cr-bubble">{m.text}</span>
              </div>
            ),
          )}
        </div>
        <div className="cr-reply" ref={box}>
          <div className="cr-by">
            <span className="cr-by-label">Responder por:</span>
            <button
              type="button"
              className="cr-by-trigger"
              aria-haspopup="true"
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={`Responder por ${CH[current.id].name}, ${current.window}. Cambiar de canal`}
              onClick={() => setOpen((o) => !o)}
            >
              <b>{CH[current.id].name}</b>
              <span>· {current.window}</span>
              <span aria-hidden="true" className="cr-by-caret">
                ▾
              </span>
            </button>
            {open && (
              <ul className="cr-menu" id={menuId}>
                {REPLY.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-current={r.id === reply || undefined}
                      onClick={() => {
                        setReply(r.id)
                        setOpen(false)
                      }}
                    >
                      <b>{CH[r.id].name}</b>
                      <span> · {r.window}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="cr-box">
            <span className={`cr-field${closed ? " off" : ""}`}>{current.field}</span>
            <span className={`cr-send${closed ? " off" : ""}`} aria-hidden="true">
              ↑
            </span>
          </div>
          <span className="cr-note" aria-live="polite">
            {current.note}
          </span>
        </div>
      </div>
      <span className="cr-foot">Demostración con datos de ejemplo. Lucía y su mamá escriben por tres canales y todo queda en una ficha.</span>
    </div>
  )
}
