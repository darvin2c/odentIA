// Demostración de Argos (lienzo del paso 3, tableros Argos y Reportes): la pregunta se escribe letra a
// letra, Argos muestra sus pasos («Leyendo la pregunta», «Consultando…») y responde con la frase, el
// dibujo que crece (barras o columnas), «Así lo calculé» y sus botones. La usan /agentes/administrador
// (tres preguntas para elegir, que pasan solas) y /reportes (una pregunta, en columnas, y «Preguntar
// otra vez» en la esquina de la propia demo: al tocarlo se ve empezar). Con movimiento reducido se ve
// la respuesta sin animar.
//
// Las cifras (S/ 4.820, Dr. Ríos 18 %…) son de una clínica de ejemplo, no precios de odentIA.
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { AgentFoot, AgentHead } from "./frame/AgentFrame"
import "./argos-demo.css"

export type ArgosQuestion = {
  /** El nombre corto del chip para elegirla. */
  label: string
  q: string
  /** La respuesta; lo que va entre **…** se destaca. */
  answer: string
  how: string
  /** Lo que dice mientras consulta, después de «Leyendo la pregunta». */
  consulting: string
  /** [nombre, valor, cifra escrita]. */
  bars: [string, number, string][]
}

export type ArgosAction = { label: string; primary?: boolean }

interface Props {
  questions: ArgosQuestion[]
  /** «bars»: barras horizontales con nombre y cifra; «columns»: columnas con su rótulo debajo. */
  chart?: "bars" | "columns"
  /** Los chips para elegir la pregunta (si hay más de una). */
  chips?: boolean
  /** Pasar sola a la siguiente pregunta. */
  auto?: boolean
  /** Cabecera de Reportes: título y el periodo con la sede. */
  head?: { title: string; scope: string }
  /** Cabecera común de los agentes (la de Sofi y Clío): Argos, dónde está y en qué anda. */
  agent?: { name: string; meta: string }
  actions: ArgosAction[]
  /** De dónde sale la cifra, junto a los botones. */
  source?: string
  /** El campo con la raya ámbar (Reportes) o gris (Argos). */
  field?: "soft" | "amber"
  /** Muestra el cursor mientras escribe. */
  caret?: boolean
  note: string
  /** El botón que vuelve a empezar la pregunta, en la esquina de arriba de la demo («Preguntar otra vez»). */
  replay?: string
}

const TYPE_MS = 45
const THINK_MS = 1300
const NEXT_MS = 6000

/** «Te deben **S/ 4.820**…» con lo destacado en negrita. */
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

export default function ArgosDemo({
  questions,
  chart = "bars",
  chips = false,
  auto = false,
  head,
  agent,
  actions,
  source,
  field = "soft",
  caret = false,
  note,
  replay,
}: Props) {
  // Se arma en el servidor con la primera respuesta completa: sin JavaScript se lee igual.
  const [pick, setPick] = useState(0)
  const [chars, setChars] = useState(Number.POSITIVE_INFINITY)
  const [phase, setPhase] = useState<0 | 1 | 2>(2)
  const timers = useRef<number[]>([])
  const box = useRef<HTMLDivElement | null>(null)

  const stop = useCallback(() => {
    for (const t of timers.current) {
      window.clearInterval(t)
      window.clearTimeout(t)
    }
    timers.current = []
  }, [])

  const play = useCallback(
    (i: number, keepGoing: boolean, asked = false) => {
      stop()
      setPick(i)
      if (!asked && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setChars(Number.POSITIVE_INFINITY)
        setPhase(2)
        return
      }
      const length = questions[i].q.length
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
            if (keepGoing && questions.length > 1) timers.current.push(window.setTimeout(() => play((i + 1) % questions.length, true), NEXT_MS))
          }, THINK_MS),
        )
      }, TYPE_MS)
      timers.current.push(typing)
    },
    [questions, stop],
  )

  useEffect(() => {
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) play(0, auto)
    return stop
  }, [play, stop, auto])

  // Vuelve a empezar y, si la respuesta queda bajo el borde de la ventana, sube lo justo para verla entera.
  const again = () => {
    play(pick, false, true)
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    box.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" })
  }

  const cur = questions[pick]
  const max = Math.max(...cur.bars.map(([, v]) => v))
  const done = phase === 2
  const typed = cur.q.slice(0, chars)

  return (
    <div className="ad" ref={box}>
      {agent && (
        <AgentHead
          agent="argos"
          name={agent.name}
          meta={agent.meta}
          state={phase === 0 ? "Leyendo…" : phase === 1 ? "Calculando…" : "Respondió"}
          live={phase < 2}
          done={phase === 2}
        />
      )}
      {!agent && (head || replay) && (
        <div className="ad-head">
          {head && <b>{head.title}</b>}
          {head && <span className="ad-scope">{head.scope}</span>}
          {/* Lo pide quien mira: se repite aunque prefiera menos movimiento (como «Volver a dictar»). */}
          {replay && (
            <button type="button" className="ad-again" onClick={again}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
              </svg>
              {replay}
            </button>
          )}
        </div>
      )}
      <div className={`ad-field ad-${field}`}>
        <span className="ad-q">
          {typed}
          {caret && (
            <span className="ad-caret" aria-hidden="true" data-on={phase === 0 || undefined}>
              |
            </span>
          )}
        </span>
        <span className="ad-ask" aria-hidden="true">
          Preguntar
        </span>
      </div>
      {chips && questions.length > 1 && (
        <div className="ad-chips">
          {questions.map((q, i) => (
            <button key={q.label} type="button" className="ad-chip" aria-pressed={i === pick} onClick={() => play(i, false)}>
              {q.label}
            </button>
          ))}
        </div>
      )}
      <div className="ad-stage">
      {phase === 1 && (
        <div className="ad-think">
          <span>· Leyendo la pregunta</span>
          <span>· {cur.consulting}</span>
        </div>
      )}
      <div className="ad-answer" data-done={done || undefined} aria-hidden={done ? undefined : true}>
        <p className="ad-text">
          <Rich text={cur.answer} />
        </p>
        {chart === "bars" ? (
          <div className="ad-bars">
            {cur.bars.map(([name, v, value]) => (
              <div key={name} className="ad-bar">
                <span className="ad-bar-l">
                  <span>{name}</span>
                  <b>{value}</b>
                </span>
                <span className="ad-track">
                  <span className="ad-fill" style={{ width: done ? `${Math.round((v / max) * 100)}%` : "0%" }} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="ad-cols">
            {cur.bars.map(([name, v, value], i) => (
              <div key={name} className="ad-col">
                <span className="ad-col-bar" data-i={i} style={{ height: done ? `${Math.max(4, Math.round((v / max) * 96))}px` : "0px" }} />
                <span className="ad-col-l">
                  {name} · {value}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="ad-how">
          <b>Así lo calculé:</b> {cur.how}
        </p>
        <div className="ad-acts">
          {actions.map((a) => (
            <span key={a.label} className="ad-act" data-primary={a.primary || undefined}>
              {a.label}
            </span>
          ))}
          {source && <span className="ad-source">{source}</span>}
        </div>
      </div>
      </div>
      {agent ? (
        <AgentFoot note={note} replay={replay} onReplay={again} />
      ) : (
        <span className="ad-note">{note}</span>
      )}
    </div>
  )
}
