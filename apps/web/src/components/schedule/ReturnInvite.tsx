// «Invitar a volver» de Argos (sección de Argos de /agenda-odontologica): Marta lleva más de seis meses
// sin venir, sin cita ni pendientes. Si se le puede escribir, Argos le envía el mensaje de la app
// (plantilla «Invitar a volver», con su botón «Sí, otro horario») dentro del horario de recontacto; si
// no hay cómo escribirle, queda una tarea de llamada para recepción. El interruptor cambia entre los dos.
import { useState } from "react"
import "./return-invite.css"

export default function ReturnInvite() {
  const [canWrite, setCanWrite] = useState(true)
  return (
    <div className="dri">
      <fieldset className="dri-opts">
        <legend className="sr-only">Cómo se le puede escribir</legend>
        <button type="button" aria-pressed={canWrite} onClick={() => setCanWrite(true)}>
          Tiene WhatsApp
        </button>
        <button type="button" aria-pressed={!canWrite} onClick={() => setCanWrite(false)}>
          No hay cómo escribirle
        </button>
      </fieldset>
      <div className="dri-when">
        <span>Última visita · 12 abr 2026</span>
        <span aria-hidden="true">→</span>
        <span>Más de 6 meses sin venir</span>
      </div>
      <div aria-live="polite">
        {canWrite ? (
          <div className="dri-msg">
            <span className="dri-meta">ARGOS · WHATSAPP · 10:00</span>
            <span>Hola, Marta. Hace más de seis meses que no te vemos en Clínica Sonrisa Norte. ¿Te buscamos un horario para tu control?</span>
            <span className="dri-btn">Sí, otro horario</span>
          </div>
        ) : (
          <div className="dri-msg dri-task">
            <span className="dri-box" aria-hidden="true" />
            <span className="dri-task-text">
              <b>Tarea de llamada · Marta León</b>
              <span>Para recepción · invitarla a volver · no hay WhatsApp ni correo con que escribirle</span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
