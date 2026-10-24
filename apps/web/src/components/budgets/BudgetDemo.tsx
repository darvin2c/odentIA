// El presupuesto de Carlos (portada de Presupuestos): Clío lo arma del dictado, Argos lo retoma y
// Carlos acepta la opción A desde su enlace; después vuelve a empezar. Con «reducir movimiento», y en
// el servidor, se ve el estado final.
// Los montos en soles y el IGV son del ejemplo (una clínica de Perú), no precios de odentIA.
import { useEffect, useState } from "react"
import "./budget-demo.css"

/** Cada paso dura 1,8 s; el quinto deja ver lo aceptado un momento más antes de volver a empezar. */
const STEP_MS = 1800
const STEPS = 5
const FINAL = 3

type Line = [string, string]
const OPTIONS: Array<{ name: string; lines: Line[]; total: string; tax: string; recommended: boolean }> = [
  {
    name: "Opción A",
    lines: [
      ["Resina · pieza 36", "S/ 180,00"],
      ["Limpieza dental", "S/ 120,00"],
    ],
    total: "S/ 300,00",
    tax: "Incluye IGV S/ 45,76",
    recommended: true,
  },
  {
    name: "Opción B",
    lines: [
      ["Corona · pieza 36", "S/ 950,00"],
      ["Limpieza dental", "S/ 120,00"],
    ],
    total: "S/ 1.070,00",
    tax: "Incluye IGV S/ 163,22",
    recommended: false,
  },
]

export default function BudgetDemo() {
  const [step, setStep] = useState(FINAL)

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (mq.matches) return
    setStep(0)
    const timer = setInterval(() => setStep((s) => (s + 1) % STEPS), STEP_MS)
    const onChange = () => {
      if (mq.matches) {
        clearInterval(timer)
        setStep(FINAL)
      }
    }
    mq.addEventListener("change", onChange)
    return () => {
      clearInterval(timer)
      mq.removeEventListener("change", onChange)
    }
  }, [])

  const s = Math.min(step, FINAL)
  const accepted = s >= FINAL

  return (
    <div className="bd">
      <div className="bd-head">
        <b>Presupuesto de Carlos Medina</b>
        <span className="bd-meta">Dra. Paredes · 24 oct · ejemplo</span>
      </div>
      <div className="bd-opts">
        {OPTIONS.map((option) => (
          <div
            key={option.name}
            className={`bd-opt${option.recommended ? " bd-pick" : ""}${option.recommended && accepted ? " bd-accepted" : ""}`}
          >
            <span className="bd-name">
              <b>{option.name}</b>
              {option.recommended ? <span className="bd-badge">{accepted ? "Aceptada" : "Recomendada"}</span> : null}
            </span>
            {option.lines.map(([label, amount]) => (
              <span key={label} className="bd-line">
                <span>{label}</span>
                <span>{amount}</span>
              </span>
            ))}
            <span className="bd-total">
              <span>Total</span>
              <span>{option.total}</span>
            </span>
            <span className="bd-tax">{option.tax}</span>
          </div>
        ))}
      </div>
      <div className="bd-chips">
        <span className={`bd-chip bd-clio${s >= 1 ? " bd-on" : ""}`}>
          <i aria-hidden="true" />
          Clío lo armó del dictado: «resina, o si no una corona»
        </span>
        <span className={`bd-chip bd-argos${s >= 2 ? " bd-on" : ""}`}>
          <i aria-hidden="true" />
          Sin respuesta en dos días: Argos lo retomó
        </span>
      </div>
      <div className={`bd-done${accepted ? " bd-on" : ""}`}>
        <span className="bd-done-t">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3.5 9.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <b>Carlos aceptó la opción A</b> desde su enlace y eligió horario
          </span>
        </span>
        <span className="bd-when">martes 4 · 10:30</span>
      </div>
    </div>
  )
}
