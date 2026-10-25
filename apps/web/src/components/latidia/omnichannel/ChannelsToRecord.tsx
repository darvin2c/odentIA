// Seis canales, una ficha (lienzo de latidIA, tablero «Omnicanal»): a la izquierda los canales del
// consultorio y, por su cable, cada mensaje de Rosa llega a su ficha y se suma a una sola línea de
// tiempo (Instagram el lunes, WhatsApp hoy, el chat web). Abajo, «Responder por» elige el canal de
// la respuesta, como en la Bandeja. Con movimiento reducido se ve el estado final, quieto.
import { useEffect, useState } from "react"
import "./channels-to-record.css"

type Channel = "whatsapp" | "instagram" | "messenger" | "telegram" | "web" | "correo"

/** Colores de cada canal (los de su marca), solo para su icono y su cable. */
const CH: Record<Channel, { name: string; letter: string; color: string; text: string }> = {
  whatsapp: { name: "WhatsApp", letter: "W", color: "#25d366", text: "#15803d" },
  instagram: { name: "Instagram", letter: "I", color: "#d6249f", text: "#b5157f" },
  messenger: { name: "Messenger", letter: "M", color: "#0a7cff", text: "#0a6ad9" },
  telegram: { name: "Telegram", letter: "T", color: "#229ed9", text: "#1677a6" },
  web: { name: "Chat web", letter: "C", color: "#6d3fc0", text: "#6d3fc0" },
  correo: { name: "Correo", letter: "@", color: "#475569", text: "#475569" },
}
const ORDER: Channel[] = ["whatsapp", "instagram", "messenger", "telegram", "web", "correo"]

type Msg = { ch: Channel; who: "in" | "sofi" | "event"; meta: string; text: string }
const ALL: Msg[] = [
  { ch: "instagram", who: "in", meta: "Instagram · lunes 19:40", text: "Hola, ¿cuánto cuesta la consulta de medicina general?" },
  {
    ch: "instagram",
    who: "sofi",
    meta: "Sofi · Instagram",
    text: "Hola, Rosa. La consulta de medicina general cuesta S/ 80, con la Dra. Elena Vela. ¿Quieres que te reserve una hora?",
  },
  { ch: "whatsapp", who: "in", meta: "WhatsApp · hoy 07:55", text: "Buenos días. Me duele mucho la cabeza, ¿hay cita para hoy?" },
  { ch: "whatsapp", who: "sofi", meta: "Sofi · WhatsApp", text: "Hoy a las 09:00 en la Sala 1, con la Dra. Vela. ¿Te la reservo?" },
  { ch: "whatsapp", who: "in", meta: "WhatsApp · 07:57", text: "Sí, por favor." },
  { ch: "whatsapp", who: "event", meta: "Agenda", text: "Cita reservada por Sofi · hoy 09:00 · Sala 1 · Consulta por dolor de cabeza" },
  { ch: "web", who: "in", meta: "Chat web · 08:20", text: "¿Qué días atienden?" },
  { ch: "web", who: "sofi", meta: "Sofi · Chat web", text: "De lunes a sábado, en Av. Perú 1820, San Martín de Porres." },
]
const LAST = ALL.length

/** «Responder por»: el canal, lo que dice el campo y una nota de por dónde le llega. */
const REPLY: [Channel, string, string][] = [
  ["whatsapp", "Escribe a Rosa por WhatsApp…", "Último canal donde escribió. Dentro de las 24 horas desde su mensaje: escribes libre."],
  ["instagram", "Escribe a Rosa por Instagram…", "Le llega en su chat de Instagram, en el mismo hilo del lunes."],
  ["web", "Escribe a Rosa por el chat web…", "Le llega en el chat de tu web."],
  ["correo", "Escribe un correo a Rosa…", "Sale desde el correo del consultorio."],
]

export default function ChannelsToRecord() {
  // Se arma en el servidor con la línea de tiempo completa: sin JavaScript o con movimiento reducido, se lee entera.
  const [step, setStep] = useState(LAST)
  const [reply, setReply] = useState<Channel>("whatsapp")

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

  const shown = ALL.slice(0, step)
  const moving = step < LAST
  const active = moving && shown.length ? shown[shown.length - 1].ch : null
  const counts: Partial<Record<Channel, number>> = {}
  for (const m of shown) if (m.who !== "event") counts[m.ch] = (counts[m.ch] ?? 0) + 1
  const used = Object.keys(counts).length
  const [, placeholder, note] = REPLY.find(([id]) => id === reply) ?? REPLY[0]

  return (
    <div className="cr">
      <ul className="cr-chs" aria-label="Canales del consultorio">
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
              stroke={on ? CH[k].color : counts[k] ? "#cbb6f5" : "#e9e2f7"}
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
            RP
          </span>
          <span className="cr-who">
            <b>Rosa Paredes Luna</b>
            <span>46 años · una ficha, una historia clínica</span>
          </span>
          <span className="cr-pills">
            <span>Conversaciones</span>
            <span className="cr-count">
              {used} {used === 1 ? "canal" : "canales"}
            </span>
          </span>
        </div>
        <div className="cr-thread" aria-live="polite">
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
        <div className="cr-reply">
          <fieldset className="cr-by">
            <legend>Responder por</legend>
            {REPLY.map(([id]) => (
              <button key={id} type="button" aria-pressed={reply === id} onClick={() => setReply(id)}>
                {CH[id].name}
              </button>
            ))}
          </fieldset>
          <div className="cr-box">
            <span className="cr-field">{placeholder}</span>
            <span className="cr-send" aria-hidden="true">
              ↑
            </span>
          </div>
          <span className="cr-note" aria-live="polite">
            {note}
          </span>
        </div>
      </div>
      <span className="cr-foot">Demostración con datos de ejemplo. Rosa escribe por tres canales y todo queda en su ficha.</span>
    </div>
  )
}
