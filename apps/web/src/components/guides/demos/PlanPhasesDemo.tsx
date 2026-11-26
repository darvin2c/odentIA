// El plan de Jorge por fases (guía del plan de tratamiento, «Pruébalo aquí»): cada tratamiento que se
// indica cae en la fase que propone la app (`phaseForTreatment` de @odentia/dental): la endodoncia de
// una pulpitis en Urgencia, la resina y el destartraje en la Básica, el implante en la Quirúrgica y
// las coronas en la Rehabilitadora, después de lo que las sostiene. Mantenimiento no se propone sola:
// la pone el odontólogo. Las sesiones son de ejemplo (en la app salen de cada servicio). No guarda nada.
import { useEffect, useRef, useState } from "react"
import "./demos.css"

type Phase = "urgencia" | "basica" | "quirurgica" | "rehabilitadora" | "mantenimiento"

const PHASES: Array<[Phase, string]> = [
  ["urgencia", "Urgencia"],
  ["basica", "Básica o higiénica"],
  ["quirurgica", "Quirúrgica"],
  ["rehabilitadora", "Rehabilitadora"],
  ["mantenimiento", "Mantenimiento"],
]

interface Item {
  id: string
  tooth: string
  treatment: string
  diagnosis: string
  sessions: number
  phase: Phase
  why: string
}

const ITEMS: Item[] = [
  {
    id: "endo",
    tooth: "36",
    treatment: "Endodoncia",
    diagnosis: "K04.0 Pulpitis (irreversible sintomática)",
    sessions: 2,
    phase: "urgencia",
    why: "Su diagnóstico es de dolor: se propone en Urgencia.",
  },
  {
    id: "resina",
    tooth: "15",
    treatment: "Resina de una cara",
    diagnosis: "K02.1 Caries de la dentina",
    sessions: 1,
    phase: "basica",
    why: "Controlar la caries va en la fase básica.",
  },
  {
    id: "destartraje",
    tooth: "Boca",
    treatment: "Destartraje y profilaxis",
    diagnosis: "K03.6 Depósitos · K05.1 Gingivitis crónica",
    sessions: 1,
    phase: "basica",
    why: "Sanar la encía va en la fase básica, antes de operar o rehabilitar.",
  },
  {
    id: "implante",
    tooth: "46",
    treatment: "Implante",
    diagnosis: "K08.1 Pérdida de dientes por extracción",
    sessions: 1,
    phase: "quirurgica",
    why: "Colocar el implante es cirugía.",
  },
  {
    id: "corona36",
    tooth: "36",
    treatment: "Corona metal-cerámica",
    diagnosis: "K04.0 Pulpitis (irreversible sintomática)",
    sessions: 2,
    phase: "rehabilitadora",
    why: "La corona va en la rehabilitadora, después de su endodoncia: no se adelanta aunque la pieza duela.",
  },
  {
    id: "corona46",
    tooth: "46",
    treatment: "Corona sobre el implante",
    diagnosis: "K08.1 Pérdida de dientes por extracción",
    sessions: 2,
    phase: "rehabilitadora",
    why: "Lo que va sobre el implante es rehabilitación, después de la cirugía.",
  },
]

export default function PlanPhasesDemo() {
  const [placed, setPlaced] = useState<string[]>([])
  const [last, setLast] = useState<Item | null>(null)
  const firstButton = useRef<HTMLButtonElement>(null)
  const again = useRef<HTMLButtonElement>(null)
  const done = placed.length === ITEMS.length
  const pending = ITEMS.filter((item) => !placed.includes(item.id))
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    // El botón tocado desaparece: el foco sigue en el siguiente, o en «Volver a empezar».
    if (done) again.current?.focus()
    else firstButton.current?.focus()
  }, [placed, done])

  const indicate = (items: Item[]) => {
    moved.current = true
    setPlaced((now) => [...now, ...items.map((item) => item.id)])
    setLast(items.length === 1 ? items[0]! : null)
  }
  const reset = () => {
    moved.current = true
    setPlaced([])
    setLast(null)
  }

  return (
    <div className="gx gx-plan">
      <div className="gx-card">
        <div className="gx-head">
          <b>Jorge Ramírez · Plan de tratamiento</b>
          <span>Lo que encontraste hoy. Toca «Indicar» y mira en qué fase cae.</span>
        </div>
        {pending.length > 0 ? (
          <ul className="gx-todo" aria-label="Por indicar">
            {pending.map((item, index) => (
              <li key={item.id}>
                <span className="gx-todo-t">
                  <b>
                    {item.treatment} · {item.tooth === "Boca" ? "toda la boca" : `pieza ${item.tooth}`}
                  </b>
                  <span>{item.diagnosis}</span>
                </span>
                <button type="button" className="gx-btn" ref={index === 0 ? firstButton : undefined} onClick={() => indicate([item])}>
                  Indicar
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {pending.length > 1 ? (
          <button type="button" className="gx-btn gx-btn-soft" onClick={() => indicate(pending)}>
            Indicar todo
          </button>
        ) : null}
        <p className={done ? "gx-status ok" : "gx-status"} aria-live="polite">
          {done
            ? `Plan listo: ${ITEMS.length} tratamientos en ${new Set(ITEMS.map((item) => item.phase)).size} fases. Cada cita dirá en qué sesión va («Endodoncia · 36 · sesión 1 de 2») y al firmar, el presupuesto se arma con este plan.`
            : last
              ? `${last.treatment} · ${last.tooth === "Boca" ? "boca" : last.tooth}: ${PHASES.find(([key]) => key === last.phase)![1]}. ${last.why}`
              : "odentIA propone la fase de cada tratamiento; en la app la cambias si tu caso lo pide."}
        </p>
        {done ? (
          <button type="button" className="gx-btn gx-btn-soft" ref={again} onClick={reset}>
            Volver a empezar
          </button>
        ) : null}
        <ol className="gx-phases" aria-label="El plan, por fases">
          {PHASES.map(([key, label]) => {
            const items = ITEMS.filter((item) => item.phase === key && placed.includes(item.id))
            return (
              <li key={key} className={items.length ? "on" : ""}>
                <span className="gx-phase-t">{label}</span>
                {items.length ? (
                  <ul>
                    {items.map((item) => (
                      <li key={item.id} className={last?.id === item.id ? "new" : ""}>
                        <span>
                          {item.treatment} · {item.tooth === "Boca" ? "boca" : item.tooth}
                        </span>
                        <span className="gx-chip">
                          {item.sessions === 1 ? "1 sesión" : `${item.sessions} sesiones`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="gx-phase-empty">
                    {key === "mantenimiento" ? "La pones tú: el control." : "—"}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
