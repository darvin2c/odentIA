// Las preguntas a Argos en la portada de /agentes/administrador de latidIA (tablero «Argos»): la pregunta
// se escribe sola, Argos piensa en dos pasos («Leyendo la pregunta», «Consultando las cifras de
// Reportes») y responde con las cifras, un dibujo (columnas o barras) y «Así lo calculé». Solo pasa a
// la siguiente pregunta; tocar una la detiene ahí. Las cifras son del Consultorio San Martín de la demo.
// Con movimiento reducido, la respuesta aparece entera y no pasa sola.
import { useEffect, useRef, useState } from "react"
import "./argos-questions.css"

type Question = {
  label: string
  q: string
  kind: "columns" | "bars"
  figures: [string, string][]
  answer: string
  how: string
  action: string
  bars: [string, number, string?][]
  max: number
}

/** Datos de ejemplo: octubre en el Consultorio San Martín (tarifario de la demo en soles). */
const QUESTIONS: Question[] = [
  {
    label: "¿Quién no vino este mes?",
    q: "¿Quién no vino este mes?",
    kind: "columns",
    figures: [
      ["6", "personas no vinieron"],
      ["7 %", "de 84 citas"],
    ],
    answer: "En octubre faltaron 6 personas. A 4 ya les ofreció otro horario y 2 reservaron de nuevo.",
    how: "citas a las que la persona no vino ÷ citas que ya pasaron. Octubre hasta hoy, Sede San Martín.",
    action: "Ver quiénes",
    bars: [
      ["Sem. 1", 2],
      ["Sem. 2", 1],
      ["Sem. 3", 3],
      ["Sem. 4", 0],
    ],
    max: 3,
  },
  {
    label: "¿Cuánto cobramos en consultas?",
    q: "¿Cuánto cobramos en consultas en octubre?",
    kind: "bars",
    figures: [
      ["S/ 6.160", "cobrado"],
      ["81", "consultas cobradas"],
    ],
    answer: "La que más deja es la consulta de medicina general: S/ 3.840 en 48 consultas.",
    how: "lo cobrado por cada servicio en octubre hasta hoy, sin impuestos. Cuenta la consulta cobrada, no lo indicado.",
    action: "Descargar",
    bars: [
      ["Medicina general", 3840, "S/ 3.840"],
      ["Control", 1100, "S/ 1.100"],
      ["Ginecología y obstetricia", 720, "S/ 720"],
      ["Pediatría", 500, "S/ 500"],
    ],
    max: 3840,
  },
  {
    label: "¿A quién le toca su control?",
    q: "¿A quién le toca su control en noviembre?",
    kind: "bars",
    figures: [
      ["14", "controles en noviembre"],
      ["5", "aún sin cita"],
    ],
    answer: "9 ya tienen cita. A los otros 5 los invito a tiempo, por su canal.",
    how: "controles por reservar o reservados con fecha en noviembre. Todas las sedes.",
    action: "Ver quiénes",
    bars: [
      ["Presión arterial", 8, "8 · 5 con cita"],
      ["Control niño sano", 4, "4 · 3 con cita"],
      ["Glucosa", 2, "2 · 1 con cita"],
    ],
    max: 8,
  },
]

const TYPE_MS = 40
const NEXT_MS = 6500

export default function ArgosQuestions() {
  // En el servidor, la primera respuesta completa: sin JavaScript se lee entera.
  const [pick, setPick] = useState(0)
  const [chars, setChars] = useState(QUESTIONS[0].q.length)
  // 0 escribe, 1 y 2 piensa, 3 responde.
  const [phase, setPhase] = useState(3)
  const [auto, setAuto] = useState(true)
  const timers = useRef<number[]>([])
  const reduce = useRef(false)
  // Con movimiento reducido no pasa sola: la nota no promete que avanza.
  const [still, setStill] = useState(false)

  const stop = () => {
    for (const id of timers.current) {
      window.clearTimeout(id)
      window.clearInterval(id)
    }
    timers.current = []
  }

  const play = (i: number, keepGoing: boolean) => {
    stop()
    setPick(i)
    setAuto(keepGoing)
    const length = QUESTIONS[i].q.length
    if (reduce.current) {
      setChars(length)
      setPhase(3)
      return
    }
    setChars(0)
    setPhase(0)
    let typed = 0
    const typing = window.setInterval(() => {
      typed += 1
      setChars(typed)
      if (typed < length) return
      window.clearInterval(typing)
      setPhase(1)
      timers.current.push(window.setTimeout(() => setPhase(2), 700))
      timers.current.push(
        window.setTimeout(() => {
          setPhase(3)
          if (keepGoing) timers.current.push(window.setTimeout(() => play((i + 1) % QUESTIONS.length, true), NEXT_MS))
        }, 1500),
      )
    }, TYPE_MS)
    timers.current.push(typing)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: arranca una sola vez al montar
  useEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    if (reduce.current) setStill(true)
    else play(0, true)
    return stop
  }, [])

  const cur = QUESTIONS[pick]
  const shown = phase === 3
  const thinking = phase === 1 || phase === 2
  const pct = (v: number) => (shown ? Math.max(Math.round((v / cur.max) * 100), v > 0 ? 4 : 0) : 0)

  return (
    <div className="laq">
      <div className="laq-top">
        <span className="laq-avatar" aria-hidden="true">
          A
        </span>
        <span className="laq-who">
          <b>Argos · Reportes</b>
          <span>Consultorio San Martín · octubre, hasta hoy</span>
        </span>
      </div>
      <div className="laq-ask" aria-hidden="true">
        <span className="laq-typed">
          {cur.q.slice(0, chars)}
          <span className={phase === 0 ? "laq-caret" : "laq-caret off"}>|</span>
        </span>
        <span className="laq-send">Preguntar</span>
      </div>
      <fieldset className="laq-chips" aria-label="Preguntas de ejemplo">
        {QUESTIONS.map((question, i) => (
          <button key={question.label} type="button" className="laq-chip" aria-pressed={i === pick} onClick={() => play(i, false)}>
            {question.label}
          </button>
        ))}
      </fieldset>
      {thinking && (
        <div className="laq-think" role="status">
          <span>· Leyendo la pregunta</span>
          <span className={phase >= 2 ? "" : "dim"}>· Consultando las cifras de Reportes</span>
        </div>
      )}
      <div className={shown ? "laq-answer on" : "laq-answer"} aria-live="polite" aria-hidden={shown ? undefined : true}>
        <div className="laq-figures">
          {cur.figures.map(([n, label]) => (
            <span key={label}>
              <b>{n}</b>
              <span>{label}</span>
            </span>
          ))}
        </div>
        <p className="laq-text">{cur.answer}</p>
        {cur.kind === "columns" ? (
          <div className="laq-cols" role="img" aria-label={cur.bars.map(([name, v]) => `${name}: ${v}`).join(", ")}>
            {cur.bars.map(([name, v]) => (
              <span key={name} className="laq-col">
                <b>{v}</b>
                <span className="laq-col-bar" style={{ height: `${pct(v)}px` }} />
                <span className="laq-col-name">{name}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="laq-bars">
            {cur.bars.map(([name, v, value]) => (
              <div key={name} className="laq-bar">
                <span className="laq-bar-row">
                  <span>{name}</span>
                  <b>{value ?? v}</b>
                </span>
                <span className="laq-track">
                  <span className="laq-fill" style={{ width: `${pct(v)}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="laq-how">
          <b>Así lo calculé:</b> {cur.how}
        </p>
        <div className="laq-actions" aria-hidden="true">
          <span className="laq-pill">{cur.action}</span>
          <span className="laq-pill">Fijar en Inicio</span>
          <span className="laq-same">La misma cifra de Reportes</span>
        </div>
      </div>
      <span className="laq-note">
        {still
          ? "Demostración con datos de ejemplo. Toca otra pregunta."
          : auto
            ? "Demostración con datos de ejemplo. Toca una pregunta para quedarte en ella."
            : "Demostración con datos de ejemplo. Te quedaste en esta pregunta."}
      </span>
    </div>
  )
}
