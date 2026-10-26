// El examen físico de Rosa por sus 10 sistemas (lienzo de latidIA, tablero «Historia»): cada uno
// «Sin alteraciones», «Con hallazgos» o, si no se marca, «No examinado», como en la app. Al lado,
// cómo queda escrito en la historia: lo no examinado nunca pasa por normal.
import { useState } from "react"
import "./exam-demo.css"

type Mark = "ok" | "hall"

/** Los 10 sistemas del examen físico de latidIA, en el orden de la app. */
const SYSTEMS: Array<[id: string, name: string]> = [
  ["estado", "Estado general"],
  ["piel", "Piel"],
  ["cabeza", "Cabeza y cuello"],
  ["boca", "Boca y garganta"],
  ["torax", "Tórax y pulmones"],
  ["corazon", "Corazón"],
  ["abdomen", "Abdomen"],
  ["genital", "Genital y urinario"],
  ["extremidades", "Extremidades"],
  ["neuro", "Neurológico"],
]
/** Lo que encontró la Dra. Vela en Rosa; un hallazgo nuevo pide que se describa. */
const FINDINGS: Record<string, string> = { boca: "Amígdalas aumentadas con placas blanquecinas." }
const START: Record<string, Mark> = { estado: "ok", boca: "hall", torax: "ok", corazon: "ok" }

export default function ExamDemo() {
  const [exam, setExam] = useState<Record<string, Mark>>(START)
  // Tocar el botón ya marcado lo desmarca: el sistema vuelve a «No examinado».
  const mark = (id: string, value: Mark) =>
    setExam((current) => {
      const next = { ...current }
      if (next[id] === value) delete next[id]
      else next[id] = value
      return next
    })

  const examined = SYSTEMS.filter(([id]) => exam[id]).length
  const withFindings = SYSTEMS.filter(([id]) => exam[id] === "hall").length
  const okNames = SYSTEMS.filter(([id]) => exam[id] === "ok").map(([, name]) => name)
  const hallParts = SYSTEMS.filter(([id]) => exam[id] === "hall").map(
    ([id, name]) => `${name}: ${FINDINGS[id] ? FINDINGS[id].toLowerCase() : "con hallazgos"}`,
  )
  const notNames = SYSTEMS.filter(([id]) => !exam[id]).map(([, name]) => name)
  const parts: string[] = []
  if (okNames.length) parts.push(`Sin alteraciones: ${okNames.join(", ")}.`)
  if (hallParts.length) parts.push(hallParts.join(" ").replace(/\.?$/, "."))
  if (notNames.length) parts.push(`No examinado: ${notNames.join(", ")}.`)
  const recordText = parts.join(" ") || "Nada examinado todavía."
  const count = `${examined} de ${SYSTEMS.length} examinados`

  return (
    <div className="ex">
      <div className="ex-card">
        <div className="ex-head">
          <span className="ex-title">
            <b>Examen físico</b>
            <span>Rosa Paredes Luna · fiebre y dolor de garganta</span>
          </span>
          <span className="ex-sum" aria-live="polite">
            {examined} examinados · {withFindings} con hallazgos · {SYSTEMS.length - examined} sin examinar
          </span>
        </div>
        {SYSTEMS.map(([id, name]) => {
          const value = exam[id]
          return (
            <div key={id} className="ex-row">
              <span className="ex-sys">
                <span className="ex-name">{name}</span>
                <span className={`ex-sub ${value ?? "none"}`}>
                  {value === "ok" ? "Sin alteraciones" : value === "hall" ? (FINDINGS[id] ?? "Describe lo que encontraste…") : "No examinado"}
                </span>
              </span>
              <fieldset className="ex-seg">
                <legend className="sr-only">{name}</legend>
                <button type="button" aria-pressed={value === "ok"} onClick={() => mark(id, "ok")}>
                  Sin alteraciones
                </button>
                <button type="button" className="hall" aria-pressed={value === "hall"} onClick={() => mark(id, "hall")}>
                  Con hallazgos
                </button>
              </fieldset>
            </div>
          )
        })}
        {/* En el teléfono, una copia breve de lo escrito acompaña a las filas al bajar; el registro
            completo (el que se anuncia) sigue debajo. */}
        <div className="ex-mini" aria-hidden="true">
          <span className="ex-rec-head">
            <span className="ex-k">ASÍ QUEDA EN LA HISTORIA</span>
            <span className="ex-count">{count}</span>
          </span>
          <span className="ex-mini-text">{recordText}</span>
        </div>
        <span className="ex-foot">
          Lo que no marcas queda como «No examinado» en la historia: nunca se da por normal. Toca un botón marcado para
          desmarcarlo.
        </span>
      </div>
      <div className="ex-aside">
        <div className="ex-record">
          <span className="ex-rec-head">
            <span className="ex-k">ASÍ QUEDA EN LA HISTORIA</span>
            <span className="ex-count">{count}</span>
          </span>
          <span className="ex-text" aria-live="polite">
            {recordText}
          </span>
        </div>
        <div className="ex-why">
          <b>¿Por qué no «normal» por defecto?</b>
          <span>
            Una plantilla con todo en «normal» diría que examinaste el abdomen aunque no lo tocaste. Si mañana otro médico lee
            la historia, o alguien la pide, lo escrito tiene que ser lo que pasó.
          </span>
        </div>
      </div>
    </div>
  )
}
