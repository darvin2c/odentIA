// 03 · Un caso, de principio a fin: siete pasos, cada uno con su agente y su canal.
// Al llegar a la sección se reproduce solo, paso a paso, y vuelve a empezar mientras se ve.
// En pausa o con menos movimiento se muestra completo.
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

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
    text: "Le escribe a Carmen, Lucía reserva y vuelve: cita recuperada.",
  },
]

export default function CaseSteps() {
  const moving = useMoving()
  // El HTML generado lleva el caso completo; en pantalla empieza desde el primer paso.
  const [cs, setCs] = useState(7)
  const [visible, setVisible] = useState(false)
  const hold = useRef(0)
  const box = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !window.IntersectionObserver) return
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting)
        if (e.isIntersecting && !prefersReducedMotion()) setCs((v) => (v >= 7 ? 0 : v))
      },
      { threshold: 0.35 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useInterval(() => {
    if (!moving || !visible) return
    if (cs < 7) setCs(cs + 1)
    else if (++hold.current >= 3) {
      hold.current = 0
      setCs(0)
    }
  }, 1700)
  const shown = moving ? cs : 7
  const now = shown > 0 && shown <= 7 ? CASE[shown - 1] : null

  return (
    <>
      <div className="sr case-head">
        <div className="hs-head">
          <span className="tag">[ 03 · Las dos juntas ]</span>
          <h2 className="h2">Un caso, de principio a fin.</h2>
          <p className="lead">
            Empieza con una pregunta por Instagram y termina con Lucía de vuelta en su control. Cada
            paso dice qué agente lo hizo y por dónde.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-d case-play"
          onClick={() => {
            hold.current = 0
            setCs(prefersReducedMotion() ? 7 : 0)
          }}
        >
          Volver a empezar
        </button>
      </div>
      <div className="case-rail" aria-hidden="true">
        <span className="case-fill" style={{ width: `${(shown / 7) * 100}%` }}></span>
        {CASE.map((c, i) => (
          <i
            key={c.when}
            className={i < shown ? "on" : ""}
            style={{ left: `${((i + 0.5) / 7) * 100}%`, "--c": CC[c.a] } as CSSProperties}
          ></i>
        ))}
      </div>
      <ol className="case" ref={box}>
        {CASE.map((c, i) => (
          <li
            key={c.when}
            className={
              i < shown ? (i === shown - 1 && moving ? "cstep on last" : "cstep on") : "cstep"
            }
            style={{ "--c": CC[c.a] } as CSSProperties}
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
          </li>
        ))}
      </ol>
      <p className="case-now" aria-live="polite">
        {now && moving ? (
          <>
            <span className="mono">
              Paso {shown} de 7 · {now.when}
            </span>
            <span style={{ "--c": CC[now.a] } as CSSProperties}>
              <i aria-hidden="true"></i>
              {AN[now.a]}, por{" "}
              {now.ch === "Consulta" || now.ch === "Historia"
                ? `la ${now.ch.toLowerCase()}`
                : now.ch}
            </span>
          </>
        ) : (
          <span className="mono">Siete pasos, tres agentes y una sola historia.</span>
        )}
      </p>
    </>
  )
}
