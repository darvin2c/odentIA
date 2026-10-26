// «Invitar a volver» de Argos (lienzo de latidIA, tablero «Agenda»): Rosa lleva 12 meses sin venir.
// Si tiene WhatsApp, Argos decide y Sofi le escribe dentro del horario de recontacto; si no hay cómo escribirle,
// deja a recepción una tarea de llamada. El interruptor cambia entre los dos casos.
import { useState } from "react"
import "./return-invite.css"

export default function ReturnInvite() {
  const [canWrite, setCanWrite] = useState(true)
  return (
    <div className="ri">
      <fieldset className="ri-opts">
        <legend className="sr-only">Cómo se le puede escribir</legend>
        <button type="button" aria-pressed={canWrite} onClick={() => setCanWrite(true)}>
          Tiene WhatsApp
        </button>
        <button type="button" aria-pressed={!canWrite} onClick={() => setCanWrite(false)}>
          No hay cómo escribirle
        </button>
      </fieldset>
      <div className="ri-when">
        <span>Última consulta · 24 oct 2025</span>
        <span aria-hidden="true">→</span>
        <span>12 meses sin venir</span>
      </div>
      <div aria-live="polite">
        {canWrite ? (
          <div className="ri-msg">
            <span className="ri-meta">SOFI · WHATSAPP · 10:00</span>
            <span>
              Hola, Rosa. Hace más de un año que no te vemos en Consultorio San Martín. ¿Te buscamos un horario para tu control?
            </span>
          </div>
        ) : (
          <div className="ri-msg ri-task">
            <span className="ri-box" aria-hidden="true" />
            <span className="ri-task-text">
              <b>Llamar a Rosa para invitarla a volver</b>
              <span>Tarea para recepción · no tiene WhatsApp ni correo registrados</span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
