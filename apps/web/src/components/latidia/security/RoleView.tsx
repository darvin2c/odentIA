// «Entra como…» (lienzo de latidIA, tablero «Seguridad», portada): la misma paciente, Rosa Paredes Luna,
// vista por la Dra. Vela, Recepción, Caja y Sofi. Cada fila dice qué ve ese rol y qué no, como lo
// decide la matriz de permisos del sistema (packages/auth). Los roles pasan solos cada 3,6 s hasta que la
// persona toca uno; con movimiento reducido se queda en el del médico. Datos de ejemplo.
import { useEffect, useRef, useState } from "react"
import "./role-view.css"

type Role = "medico" | "recepcion" | "caja" | "sofi"

const ROLES: [Role, string][] = [
  ["medico", "Dra. Elena Vela · Médico"],
  ["recepcion", "Recepción"],
  ["caja", "Caja"],
  ["sofi", "Sofi · agente"],
]

const NEXT_MS = 3600

// Lo que ve cada rol de la misma paciente: [lo ve, lo que dice].
const SECTIONS: { title: string; see: Record<Role, [boolean, string]> }[] = [
  {
    title: "Datos y contacto",
    see: {
      medico: [true, "DNI 40112233 · WhatsApp"],
      recepcion: [true, "DNI 40112233 · WhatsApp"],
      caja: [true, "Nombre y documento, para el ticket"],
      sofi: [true, "Su nombre y su conversación"],
    },
  },
  {
    title: "Citas",
    see: {
      medico: [true, "Hoy 09:00 · Sala 1"],
      recepcion: [true, "Hoy 09:00 · Sala 1 · puede moverla"],
      caja: [false, "No ve la agenda"],
      sofi: [true, "Agenda o mueve con el sí de Rosa"],
    },
  },
  {
    title: "Historia clínica",
    see: {
      medico: [true, "J03.9 Amigdalitis aguda · T 38,5 °C"],
      recepcion: [false, "No la ve"],
      caja: [false, "No la ve"],
      sofi: [false, "No la ve"],
    },
  },
  {
    title: "Receta y descanso médico",
    see: {
      medico: [true, "Descanso médico · 3 días"],
      recepcion: [false, "No los ve; Rosa los descarga de su enlace"],
      caja: [false, "No los ve"],
      sofi: [false, "No los ve"],
    },
  },
  {
    title: "Cobros",
    see: {
      medico: [false, "No lleva la caja"],
      recepcion: [false, "No ve la caja"],
      caja: [true, "Consulta S/ 80 · Efectivo · Pagado"],
      sofi: [false, "No cobra: le pasa a caja las preguntas de pago"],
    },
  },
]

const NOTES: Record<Role, string> = {
  medico: "Tú atiendes con todo lo clínico. Abrir la historia deja su línea en el registro de consultas.",
  recepcion: "Recepción coordina: agenda, conversaciones y contacto. La historia no se le muestra ni el servidor se la entrega.",
  caja: "Caja cobra con el tarifario y ve lo que falta pagar. Sin historia clínica ni agenda.",
  sofi: "Sofi responde a Rosa en su canal, agenda con su sí y, si nota una señal de alarma, avisa al equipo. La historia clínica no la ve.",
}

export default function RoleView() {
  // Se arma en el servidor con la vista del médico: sin JavaScript se lee igual.
  const [role, setRole] = useState<Role>("medico")
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const order = ROLES.map(([key]) => key)
    setRole("recepcion")
    timer.current = window.setInterval(() => setRole((r) => order[(order.indexOf(r) + 1) % order.length]), NEXT_MS)
    return () => window.clearInterval(timer.current)
  }, [])

  const pick = (key: Role) => {
    window.clearInterval(timer.current)
    setRole(key)
  }

  return (
    <div className="lt-roles">
      <fieldset className="lt-roles-roles">
        <legend>Entra como…</legend>
        <div>
          {ROLES.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={key === role} onClick={() => pick(key)}>
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="lt-roles-who">
        <span aria-hidden="true">RP</span>
        <span>
          <b>Rosa Paredes Luna</b>
          <span className="lt-roles-age">46 años · Paciente</span>
        </span>
      </div>
      <ul className="lt-roles-rows">
        {SECTIONS.map((s) => {
          const [ok, text] = s.see[role]
          return (
            <li key={s.title} data-ok={ok || undefined}>
              <span className="lt-roles-icon" aria-hidden="true">
                {ok ? "✓" : "—"}
              </span>
              <span className="lt-roles-text">
                <b>{s.title}</b>
                <span className="lt-roles-see">
                  <span className="sr-only">{ok ? "Lo ve: " : "No lo ve: "}</span>
                  {text}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="lt-roles-note">
        {NOTES[role]}
      </p>
      <span className="lt-roles-demo">Demostración con datos de ejemplo. Toca un rol.</span>
    </div>
  )
}
