// Omnicanal en el inicio de latidIA (lienzo «Inicio», sección 2): Rosa escribe por WhatsApp de
// noche y por correo a la mañana, y las dos conversaciones caen en su única ficha. Aparecen una a
// una y vuelven a empezar; sin movimiento se ve todo.
import { useLoop } from "./loop"
import "./omni-demo.css"

export default function OmniDemo() {
  const { step } = useLoop({ len: 6, hold: 3, ms: 1500 })
  const on = (from: number) => (step >= from ? " on" : "")
  return (
    <div className="od">
      <div className="od-msgs">
        <div className={`od-msg${on(1)}`}>
          <span className="od-ch wa">
            <i aria-hidden="true"></i>WhatsApp · miércoles 23:40
          </span>
          <span className="od-text">Buenas noches, tengo fiebre y me duele mucho la garganta. ¿Me pueden ver mañana temprano?</span>
          <span className="od-reply">
            <b>Sofi:</b> Mañana jueves a las 09:00 con la Dra. Vela. ¿Te la reservo?
          </span>
        </div>
        <div className={`od-msg${on(3)}`}>
          <span className="od-ch mail">
            <i aria-hidden="true"></i>Correo · jueves 07:15
          </span>
          <span className="od-text">
            <b>Mi cita de hoy.</b> ¿Puedo pagar con tarjeta en el consultorio?
          </span>
          <span className="od-reply">
            <b>Sofi:</b> Sí, Rosa. Te esperamos a las 09:00 en la Sala 1.
          </span>
        </div>
      </div>

      <div className="od-wires" aria-hidden="true">
        <div className="od-wire">
          <i className="od-dot wa"></i>
        </div>
        <div className="od-wire">
          <i className="od-dot mail"></i>
        </div>
      </div>

      <div className="od-card">
        <div className="od-person">
          <span className="od-avatar" aria-hidden="true">
            RP
          </span>
          <span className="od-name">
            <b>Rosa Paredes Luna</b>
            <span>HC-000001 · 46 años · una sola historia clínica</span>
          </span>
        </div>
        <div className="od-tabs" aria-hidden="true">
          <span>Resumen</span>
          <span className="on">Conversaciones</span>
          <span>Citas</span>
          <span>Clínica</span>
          <span>Cobros</span>
        </div>
        <ul className="od-feed">
          <li className={`od-item${on(2)}`}>
            <span className="od-ico wa" aria-hidden="true">
              WA
            </span>
            <span className="od-item-text">
              <b>WhatsApp</b> · pidió cita por fiebre
              <span>Sofi la agendó · jueves 09:00 · Sala 1</span>
            </span>
            <span className="od-time">23:40</span>
          </li>
          <li className={`od-item${on(4)}`}>
            <span className="od-ico mail" aria-hidden="true">
              @
            </span>
            <span className="od-item-text">
              <b>Correo</b> · preguntó por el pago
              <span>Sofi respondió · con el contexto de su cita</span>
            </span>
            <span className="od-time">07:15</span>
          </li>
        </ul>
        <div className={`od-note${on(5)}`}>Una persona, todos sus canales, una historia clínica.</div>
      </div>
    </div>
  )
}
