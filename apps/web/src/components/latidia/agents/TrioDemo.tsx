// La portada de /agentes en latidIA: los tres agentes en la misma consulta de Rosa. Sofi la agenda
// de noche, Clío ordena lo que dicta la Dra. Vela y Argos le avisa su control una semana después.
// Cada tramo se abre mientras pasa y queda resumido en una línea al terminar; se repite en bucle
// con «Pausar» y «Repetir». Sin movimiento se ve el final.
import { useState } from "react"
import { useLoop } from "../home/loop"
import "./trio-demo.css"

type Line = { kind: "in" | "out" | "said" | "sugg" | "chip"; text: string; label?: string }
type Stage = { key: "sofi" | "clio" | "argos"; name: string; role: string; when: string; done: string; from: number; lines: Line[] }

const STAGES: Stage[] = [
  {
    key: "sofi",
    name: "Sofi",
    role: "agenda",
    when: "WhatsApp · miércoles 23:40",
    done: "Agendó a Rosa · jueves 09:00 · Sala 1",
    from: 0,
    lines: [
      { kind: "in", text: "Buenas noches, tengo fiebre y me duele mucho la garganta. ¿Me pueden ver mañana?" },
      { kind: "out", text: "Hola, Rosa. Mañana jueves tengo 09:00 o 11:30 con la Dra. Vela. ¿Cuál te acomoda?" },
      { kind: "in", text: "A las 9, por favor." },
      { kind: "chip", text: "Reservada · jueves 09:00 · Sala 1" },
    ],
  },
  {
    key: "clio",
    name: "Clío",
    role: "ordena la consulta",
    when: "Consulta · jueves 09:06",
    done: "La Dra. Vela confirmó · control en 7 días",
    from: 4,
    lines: [
      { kind: "said", text: "«Amigdalitis aguda, presuntivo. Control en una semana.»" },
      { kind: "sugg", label: "Diagnóstico", text: "J03.9 · Amigdalitis aguda · Presuntivo" },
      { kind: "sugg", label: "Plan y controles", text: "Control en 7 días · con la Dra. Vela" },
      { kind: "chip", text: "Confirmado por la Dra. Vela · ya está en la historia" },
    ],
  },
  {
    key: "argos",
    name: "Argos",
    role: "avisa el control",
    when: "WhatsApp · una semana después",
    done: "Rosa reservó su control · jueves 09:00",
    from: 8,
    lines: [
      { kind: "out", text: "Hola, Rosa. ¿Cómo sigues? Te toca tu control con la Dra. Vela. ¿Te reservo el jueves a las 09:00?" },
      { kind: "in", text: "Sí, gracias. Ya estoy mejor." },
      { kind: "chip", text: "Control reservado · jueves 09:00 · Sala 1" },
    ],
  },
]
const LEN = 11

export default function TrioDemo() {
  const [paused, setPaused] = useState(false)
  const { step, restart } = useLoop({ len: LEN, hold: 4, ms: 1600, paused })
  const current = step >= 8 ? 2 : step >= 4 ? 1 : 0
  const finished = step >= LEN - 1

  return (
    <figure className="tr" aria-label="Demostración: los tres agentes en la consulta de Rosa">
      <div className="tr-top">
        <span className="tr-who">Rosa Paredes · Consultorio San Martín</span>
        <ol className="tr-steps" aria-hidden="true">
          {STAGES.map((s, i) => (
            <li key={s.key} className={`${s.key}${i === current ? " on" : i < current || finished ? " past" : ""}`}>
              {s.name}
            </li>
          ))}
        </ol>
      </div>

      <div className="tr-stages">
        {STAGES.map((s, i) => {
          const open = i === current
          const shown = (n: number) => step >= s.from + n
          return (
            <div key={s.key} className={`tr-stage ${s.key}${open ? " open" : i < current ? " past" : " next"}`}>
              <div className="tr-head">
                <span className="tr-badge" aria-hidden="true">
                  {i < current ? "✓" : s.name[0]}
                </span>
                <span className="tr-title">
                  <b>
                    {s.name} <span>{s.role}</span>
                  </b>
                  <span>{i < current ? s.done : open ? s.when : "Esperando"}</span>
                </span>
              </div>
              {open && (
                <div className="tr-body">
                  {s.lines.map((line, n) => (
                    <div key={line.text} className={`tr-line ${line.kind}${shown(n) ? " on" : ""}`}>
                      {line.kind === "said" && <span aria-hidden="true">🎙 </span>}
                      {line.kind === "chip" && <span aria-hidden="true">✓ </span>}
                      {line.label ? (
                        <>
                          <span className="tr-sugg">
                            <b>{line.label}</b>
                            <span>{line.text}</span>
                          </span>
                          <span className={`tr-btn${step >= s.from + 3 ? " ok" : ""}`}>{step >= s.from + 3 ? "✓ Confirmado" : "Confirmar"}</span>
                        </>
                      ) : (
                        line.text
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="tr-foot">
        <span className="tr-note">Demostración con datos de prueba.</span>
        <span className="tr-btns">
          <button type="button" className="tr-b" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? "Seguir" : "Pausar"}
          </button>
          <button
            type="button"
            className="tr-b tr-replay"
            onClick={() => {
              setPaused(false)
              restart()
            }}
          >
            ↻ Repetir
          </button>
        </span>
      </div>
    </figure>
  )
}
