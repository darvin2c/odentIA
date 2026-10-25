// «Un día en el Consultorio San Martín» (lienzo «Inicio», sección 4): siete pasos, del mensaje de
// Rosa a medianoche al control de Luis cada 3 meses. Avanza solo; elegir un paso lo detiene ahí.
// En el escritorio, la lista a la izquierda y el paso a la derecha; en el teléfono, los números
// arriba y «Anterior», pausa y «Siguiente» abajo. Sin movimiento se queda en el paso 3.
import { useEffect, useState } from "react"
import { prefersReducedMotion } from "./loop"
import "./day-case.css"

type Agent = "Sofi" | "Clío" | "Argos" | "Equipo"
type Item = { kind: "in" | "out" | "card"; label: string; text: string; chip?: string }
type Step = { when: string; ch: string; agent: Agent; title: string; text: string; items: Item[] }

const AGENT_CLASS: Record<Agent, string> = { Sofi: "sofi", Clío: "clio", Argos: "argos", Equipo: "team" }

const STEPS: Step[] = [
  {
    when: "Miércoles 23:40",
    ch: "WhatsApp",
    agent: "Sofi",
    title: "Rosa escribe de noche",
    text: "Tiene fiebre. El consultorio está cerrado; Sofi no.",
    items: [
      { kind: "in", label: "Rosa · 23:40", text: "Buenas noches, tengo fiebre y me duele mucho la garganta. ¿Me pueden ver mañana?" },
      {
        kind: "out",
        label: "Sofi · 23:40",
        text: "Hola, Rosa. Soy Sofi, del Consultorio San Martín. Mañana jueves tengo 09:00 o 11:30 con la Dra. Vela. ¿Cuál te acomoda?",
      },
    ],
  },
  {
    when: "Miércoles 23:41",
    ch: "Agenda",
    agent: "Sofi",
    title: "Sofi agenda a las 09:00",
    text: "Con el sí de Rosa, en un horario libre de la Dra. Vela.",
    items: [
      { kind: "in", label: "Rosa · 23:41", text: "A las 9, por favor." },
      { kind: "out", label: "Sofi · 23:41", text: "Listo: mañana a las 09:00 con la Dra. Vela, Av. Perú 1820. Te escribo antes para recordártelo." },
      { kind: "card", label: "Agenda · jueves", text: "09:00 · Sala 1 · Rosa Paredes Luna · Consulta medicina general", chip: "Reservada 23:41" },
    ],
  },
  {
    when: "Jueves 09:06",
    ch: "Consulta",
    agent: "Clío",
    title: "La Dra. Vela dicta",
    text: "Clío propone por bloque; ella confirma.",
    items: [
      { kind: "card", label: "Clío · dictado terminado", text: "6 sugerencias: motivo, signos vitales, boca y garganta, diagnóstico y descanso.", chip: "5 confirmadas" },
      { kind: "card", label: "Examen físico", text: "PA 118/76 mmHg · FC 96 lpm · T 38,4 °C (corregida por voz)", chip: "Confirmado" },
      { kind: "card", label: "Diagnóstico", text: "J03.9 · Amigdalitis aguda · Presuntivo", chip: "Confirmado" },
    ],
  },
  {
    when: "Jueves 09:18",
    ch: "Documentos",
    agent: "Clío",
    title: "Descanso emitido y enviado",
    text: "Firmado con su colegiatura y enviado por WhatsApp.",
    items: [
      {
        kind: "card",
        label: "Descanso médico N.º 1",
        text: "3 días de descanso. Sin diagnóstico: Rosa no autorizó que figure. Elena Vela · CMP 045678",
        chip: "Emitido",
      },
      { kind: "out", label: "WhatsApp · 09:19", text: "Rosa, aquí está tu descanso médico. También lo descargas desde tu enlace durante 30 días." },
    ],
  },
  {
    when: "Jueves 09:22",
    ch: "Caja",
    agent: "Equipo",
    title: "Caja cobra la consulta",
    text: "Y cuenta en Reportes como consulta cobrada.",
    items: [
      { kind: "card", label: "Caja", text: "Consulta medicina general · Rosa Paredes Luna · S/ 80", chip: "Cobrada" },
      { kind: "card", label: "Reportes · hoy", text: "Consultas cobradas: 1 · S/ 80" },
    ],
  },
  {
    when: "Una semana después",
    ch: "WhatsApp",
    agent: "Argos",
    title: "Argos la invita a su control",
    text: "El control que dictó la doctora, a tiempo.",
    items: [
      { kind: "out", label: "Argos · 10:00", text: "Hola, Rosa. ¿Cómo sigues? Te toca tu control con la Dra. Vela. ¿Te reservo el jueves a las 09:00?" },
      { kind: "in", label: "Rosa · 10:12", text: "Sí, gracias. Ya estoy mejor." },
      { kind: "card", label: "Agenda", text: "Control · jueves 09:00 · Sala 1", chip: "Reservado" },
    ],
  },
  {
    when: "Cada 3 meses",
    ch: "WhatsApp",
    agent: "Argos",
    title: "Y Luis vuelve a su control",
    text: "Su control de presión se repite hasta «Dejar de repetir».",
    items: [
      {
        kind: "out",
        label: "Argos · a Luis Gómez",
        text: "Hola, Luis. Le toca su control de presión. ¿Le reservo el martes a las 10:00? Traiga el registro de presión de su casa.",
      },
      { kind: "in", label: "Luis · 11:05", text: "Sí, el martes." },
      { kind: "card", label: "Signos vitales · Luis", text: "PA de 152/96 a 132/84 en cuatro controles", chip: "Siguiente en 3 meses" },
    ],
  },
]
const N = STEPS.length
const STEP_MS = 3400

export default function DayCase() {
  const [cur, setCur] = useState(2)
  const [auto, setAuto] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) return
    setCur(0)
    setAuto(true)
  }, [])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => setCur((c) => (c + 1) % N), STEP_MS)
    return () => clearInterval(id)
  }, [auto])

  const pick = (i: number) => {
    setCur((i + N) % N)
    setAuto(false)
  }
  const step = STEPS[cur]
  const tone = AGENT_CLASS[step.agent]
  const autoLabel = auto ? "Pausar el recorrido" : "Reproducir el recorrido"

  return (
    <div className="dc">
      <div className="dc-bar">
        <button type="button" className="dc-auto" onClick={() => setAuto(!auto)}>
          {autoLabel}
        </button>
      </div>
      <div className="dc-grid">
        <ol className="dc-list">
          {STEPS.map((s, i) => {
            const on = i === cur
            const past = i < cur
            return (
              <li key={s.title}>
                <button type="button" className={`dc-step${on ? " on" : past ? " past" : ""}`} aria-current={on ? "step" : undefined} onClick={() => pick(i)}>
                  <span className="dc-num">{past ? "✓" : i + 1}</span>
                  <span className="dc-step-copy">
                    <span className="dc-when">{s.when}</span>
                    <b>{s.title}</b>
                  </span>
                  <span className={`dc-agent ${AGENT_CLASS[s.agent]}`}>{s.agent}</span>
                </button>
              </li>
            )
          })}
        </ol>

        <fieldset className="dc-nums">
          <legend className="sr-only">Pasos del caso</legend>
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className={`dc-dotbtn${i === cur ? " on" : i < cur ? " past" : ""}`}
              aria-label={`Paso ${i + 1}: ${s.title}`}
              aria-current={i === cur ? "step" : undefined}
              onClick={() => pick(i)}
            >
              {i < cur ? "✓" : i + 1}
            </button>
          ))}
        </fieldset>

        <div className={`dc-panel ${tone}`}>
          <div className="dc-panel-head">
            <span className="dc-panel-title">
              <b>{step.title}</b>
              <span>{step.text}</span>
            </span>
            <span className="dc-pos">
              Paso {cur + 1} de {N}
            </span>
          </div>
          <div className="dc-chline">
            <span className="dc-ch">{step.ch}</span>
            <span className="dc-when">{step.when}</span>
          </div>
          {step.items.map((item) => (
            <div key={item.label + item.text} className={`dc-item ${item.kind}`}>
              <span className="dc-label">{item.label}</span>
              <span className="dc-text">{item.text}</span>
              {item.chip && <span className="dc-chip">{item.chip}</span>}
            </div>
          ))}
          <div className="dc-dots" aria-hidden="true">
            {STEPS.map((s, i) => (
              <i key={s.title} className={i <= cur ? "on" : undefined}></i>
            ))}
          </div>
          <div className="dc-nav">
            <button type="button" className="dc-prev" onClick={() => pick(cur - 1)}>
              ← Anterior
            </button>
            <button type="button" className="dc-play" aria-label={autoLabel} onClick={() => setAuto(!auto)}>
              {auto ? "❚❚" : "▶"}
            </button>
            <button type="button" className="dc-next" onClick={() => pick(cur + 1)}>
              Siguiente →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
