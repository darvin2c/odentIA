// Argos responde en la portada de /reportes de latidIA: la pregunta se escribe letra a letra, Argos dice
// sus pasos («Leyendo la pregunta», «Consultando…»), responde con las cifras destacadas, el dibujo crece y
// debajo dice «Así lo calculé», con sus botones. Tres preguntas que pasan solas hasta que la persona
// elige una; «Preguntar otra vez» (en la portada) manda `replayEvent`. Con movimiento reducido se ve la
// respuesta sin animar. Las cifras son las del Consultorio San Martín de ejemplo (las mismas de las
// pestañas de Reportes), en soles: no son precios de latidIA.
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import "./argos-ask.css"

type Question = {
  /** El nombre corto del chip para elegirla. */
  label: string
  q: string
  /** La respuesta; lo que va entre **…** se destaca. */
  answer: string
  /** Lo que hace después de «Leyendo la pregunta». */
  steps: string[]
  how: string
  /** [nombre, valor, cifra escrita]. */
  bars: [string, number, string][]
  /** El botón principal de esa respuesta. */
  action: string
}

const QUESTIONS: Question[] = [
  {
    label: "Qué se cobró más",
    q: "¿Qué servicio se cobró más este mes?",
    answer: "La **consulta de medicina general**: 142 veces, **S/ 11.360**. Le siguen el control y el electrocardiograma.",
    steps: ["Consultando los cobros de octubre por servicio"],
    how: "cobros de octubre hasta hoy, por servicio, de todas las sedes. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["Consulta", 11360, "S/ 11.360"],
      ["Control", 3200, "S/ 3.200"],
      ["Electrocardiograma", 1380, "S/ 1.380"],
    ],
    action: "Fijar en Resumen",
  },
  {
    label: "Cuánto me deben",
    q: "¿Cuánto me deben y desde cuándo?",
    answer: "Te deben **S/ 1.230** de 14 personas. **S/ 240** llevan más de 60 días.",
    steps: ["Consultando los cargos sin pagar, por su fecha"],
    how: "cargos sin pagar a hoy, por la fecha del cargo. Todas las sedes. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["0 a 30 días", 760, "S/ 760"],
      ["31 a 60 días", 230, "S/ 230"],
      ["Más de 60 días", 240, "S/ 240"],
    ],
    action: "Ver quiénes",
  },
  {
    label: "Qué sala está más llena",
    q: "¿Qué sala tuvo más horas con cita?",
    answer: "**San Martín · Sala 1**: 78 % de sus horas con cita. La que tiene más espacio es Los Olivos · Sala 1, con **59 %**.",
    steps: ["Consultando la agenda de octubre por sala"],
    how: "horas con cita ÷ horas abiertas de cada sala, octubre hasta hoy. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["San Martín · Sala 1", 78, "78 %"],
      ["San Martín · Sala 2", 64, "64 %"],
      ["Los Olivos · Sala 1", 59, "59 %"],
    ],
    action: "Ver la agenda",
  },
]

const TYPE_MS = 45
const THINK_MS = 1400
const NEXT_MS = 6500

interface Props {
  /** Un evento de window que vuelve a hacer la pregunta (el botón «Preguntar otra vez» de la portada). */
  replayEvent?: string
}

/** «Te deben **S/ 1.230**…» con lo destacado en negrita. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("**").map((part, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: los trozos de una frase fija no cambian de orden.
        i % 2 === 1 ? <b key={i}>{part}</b> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  )
}

export default function ArgosAsk({ replayEvent }: Props) {
  // Se arma en el servidor con la primera respuesta completa: sin JavaScript se lee igual.
  const [pick, setPick] = useState(0)
  const [chars, setChars] = useState(Number.POSITIVE_INFINITY)
  const [phase, setPhase] = useState<0 | 1 | 2>(2)
  const timers = useRef<number[]>([])

  const stop = useCallback(() => {
    for (const t of timers.current) {
      window.clearInterval(t)
      window.clearTimeout(t)
    }
    timers.current = []
  }, [])

  const play = useCallback(
    (i: number, keepGoing: boolean) => {
      stop()
      setPick(i)
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setChars(Number.POSITIVE_INFINITY)
        setPhase(2)
        return
      }
      const length = QUESTIONS[i].q.length
      let typed = 0
      setChars(0)
      setPhase(0)
      const typing = window.setInterval(() => {
        typed += 1
        setChars(typed)
        if (typed < length) return
        window.clearInterval(typing)
        setPhase(1)
        timers.current.push(
          window.setTimeout(() => {
            setPhase(2)
            if (keepGoing) timers.current.push(window.setTimeout(() => play((i + 1) % QUESTIONS.length, true), NEXT_MS))
          }, THINK_MS),
        )
      }, TYPE_MS)
      timers.current.push(typing)
    },
    [stop],
  )

  useEffect(() => {
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) play(0, true)
    return stop
  }, [play, stop])

  useEffect(() => {
    if (!replayEvent) return
    const again = () => play(pick, false)
    window.addEventListener(replayEvent, again)
    return () => window.removeEventListener(replayEvent, again)
  }, [replayEvent, play, pick])

  const cur = QUESTIONS[pick]
  const max = Math.max(...cur.bars.map(([, v]) => v))
  const done = phase === 2

  return (
    <div className="lt-ask">
      <div className="lt-ask-head">
        <b>Reportes</b>
        <span className="lt-ask-scope">Octubre · Todas las sedes</span>
      </div>
      <div className="lt-ask-field">
        <span className="lt-ask-q">
          {cur.q.slice(0, chars)}
          <span className="lt-ask-caret" aria-hidden="true" data-on={phase === 0 || undefined}>
            |
          </span>
        </span>
        <span className="lt-ask-ask" aria-hidden="true">
          Preguntar
        </span>
      </div>
      <fieldset className="lt-ask-chips">
        <legend className="sr-only">Elige una pregunta</legend>
        {QUESTIONS.map((q, i) => (
          <button key={q.label} type="button" aria-pressed={i === pick} onClick={() => play(i, false)}>
            {q.label}
          </button>
        ))}
      </fieldset>
      <div className="lt-ask-stage">
        {phase === 1 && (
          <div className="lt-ask-think">
            <span>· Leyendo la pregunta</span>
            {cur.steps.map((s) => (
              <span key={s}>· {s}</span>
            ))}
          </div>
        )}
        <div className="lt-ask-answer" data-done={done || undefined} aria-hidden={done ? undefined : true} aria-live="polite">
          <p className="lt-ask-text">
            <Rich text={cur.answer} />
          </p>
          <div className="lt-ask-bars">
            {cur.bars.map(([name, v, value]) => (
              <div key={name} className="lt-ask-bar">
                <span className="lt-ask-bar-l">{name}</span>
                <span className="lt-ask-track">
                  <span className="lt-ask-fill" style={{ width: done ? `${Math.max(3, Math.round((v / max) * 100))}%` : "0%" }} />
                </span>
                <b>{value}</b>
              </div>
            ))}
          </div>
          <p className="lt-ask-how">
            <b>Así lo calculé:</b> {cur.how}
          </p>
          <div className="lt-ask-acts" aria-hidden="true">
            <span className="lt-ask-act" data-primary>
              {cur.action}
            </span>
            <span className="lt-ask-act">Descargar</span>
          </div>
        </div>
      </div>
      <span className="lt-ask-note">Demostración con datos de ejemplo. Toca una pregunta.</span>
    </div>
  )
}
