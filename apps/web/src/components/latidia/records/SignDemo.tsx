// El cierre de la atención de Rosa (lienzo de latidIA, tablero «Historia»): «Finalizar y firmar»
// la deja fija con la colegiatura y, después, solo se le agregan adendas. Ejemplo sin servidor.
import { useEffect, useRef, useState } from "react"
import "./sign-demo.css"

const CHECKS = [
  "Motivo: fiebre y dolor de garganta",
  "J03.9 Amigdalitis aguda · presuntivo",
  "Evolución e indicaciones",
  "Tu colegiatura: CMP 045678",
]
const ADDENDUM = "Llamó a las 18:00: sin fiebre desde la tarde, tolera bien la medicación."

export default function SignDemo() {
  const [signed, setSigned] = useState(false)
  const [addenda, setAddenda] = useState(0)
  // El botón que se tocó desaparece: el foco pasa al que lo reemplaza (no al montar).
  const nextFocus = useRef<HTMLButtonElement>(null)
  const acted = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se mueve el foco cada vez que cambia la firma.
  useEffect(() => {
    if (acted.current) nextFocus.current?.focus()
  }, [signed])
  return (
    <div className="sg">
      <span className="sg-head">
        <b>Cierre de la atención</b>
        <span>Rosa Paredes Luna · hoy 10:45 · Dra. Elena Vela</span>
      </span>
      <span className="sg-lead">
        Al cerrar se firma con tu colegiatura y la atención queda fija: después solo se agregan adendas.
      </span>
      <ul className="sg-list">
        {CHECKS.map((text) => (
          <li key={text}>
            <span className="sg-ok" aria-hidden="true">
              ✓
            </span>
            {text}
          </li>
        ))}
      </ul>
      <div aria-live="polite" className="sg-live">
        {signed ? (
          <>
            <div className="sg-signed">
              <b>Firmada el 24/10/2026 a las 10:58</b>
              <span>Elena Vela · médico cirujano · CMP 045678. Ya no se cambia.</span>
            </div>
            {addenda > 0 && (
              <div className="sg-add">
                <span className="sg-when">ADENDA · 24/10/2026 18:05 · Elena Vela</span>
                <span>{ADDENDUM}</span>
              </div>
            )}
          </>
        ) : null}
      </div>
      {signed ? (
        <div className="sg-actions">
          <button ref={nextFocus} type="button" className="sg-btn grey" aria-disabled={addenda > 0} onClick={() => setAddenda(1)}>
            {addenda > 0 ? "Adenda agregada" : "Agregar adenda"}
          </button>
          <button
            type="button"
            className="sg-btn link"
            onClick={() => {
              acted.current = true
              setSigned(false)
              setAddenda(0)
            }}
          >
            Reiniciar el ejemplo
          </button>
        </div>
      ) : (
        <button
          ref={nextFocus}
          type="button"
          className="sg-btn main"
          onClick={() => {
            acted.current = true
            setSigned(true)
          }}
        >
          Finalizar y firmar
        </button>
      )}
    </div>
  )
}
