// Volver al portal con la huella o la cara (sección «Cómo entra» de /portal-del-paciente): la pantalla de
// entrada del portal real («Tu portal», «Entrar con mi huella o mi cara»); al tocarla, Andrea ya está
// adentro con lo que ve primero. El acceso al portal lo da recepción, como en la app.
import { useState } from "react"
import "./passkey-login.css"

export default function PasskeyLogin() {
  const [inside, setInside] = useState(false)
  return (
    <div className="dpk">
      <span className="dpk-org">Clínica Sonrisa Norte</span>
      <span className={`dpk-finger${inside ? " in" : ""}`} aria-hidden="true">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 11v3a6 6 0 0 1-1 3.3" />
          <path d="M8.5 8.2A4 4 0 0 1 16 10v2.5a10 10 0 0 1-.6 3.5" />
          <path d="M5.6 6.5A7 7 0 0 1 19 10v1.5" />
          <path d="M8 12v1a9 9 0 0 1-1.4 4.8" />
          <path d="M3.5 11a8.5 8.5 0 0 1 .7-3.4" />
          <path d="M18.8 15.5a14 14 0 0 1-.9 3" />
        </svg>
      </span>
      <div className="dpk-say" aria-live="polite">
        <b>{inside ? "Hola, Andrea" : "Tu portal"}</b>
        <span>{inside ? "Entraste con tu huella." : "Tus citas, presupuestos y documentos, cuando quieras."}</span>
      </div>
      {inside ? (
        <>
          <ul className="dpk-list">
            <li>
              <b>Tu próxima cita</b>
              <span>Jueves 29 de octubre · 10:30</span>
            </li>
            <li>
              <b>Por decidir</b>
              <span>1 presupuesto</span>
            </li>
            <li>
              <b>Tus documentos</b>
              <span>Lo que la clínica te autoriza</span>
            </li>
          </ul>
          <button type="button" className="dpk-reset" onClick={() => setInside(false)}>
            Reiniciar el ejemplo
          </button>
        </>
      ) : (
        <>
          <button type="button" className="dpk-main" onClick={() => setInside(true)}>
            Entrar con mi huella o mi cara
          </button>
          <span className="dpk-help">¿Aún no tienes acceso? Pídelo en recepción.</span>
        </>
      )}
    </div>
  )
}
