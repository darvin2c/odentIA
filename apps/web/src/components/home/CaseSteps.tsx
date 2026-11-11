// 03 · Un caso, de principio a fin: siete pasos, cada uno con su agente y su canal.
// Al llegar a la sección empieza ya con el primer paso a la vista y avanza solo; da dos vueltas y se
// queda terminado (WCAG 2.2.2). Tocar un paso lo detiene ahí. El control, discreto, dice lo que hace
// en cada momento: «Pausar», «Seguir» o «Volver a ver». En pausa (el botón de la portada) o con menos
// movimiento se muestra completo; lo que toca la persona manda igual.
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"
import "./case-steps.css"

const CC = ["#0e7490", "#1f9d7a", "#c98a1c"]
const AN = ["Sofi", "Clío", "Argos"]
const CASE = [
  {
    when: "Lunes 19:10",
    ch: "Instagram",
    a: 0,
    text: "Lucía pregunta cuánto le falta para quitarse los brackets.",
  },
  {
    when: "Lunes 19:11",
    ch: "Instagram",
    a: 0,
    text: "Sofi le confirma su control del martes 28 y se ofrece a recordárselo.",
  },
  {
    when: "Miércoles 08:30",
    ch: "WhatsApp",
    a: 0,
    text: "Carmen, su mamá, pide pasarlo al viernes y Sofi lo mueve.",
  },
  { when: "Jueves 16:00", ch: "Correo", a: 2, text: "Le recuerda a Carmen el control de mañana." },
  {
    when: "Viernes 16:20",
    ch: "Consulta",
    a: 1,
    text: "La Dra. Paredes dicta el control y confirma la nota.",
  },
  {
    when: "Viernes 16:40",
    ch: "Historia",
    a: 1,
    text: "Queda listo el próximo control, en seis meses.",
  },
  {
    when: "Seis meses después",
    ch: "WhatsApp",
    a: 2,
    text: "Le escribe a Carmen, y Lucía reserva su control y vuelve.",
  },
]
const N = CASE.length
/** Vueltas que da solo antes de quedarse terminado. */
const ROUNDS = 2
/** Pasos que se queda en el último antes de volver a empezar. */
const HOLD = 3
/** Lo que puede decir el control, con su signo; el más largo reserva su ancho. */
const LABELS: [string, string][] = [
  ["❚❚", "Pausar"],
  ["▶", "Seguir"],
  ["↻", "Volver a ver"],
]

const by = (ch: string) => (ch === "Consulta" || ch === "Historia" ? `la ${ch.toLowerCase()}` : ch)

export default function CaseSteps() {
  const moving = useMoving()
  // El HTML generado lleva el caso completo; en pantalla empieza con el primer paso a la vista.
  const [cs, setCs] = useState(N)
  // Avanza solo (`play`); `asked`: la persona tocó un paso o el control, y manda ella.
  const [play, setPlay] = useState(false)
  const [asked, setAsked] = useState(false)
  const [done, setDone] = useState(false)
  const [visible, setVisible] = useState(false)
  const hold = useRef(0)
  const laps = useRef(0)
  const started = useRef(false)
  const box = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !window.IntersectionObserver) return
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting)
        // La primera vez que se ve, arranca desde el primer paso (salvo con menos movimiento).
        if (e.isIntersecting && !started.current && !prefersReducedMotion()) {
          started.current = true
          setCs(1)
          setPlay(true)
        }
      },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Se mueve si avanza solo y nada lo frena; si lo pidió la persona, aunque la página esté en pausa.
  const playing = play && (moving || asked)
  useInterval(() => {
    if (!playing || !visible) return
    if (cs < N) {
      setCs(cs + 1)
      return
    }
    if (++hold.current < HOLD) return
    hold.current = 0
    laps.current += 1
    // Dio sus vueltas: se queda terminado, con todo el caso a la vista.
    if (laps.current >= ROUNDS) {
      setPlay(false)
      setDone(true)
    } else setCs(1)
  }, 1700)

  // En pausa o con menos movimiento, el caso completo; lo que eligió la persona, siempre.
  const shown = moving || asked ? cs : N
  const now = shown > 0 && shown <= N ? CASE[shown - 1] : null
  // Señala el paso en curso mientras avanza o el que eligió la persona; terminado, ninguno.
  const pointed = playing || (asked && !play && !done) ? shown - 1 : -1
  const [glyph, label] = playing ? LABELS[0] : shown < N ? LABELS[1] : LABELS[2]

  const control = () => {
    setAsked(true)
    setDone(false)
    hold.current = 0
    if (playing) setPlay(false)
    else if (shown < N) setPlay(true)
    else {
      // Una vuelta más, a pedido: después se queda terminado.
      laps.current = ROUNDS - 1
      setCs(1)
      setPlay(true)
    }
  }
  const pick = (i: number) => {
    setAsked(true)
    setDone(false)
    setPlay(false)
    hold.current = 0
    setCs(i + 1)
  }

  return (
    <>
      <div className="sr case-head">
        <div className="hs-head">
          <span className="tag">[ 03 · Las dos juntas ]</span>
          <h2 className="h2">Un caso, de principio a fin.</h2>
          <p className="lead">
            Empieza con una pregunta por Instagram y termina con Lucía de vuelta en su control. Cada
            paso dice qué agente lo hizo y por dónde. Toca uno para quedarte en él.
          </p>
        </div>
        <button type="button" className="case-ctl" onClick={control}>
          <span className="fit fit-inline">
            {LABELS.map(([g, text]) => (
              <span key={text} className="fit-ghost" aria-hidden="true">
                <span className="case-ctl-g">{g}</span>
                {text}
              </span>
            ))}
            <span>
              <span className="case-ctl-g" aria-hidden="true">
                {glyph}
              </span>
              {label}
            </span>
          </span>
        </button>
      </div>
      <div className="case-rail" aria-hidden="true">
        <span className="case-fill" style={{ width: `${(shown / N) * 100}%` }}></span>
        {CASE.map((c, i) => (
          <i
            key={c.when}
            className={i < shown ? "on" : ""}
            style={{ left: `${((i + 0.5) / N) * 100}%`, "--c": CC[c.a] } as CSSProperties}
          ></i>
        ))}
      </div>
      <ol className="case" ref={box}>
        {CASE.map((c, i) => (
          <li key={c.when} style={{ "--c": CC[c.a] } as CSSProperties}>
            <button
              type="button"
              className={i < shown ? (i === pointed ? "cstep on last" : "cstep on") : "cstep"}
              aria-current={i === pointed ? "step" : undefined}
              onClick={() => pick(i)}
            >
              <span className="when">
                {c.when}
                <span className="agent-m"> · {AN[c.a]}</span>
              </span>
              <span className="chan">{c.ch}</span>
              <strong>{c.text}</strong>
              <span className="agent">
                <i aria-hidden="true"></i>
                {AN[c.a]}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {/* El pie cambia en cada paso; reserva el alto del más largo para no mover lo que sigue. */}
      <div className="fit">
        {CASE.map((c, i) => (
          <p key={c.when} className="case-now fit-ghost" aria-hidden="true">
            <span className="mono">
              Paso {i + 1} de {N} · {c.when}
            </span>
            <span>
              <i></i>
              {AN[c.a]}, por {by(c.ch)}
            </span>
          </p>
        ))}
        <p className="case-now">
          {now && pointed >= 0 ? (
            <>
              <span className="mono">
                Paso {shown} de {N} · {now.when}
              </span>
              <span style={{ "--c": CC[now.a] } as CSSProperties}>
                <i aria-hidden="true"></i>
                {AN[now.a]}, por {by(now.ch)}
              </span>
            </>
          ) : (
            <span className="mono">Siete pasos, tres agentes y una sola historia.</span>
          )}
        </p>
      </div>
    </>
  )
}
