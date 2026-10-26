// La ventana de 24 horas de WhatsApp (odentIA): Carmen escribió a las 08:10; «Hace 2 horas» está dentro
// y se le responde libre, «Hace 30 horas» está fuera y solo sale un mensaje aprobado por Meta, como el
// recordatorio de la cita de Lucía. Es la regla de Meta, la misma que la Bandeja avisa antes de escribir.
import { useState } from "react"
import "./whatsapp-window.css"

export default function WhatsappWindow() {
  const [late, setLate] = useState(false)
  return (
    <div className="ww">
      <b className="ww-title">La ventana de 24 horas</b>
      <span className="ww-text">
        Es una regla de WhatsApp: después de que la persona te escribe, tienes 24 horas para responder con lo que quieras. Pasado ese
        tiempo, solo puedes escribirle con un mensaje aprobado por Meta, como un recordatorio de cita.
      </span>
      <fieldset className="ww-opts">
        <legend className="sr-only">Cuándo escribió Carmen</legend>
        <button type="button" aria-pressed={!late} onClick={() => setLate(false)}>
          Hace 2 horas
        </button>
        <button type="button" aria-pressed={late} onClick={() => setLate(true)}>
          Hace 30 horas
        </button>
      </fieldset>
      <div className="ww-bar-wrap">
        <div className="ww-bar">
          <span className="ww-open" />
          <span className="ww-now" style={{ left: late ? "62.5%" : "4%" }} />
        </div>
        <div className="ww-scale" aria-hidden="true">
          <span>escribió · 08:10</span>
          <span>+24 h</span>
          <span>+48 h</span>
        </div>
      </div>
      <div className={`ww-box${late ? " late" : ""}`} aria-live="polite">
        <b>{late ? "Fuera de las 24 horas" : "Dentro de las 24 horas"}</b>
        <span>
          {late
            ? "Pasaron 24 horas desde su último mensaje: solo sale un mensaje aprobado por Meta, como el recordatorio de la cita de Lucía. Cuando Carmen responda, se abre otra vez la ventana."
            : "Tú, tu equipo o Sofi le responden con lo que haga falta, como en cualquier conversación."}
        </span>
      </div>
    </div>
  )
}
