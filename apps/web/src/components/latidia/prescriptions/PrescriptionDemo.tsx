// «Emitir receta» en la portada de Receta y descanso médico (lienzo de latidIA, tablero «Receta»):
// tres casos de la demo que pasan solos hasta que alguien toca uno. Se escribe el medicamento y
// aparece lo que diría la receta real; los textos de los avisos son los de
// `packages/medical/src/prescribing.ts` (checkPrescription), con los datos de cada caso.
import { useEffect, useState } from "react"
import "./prescription-demo.css"

type CaseId = "embarazo" | "nino" | "controlado"
type Kind = "warn" | "info" | "plain"

interface Case {
  label: string
  initials: string
  patient: string
  detail: string
  chip: string
  chipKind: Kind
  reminder?: string
  dci: string
  conc: string
  forma: string
  dosis: string
  dur: string
}

const CASES: Record<CaseId, Case> = {
  embarazo: {
    label: "Julia · embarazada",
    initials: "JR",
    patient: "Julia Ramos Vega",
    detail: "32 años · chequeo anual",
    chip: "Embarazada, 12 semanas",
    chipKind: "warn",
    reminder: "Está embarazada, 12 semanas (registrado el 24 de octubre): revisa que cada medicamento sea seguro en el embarazo.",
    dci: "doxiciclina",
    conc: "100 mg",
    forma: "cápsula",
    dosis: "1 cápsula cada 12 horas",
    dur: "7 días",
  },
  nino: {
    label: "Tomás · 8 años",
    initials: "TP",
    patient: "Tomás Paredes",
    detail: "8 años · lo trae su mamá, Rosa",
    chip: "Menor de 12 años",
    chipKind: "info",
    dci: "amoxicilina",
    conc: "250 mg / 5 mL",
    forma: "suspensión",
    dosis: "5 mL cada 8 horas",
    dur: "7 días",
  },
  controlado: {
    label: "Luis · controlado",
    initials: "LG",
    patient: "Luis Gómez Salas",
    detail: "62 años · control de presión",
    chip: "Sin alergias",
    chipKind: "plain",
    dci: "clonazepam",
    conc: "0,5 mg",
    forma: "tableta",
    dosis: "",
    dur: "",
  },
}
const ORDER: CaseId[] = ["embarazo", "nino", "controlado"]
/** Pasos de 110 ms: escribir, aparecer el aviso y, mientras nadie toque, pasar al siguiente caso. */
const TICK = 110
const LAST_TICK = 60
const DONE = 99

export default function PrescriptionDemo() {
  const [kase, setKase] = useState<CaseId>("embarazo")
  // En el servidor y sin movimiento se ve el primer caso terminado.
  const [t, setT] = useState(DONE)
  const [auto, setAuto] = useState(true)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setReduced(true)
      return
    }
    setT(0)
    const id = setInterval(() => setT((n) => n + 1), TICK)
    return () => clearInterval(id)
  }, [])

  // Al terminar un caso, si nadie tocó, se pasa al siguiente.
  useEffect(() => {
    if (t < LAST_TICK || t >= DONE || !auto) return
    setKase((k) => ORDER[(ORDER.indexOf(k) + 1) % ORDER.length])
    setT(0)
  }, [t, auto])

  const c = CASES[kase]
  const done = t >= c.dci.length + 4
  const typed = c.dci.slice(0, Math.min(c.dci.length, t))
  // El peso de Tomás se escribe un poco después del medicamento.
  const weightStep = t - (c.dci.length + 16)
  const weight = kase === "nino" && weightStep > 0 ? "26".slice(0, Math.min(2, weightStep)) : ""
  const weightDone = weight === "26"

  let block: { kind: "stop" | "warn" | "ok"; title: string; text: string } | null = null
  let status = "Escribe el medicamento."
  let emitOk = false
  let emitLabel = "Emitir receta"
  if (done) {
    if (kase === "embarazo") {
      block = {
        kind: "warn",
        title: "Contraindicado en el embarazo",
        text: "Doxiciclina: está embarazada (12 semanas) y las tetraciclinas están contraindicadas en el embarazo (ATC J01AA02).",
      }
      status = "Solo se emite con un motivo escrito."
    } else if (kase === "nino") {
      if (weightDone) {
        block = { kind: "ok", title: "Lista", text: "El peso, 26 kg, va en la receta." }
        status = "Lista para emitir con tu firma."
        emitOk = true
      } else {
        block = { kind: "stop", title: "Falta el peso", text: "Tiene 8 años: escribe su peso para recetarle." }
        status = "Sin el peso no se emite."
      }
    } else {
      block = {
        kind: "stop",
        title: "Medicamento controlado",
        text: "Clonazepam es una benzodiazepina, un medicamento controlado: no va en la receta común, usa la receta oficial.",
      }
      status = "Este no sale en la receta del consultorio."
      emitLabel = "No se emite aquí"
    }
  }

  const pick = (id: CaseId) => {
    setKase(id)
    setT(reduced ? DONE : 0)
    setAuto(false)
  }

  return (
    <div className="rx">
      <div className="rx-top">
        <span className="rx-title">
          <b>Emitir receta</b>
          <span>La receta queda fija: para corregirla se anula con motivo.</span>
        </span>
        <fieldset className="rx-cases">
          <legend className="sr-only">Elige un caso</legend>
          {ORDER.map((id) => (
            <button key={id} type="button" aria-pressed={kase === id} onClick={() => pick(id)}>
              {CASES[id].label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="rx-body">
        <div className="rx-who">
          <span className="rx-av" aria-hidden="true">
            {c.initials}
          </span>
          <span className="rx-name">
            <b>{c.patient}</b>
            <span>{c.detail}</span>
          </span>
          <span className={`rx-chip ${c.chipKind}`}>{c.chip}</span>
        </div>
        {c.reminder && <div className="rx-reminder">{c.reminder}</div>}
        <div className="rx-form">
          <span className="rx-field full">
            <span className="rx-label">DCI (denominación común)</span>
            <span className={`rx-input dci${done ? "" : " typing"}`}>
              <span>{typed}</span>
              {!done && <span className="rx-caret" aria-hidden="true" />}
            </span>
          </span>
          <span className="rx-field">
            <span className="rx-label">Concentración</span>
            <span className="rx-input">{done ? c.conc : ""}</span>
          </span>
          <span className="rx-field">
            <span className="rx-label">Forma farmacéutica</span>
            <span className="rx-input">{done ? c.forma : ""}</span>
          </span>
          <span className="rx-field">
            <span className="rx-label">Dosis y frecuencia</span>
            <span className="rx-input">{done ? c.dosis : ""}</span>
          </span>
          <span className="rx-field">
            <span className="rx-label">Duración</span>
            <span className="rx-input">{done ? c.dur : ""}</span>
          </span>
          {kase === "nino" && done && (
            <span className="rx-field full">
              <span className="rx-label">Peso (kg)</span>
              <span className={`rx-input${weightDone ? " strong" : " missing"}`}>{weight || "Escribe el peso"}</span>
            </span>
          )}
        </div>
        {/* Mientras los casos pasan solos no se anuncian; después de tocar uno, sí. */}
        <div className="rx-checks" aria-live={auto ? "off" : "polite"}>
          {block && (
            <div className={`rx-block ${block.kind}`}>
              <b>{block.title}</b>
              <span>{block.text}</span>
            </div>
          )}
          {done && kase === "embarazo" && (
            <span className="rx-field">
              <span className="rx-label">Motivo para recetarlo igual</span>
              <span className="rx-input motive">Escribe por qué, como harías con una alergia…</span>
            </span>
          )}
        </div>
        <div className="rx-foot">
          <span className="rx-status">{status}</span>
          <span className={`rx-emit${emitOk ? " ok" : ""}`}>{emitLabel}</span>
        </div>
      </div>
      <div className="rx-note">Demostración con datos de ejemplo. Elige un caso: las mismas reglas se revisan otra vez al emitir.</div>
    </div>
  )
}
