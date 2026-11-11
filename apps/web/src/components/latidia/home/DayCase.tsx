// «Un día en el Consultorio San Martín» (lienzo «Inicio», sección 4): siete pasos, del mensaje de
// Rosa a medianoche al control de Luis cada 3 meses. Avanza solo, da dos vueltas y se queda en el
// último paso (WCAG 2.2.2); elegir un paso lo detiene ahí. El control dice lo que hace: «Pausar»,
// «Seguir» o «Volver a ver». En el escritorio, la lista a la izquierda y el paso a la derecha; en el
// teléfono, los números arriba y «Anterior», el control y «Siguiente» abajo. Sin movimiento se queda
// en el paso 3.
// Los siete pasos ocupan la misma celda y solo se ve el actual: la tarjeta mide lo que el paso más
// largo y «Anterior», el control y «Siguiente» no se mueven mientras el caso avanza solo.
// Quién hace cada cosa es lo del producto: el descanso lo emite y lo firma la médica (Clío solo lo
// propone) y los mensajes que decide Argos los escribe Sofi.
import { useEffect, useRef, useState } from "react"
import { prefersReducedMotion } from "./loop"
import "./day-case.css"

type Agent = "Sofi" | "Clío" | "Argos" | "Equipo" | "Dra. Vela"
type Item = { kind: "in" | "out" | "card"; label: string; text: string; chip?: string }
type Step = { when: string; ch: string; agent: Agent; title: string; text: string; items: Item[] }

const AGENT_CLASS: Record<Agent, string> = { Sofi: "sofi", Clío: "clio", Argos: "argos", Equipo: "team", "Dra. Vela": "team" }

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
    agent: "Dra. Vela",
    title: "La Dra. Vela emite el descanso",
    text: "Clío lo propuso; ella lo firma con su colegiatura y le llega por WhatsApp.",
    items: [
      {
        kind: "card",
        label: "Descanso médico N.º 1",
        text: "3 días de descanso. Sin diagnóstico: Rosa no autorizó que figure. Elena Vela · CMP 045678",
        chip: "Emitido",
      },
      { kind: "out", label: "WhatsApp · 09:19", text: "Rosa, te enviamos tu descanso médico. Lo tienes adjunto en este mensaje, en PDF." },
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
    text: "Argos ve que le toca el control que dictó la doctora; Sofi le escribe.",
    items: [
      { kind: "out", label: "Sofi · 10:00", text: "Hola, Rosa. ¿Cómo sigues? Te toca tu control con la Dra. Vela. ¿Te reservo el jueves a las 09:00?" },
      { kind: "in", label: "Rosa · 10:12", text: "Sí, gracias. Ya estoy mejor." },
      { kind: "card", label: "Agenda", text: "Control · jueves 09:00 · Sala 1", chip: "Reservado" },
    ],
  },
  {
    when: "Cada 3 meses",
    ch: "WhatsApp",
    agent: "Argos",
    title: "Y Luis vuelve a su control",
    text: "Luis, otro paciente del consultorio, se controla la presión cada 3 meses, hasta «Dejar de repetir».",
    items: [
      {
        kind: "out",
        label: "Sofi · a Luis Gómez",
        text: "Hola, Luis. Le toca su control de presión. ¿Le reservo el martes a las 10:00? Traiga el registro de presión de su casa.",
      },
      { kind: "in", label: "Luis · 11:05", text: "Sí, el martes." },
      { kind: "card", label: "Signos vitales · Luis", text: "PA de 152/96 a 132/84 en cuatro controles", chip: "Siguiente en 3 meses" },
    ],
  },
]
const N = STEPS.length
const STEP_MS = 3400
/** Vueltas que da solo antes de quedarse en el último paso. */
const ROUNDS = 2
/** Lo que puede decir el control. */
const AUTO_LABELS = ["Pausar", "Seguir", "Volver a ver"]

export default function DayCase() {
  const [cur, setCur] = useState(2)
  const [auto, setAuto] = useState(false)
  // Terminó sus vueltas solo: el control ofrece «Volver a ver».
  const [ended, setEnded] = useState(false)
  const at = useRef(cur)
  at.current = cur
  const laps = useRef(0)

  useEffect(() => {
    if (prefersReducedMotion()) return
    setCur(0)
    setAuto(true)
  }, [])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => {
      const next = at.current + 1
      if (next < N) {
        setCur(next)
        return
      }
      laps.current += 1
      if (laps.current >= ROUNDS) {
        setAuto(false)
        setEnded(true)
      } else setCur(0)
    }, STEP_MS)
    return () => clearInterval(id)
  }, [auto])

  const pick = (i: number) => {
    setCur((i + N) % N)
    setAuto(false)
    setEnded(false)
  }
  // Pausar, seguir desde donde quedó o, terminado, una vuelta más.
  const toggle = () => {
    if (auto) setAuto(false)
    else if (ended || cur === N - 1) {
      laps.current = ROUNDS - 1
      setEnded(false)
      setCur(0)
      setAuto(true)
    } else setAuto(true)
  }
  const autoLabel = auto ? "Pausar" : ended || cur === N - 1 ? "Volver a ver" : "Seguir"
  const autoGlyph = auto ? "❚❚" : ended || cur === N - 1 ? "↻" : "▶"

  return (
    <div className="dc">
      <div className="dc-bar">
        <button type="button" className="dc-auto" onClick={toggle}>
          {/* El texto más largo reserva su ancho: el botón no cambia de tamaño al cambiar. */}
          <span className="fit fit-inline">
            {AUTO_LABELS.map((text) => (
              <span key={text} className="fit-ghost" aria-hidden="true">
                {text}
              </span>
            ))}
            <span>{autoLabel}</span>
          </span>
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

        <div className="dc-panel">
          <div className="fit">
            {STEPS.map((step, i) => (
              <div
                key={step.title}
                className={`dc-view ${AGENT_CLASS[step.agent]}${i === cur ? "" : " fit-ghost"}`}
                aria-hidden={i === cur ? undefined : true}
              >
                <div className="dc-panel-head">
                  <span className="dc-panel-title">
                    <b>{step.title}</b>
                    <span>{step.text}</span>
                  </span>
                  <span className="dc-pos">
                    Paso {i + 1} de {N}
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
              </div>
            ))}
          </div>
          <div className="dc-dots" aria-hidden="true">
            {STEPS.map((s, i) => (
              <i key={s.title} className={i <= cur ? "on" : undefined}></i>
            ))}
          </div>
          <div className="dc-nav">
            <button type="button" className="dc-prev" onClick={() => pick(cur - 1)}>
              ← Anterior
            </button>
            <button type="button" className="dc-play" aria-label={autoLabel} onClick={toggle}>
              {autoGlyph}
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
