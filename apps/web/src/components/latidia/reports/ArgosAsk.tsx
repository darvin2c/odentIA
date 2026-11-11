// Argos responde en la portada de /reportes (latidIA y, con `variant="dental"`, odentIA): la pregunta se escribe letra a letra, Argos dice
// sus pasos («Leyendo la pregunta», «Consultando…»), responde con las cifras destacadas, el dibujo crece y
// debajo dice «Así lo calculé», con sus botones. Tres preguntas que pasan solas hasta que la persona
// elige una; «Preguntar otra vez» va arriba, en la propia ventana de Reportes. Con movimiento reducido se ve la
// respuesta sin animar. Las cifras son de ejemplo (las mismas de las pestañas de Reportes): en latidIA,
// las del Consultorio San Martín; en odentIA, las de Clínica Sonrisa Norte. En soles: no son precios.
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import "./argos-ask.css"
import { useSteadyHeight } from "../../../lib/steady"

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

type Variant = "medical" | "dental"

const MEDICAL_QUESTIONS: Question[] = [
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

// Las de odentIA: las cifras de Clínica Sonrisa Norte, las mismas que publican la portada de Argos y las
// pestañas de Reportes (lo que te deben, lo más cobrado por servicio y las inasistencias por profesional).
const DENTAL_QUESTIONS: Question[] = [
  {
    label: "Qué se vendió más",
    q: "¿Qué se vendió más este mes?",
    answer: "**Limpieza dental**: 40 atenciones, **S/ 3.200**. Le siguen la resina simple y la endodoncia.",
    steps: ["Consultando lo cobrado de octubre por servicio"],
    how: "lo cobrado por servicio en octubre, sin impuestos, de todas las sedes. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["Limpieza dental", 3200, "S/ 3.200"],
      ["Resina simple", 2450, "S/ 2.450"],
      ["Endodoncia", 1800, "S/ 1.800"],
    ],
    action: "Fijar en Resumen",
  },
  {
    label: "Cuánto me deben",
    q: "¿Cuánto me deben y desde cuándo?",
    answer: "Te deben **S/ 4.820** de 23 personas. **S/ 1.150** llevan más de 60 días.",
    steps: ["Consultando los cargos sin pagar, por su fecha"],
    how: "cargos sin pagar a hoy, por la fecha del cargo. Todas las sedes. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["0 a 30 días", 2600, "S/ 2.600"],
      ["31 a 60 días", 1070, "S/ 1.070"],
      ["Más de 60 días", 1150, "S/ 1.150"],
    ],
    action: "Ver quiénes",
  },
  {
    label: "Quién falta más",
    q: "¿Qué profesional tiene más inasistencias?",
    answer: "El **Dr. Ríos**: 18 % este mes (9 de 50 citas). En toda la clínica fue **11 %**.",
    steps: ["Consultando las citas de octubre por profesional"],
    how: "citas a las que el paciente no vino ÷ citas que ya pasaron, octubre hasta hoy, de todas las sedes. Cifra oficial · la misma cuenta de Reportes.",
    bars: [
      ["Dr. Ríos", 18, "18 %"],
      ["Dra. Paredes", 9, "9 %"],
      ["Dra. Vega", 6, "6 %"],
    ],
    action: "Ver quiénes",
  },
]

const QUESTION_SETS: Record<Variant, Question[]> = { medical: MEDICAL_QUESTIONS, dental: DENTAL_QUESTIONS }

const TYPE_MS = 45
const THINK_MS = 1400
const NEXT_MS = 6500

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

export default function ArgosAsk({ variant = "medical" }: { variant?: Variant }) {
  const steady = useSteadyHeight<HTMLDivElement>()
  const QUESTIONS = QUESTION_SETS[variant]
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
    [stop, QUESTIONS],
  )

  useEffect(() => {
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) play(0, true)
    return stop
  }, [play, stop])

  const cur = QUESTIONS[pick]
  const done = phase === 2

  /**
   * La respuesta a una pregunta. Las de las otras preguntas van en la misma celda sin verse (`ghost`):
   * la tarjeta mide siempre lo que la respuesta más larga y pasar de una a otra no corre la página.
   */
  const answer = (question: Question, visible: boolean, ghost: boolean) => {
    const top = Math.max(...question.bars.map(([, v]) => v))
    return (
      <div
        key={question.label}
        className={ghost ? "lt-ask-answer fit-ghost" : "lt-ask-answer"}
        data-done={visible || undefined}
        aria-hidden={!ghost && visible ? undefined : true}
      >
        <p className="lt-ask-text">
          <Rich text={question.answer} />
        </p>
        <div className="lt-ask-bars">
          {question.bars.map(([name, v, value]) => (
            <div key={name} className="lt-ask-bar">
              <span className="lt-ask-bar-l">{name}</span>
              <span className="lt-ask-track">
                <span className="lt-ask-fill" style={{ width: visible ? `${Math.max(3, Math.round((v / top) * 100))}%` : "0%" }} />
              </span>
              <b>{value}</b>
            </div>
          ))}
        </div>
        <p className="lt-ask-how">
          <b>Así lo calculé:</b> {question.how}
        </p>
        <div className="lt-ask-acts" aria-hidden="true">
          <span className="lt-ask-act" data-primary>
            {question.action}
          </span>
          <span className="lt-ask-act">Descargar</span>
        </div>
      </div>
    )
  }

  return (
    <div className="lt-ask" ref={steady}>
      <div className="lt-ask-head">
        <b>Reportes</b>
        <span className="lt-ask-side">
          <span className="lt-ask-scope">Octubre · Todas las sedes</span>
          <button type="button" className="lt-ask-replay" onClick={() => play(pick, false)}>
            <span aria-hidden="true">↻</span> Preguntar otra vez
          </button>
        </span>
      </div>
      <div className="lt-ask-field">
        {/* La pregunta más larga reserva sus líneas: escribirla letra a letra no corre lo de abajo. */}
        <span className="fit lt-ask-q-fit">
          {QUESTIONS.map((question) => (
            <span key={question.label} className="lt-ask-q fit-ghost" aria-hidden="true">
              {question.q}|
            </span>
          ))}
          <span className="lt-ask-q">
            {cur.q.slice(0, chars)}
            <span className="lt-ask-caret" aria-hidden="true" data-on={phase === 0 || undefined}>
              |
            </span>
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
      {/* Las respuestas de las otras preguntas van en la misma celda sin verse, y mientras piensa sus
          pasos van encima: la tarjeta no cambia de alto. El anuncio va en la celda, que no cambia. */}
      <div className="lt-ask-stage fit" aria-live="polite">
        {QUESTIONS.map((question, i) => (i === pick ? null : answer(question, true, true)))}
        {answer(cur, done, false)}
        {phase === 1 && (
          <div className="lt-ask-think">
            <span>· Leyendo la pregunta</span>
            {cur.steps.map((s) => (
              <span key={s}>· {s}</span>
            ))}
          </div>
        )}
      </div>
      <span className="lt-ask-note">Demostración con datos de ejemplo. Toca una pregunta.</span>
    </div>
  )
}
