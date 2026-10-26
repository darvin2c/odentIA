// 01 · Omnicanal: una conversación que cambia de canal y sigue en la misma ficha.
// El HTML generado trae la conversación completa; al verla, se reproduce paso a paso.
import { useEffect, useRef, useState } from "react"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

const OC = [
  {
    ch: "Instagram",
    who: "Lucía",
    side: "in",
    text: "Hola, ¿cuánto me falta para que me quiten los brackets?",
  },
  {
    ch: "Instagram",
    who: "Sofi",
    side: "out",
    text: "Hola, Lucía. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. En tu control del martes 28 la Dra. Paredes te dirá cuánto falta. ¿Te lo recuerdo un día antes?",
  },
  { ch: "Instagram", who: "Lucía", side: "in", text: "Sí, porfa." },
  {
    ch: "WhatsApp",
    who: "Carmen, su mamá",
    side: "in",
    text: "Hola, soy la mamá de Lucía. ¿Podemos pasar su control del martes al viernes?",
  },
  {
    ch: "WhatsApp",
    who: "Sofi",
    side: "out",
    text: "Hola, Carmen. Claro: tengo el viernes 31 a las 16:00 con la Dra. Paredes. ¿Te lo dejo?",
  },
  { ch: "WhatsApp", who: "Carmen, su mamá", side: "in", text: "Sí, por favor." },
  {
    ch: "Correo",
    who: "Sofi",
    side: "out",
    text: "Confirmación para Carmen: control de ortodoncia de Lucía, viernes 31 a las 16:00, con la Dra. Paredes.",
  },
]
const CH = ["WhatsApp", "Instagram", "Messenger", "Telegram", "Chat de tu web", "Correo"]

export default function Omnichannel() {
  const moving = useMoving()
  const [oc, setOc] = useState(OC.length)
  const hold = useRef(0)

  // Al aparecer en pantalla empieza desde el primer mensaje (salvo con menos movimiento).
  useEffect(() => {
    if (!prefersReducedMotion()) setOc(0)
  }, [])

  useInterval(() => {
    if (!moving) return
    if (oc < 7) setOc(oc + 1)
    else if (++hold.current > 5) {
      hold.current = 0
      setOc(0)
    }
  }, 1150)

  const shown = OC.slice(0, Math.min(oc, OC.length))
  const used: Record<string, boolean> = {}
  shown.forEach((m) => {
    used[m.ch] = true
  })
  const last = shown.length ? shown[shown.length - 1].ch : ""
  const nUsed = Object.keys(used).length

  return (
    <div className="oc">
      <div className="oc-side">
        <span className="tag oc-tag">Por donde te escriben</span>
        {CH.map((c) => (
          <div key={c} className={"chrow" + (used[c] ? " used" : "") + (c === last ? " on" : "")}>
            <span className="cdot" aria-hidden="true"></span>
            <span>{c}</span>
            <span className="mono chstate">
              {used[c] ? (c === last ? "escribiendo ahora" : "en esta conversación") : "conectado"}
            </span>
          </div>
        ))}
        <div className="card oc-person">
          <div className="oc-who">
            <span className="oc-av" aria-hidden="true">
              LR
            </span>
            <span className="stack">
              <strong>Lucía Ramos</strong>
              <span className="mono">Paciente · 14 años</span>
            </span>
          </div>
          <span className="oc-txt">
            Carmen, su mamá, es quien agenda y paga. Las dos escriben por canales distintos y todo
            queda en la misma ficha, sin duplicados y sin adivinar quién es por su número.
          </span>
        </div>
      </div>
      <div className="oc-chat">
        {/* «Volver a ver» va arriba, junto al primer mensaje: al tocarlo se ve empezar la conversación. */}
        <div className="oc-head">
          <span className="stack oc-title">
            <strong>Conversación con Lucía Ramos</strong>
            <span className="mono">
              {nUsed + (nUsed === 1 ? " canal" : " canales") + " · 1 historia"}
            </span>
          </span>
          <button
            type="button"
            className="mono replay"
            onClick={() => {
              hold.current = 0
              // En pausa o con menos movimiento no hay reproducción: se queda la conversación completa.
              setOc(moving ? 0 : OC.length)
            }}
          >
            Volver a ver
          </button>
        </div>
        <div className="oc-msgs" aria-live="polite">
          {shown.map((m) => (
            <div key={m.text} className={"msg " + m.side}>
              <span className="meta">
                <span className="badge">{m.ch}</span>
                {m.who}
              </span>
              <span>{m.text}</span>
            </div>
          ))}
          {oc >= 7 && <div className="sys">Una persona · 3 canales · 1 historia</div>}
        </div>
      </div>
      <p className="oc-note">
        Carmen, su mamá, agenda y paga. Las dos escriben por canales distintos y todo queda en la
        misma ficha, sin duplicados.
      </p>
    </div>
  )
}
