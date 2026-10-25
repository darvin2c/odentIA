// Volver al portal con la huella o la cara (lienzo de latidIA, tablero «Enlace»): la pantalla de
// entrada del portal con «Entrar con tu huella o tu cara»; al tocarlo, Rosa ya está adentro. El
// acceso al portal lo da recepción, como en la app.
import { useState } from "react"
import "./passkey-login.css"

export default function PasskeyLogin() {
  const [inside, setInside] = useState(false)
  return (
    <div className="pk">
      <span className="pk-org">CONSULTORIO SAN MARTÍN · TU PORTAL</span>
      <span className={`pk-finger${inside ? " in" : ""}`} aria-hidden="true">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 11v3a6 6 0 0 1-1 3.3" />
          <path d="M8.5 8.2A4 4 0 0 1 16 10v2.5a10 10 0 0 1-.6 3.5" />
          <path d="M5.6 6.5A7 7 0 0 1 19 10v1.5" />
          <path d="M8 12v1a9 9 0 0 1-1.4 4.8" />
          <path d="M3.5 11a8.5 8.5 0 0 1 .7-3.4" />
          <path d="M18.8 15.5a14 14 0 0 1-.9 3" />
        </svg>
      </span>
      <div className="pk-say" aria-live="polite">
        <b>{inside ? "Hola, Rosa" : "Entrar a tu portal"}</b>
        <span>
          {inside
            ? "Entraste con tu huella. Tu próxima cita es el lunes 26 a las 09:00."
            : "Usa la huella o la cara que guardaste en este teléfono."}
        </span>
      </div>
      {inside ? (
        <button type="button" className="pk-reset" onClick={() => setInside(false)}>
          Reiniciar el ejemplo
        </button>
      ) : (
        <>
          <button type="button" className="pk-main" onClick={() => setInside(true)}>
            Entrar con tu huella o tu cara
          </button>
          <span className="pk-help">¿Aún no tienes acceso? Pídelo en recepción.</span>
        </>
      )}
    </div>
  )
}
