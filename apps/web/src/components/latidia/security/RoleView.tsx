// «Entra como…» (lienzo de latidIA, tablero «Seguridad», portada): la misma persona vista por cada rol.
// Cada fila dice qué ve ese rol y qué no, como lo decide la matriz de permisos del sistema
// (packages/auth/src/permissions.ts). Los roles pasan solos cada 3,6 s hasta que la persona toca uno; con
// movimiento reducido se queda en el primero. Datos de ejemplo.
// Un solo componente para las dos webs (`variant`): latidIA, con Rosa Paredes vista por la Dra. Vela,
// Recepción, Caja y Sofi; odentIA, con Carlos Medina vista por la Dra. Paredes (odontólogo), Recepción,
// Caja, Administración y Sofi. En odentIA, Recepción ve solo las alergias de la historia (`clinical.alerts`)
// y sube la tomografía que trae el paciente sin abrirla (`clinical.receive`): se marca «en parte».
import { useEffect, useRef, useState } from "react"
import "./role-view.css"

type Variant = "medical" | "dental"

/** Lo ve (true), no lo ve (false) o lo ve en parte («some»), con lo que dice. */
type See = [boolean | "some", string]

interface RoleSet {
  roles: [string, string][]
  who: { initials: string; name: string; sub: string }
  sections: { title: string; see: Record<string, See> }[]
  notes: Record<string, string>
}

const MEDICAL: RoleSet = {
  roles: [
    ["medico", "Dra. Elena Vela · Médico"],
    ["recepcion", "Recepción"],
    ["caja", "Caja"],
    ["sofi", "Sofi · agente"],
  ],
  who: { initials: "RP", name: "Rosa Paredes Luna", sub: "46 años · Paciente" },
  sections: [
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
        recepcion: [false, "No los ve"],
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
  ],
  notes: {
    medico: "Tú atiendes con todo lo clínico. Abrir la historia deja su línea en el registro de consultas.",
    recepcion: "Recepción coordina: agenda, conversaciones y contacto. La historia no se le muestra ni el servidor se la entrega.",
    caja: "Caja cobra con el tarifario y ve lo que falta pagar. Sin historia clínica ni agenda.",
    sofi: "Sofi responde a Rosa en su canal, agenda con su sí y, si nota una señal de alarma, avisa al equipo. La historia clínica no la ve.",
  },
}

const DENTAL: RoleSet = {
  roles: [
    ["odontologo", "Dra. Paredes · Odontólogo"],
    ["recepcion", "Recepción"],
    ["caja", "Caja"],
    ["admin", "Administración"],
    ["sofi", "Sofi · agente"],
  ],
  who: { initials: "CM", name: "Carlos Medina", sub: "Paciente" },
  sections: [
    {
      title: "Datos y contacto",
      see: {
        odontologo: [true, "DNI 41223344 · WhatsApp"],
        recepcion: [true, "DNI 41223344 · WhatsApp"],
        caja: [true, "Nombre y documento, para el cobro"],
        admin: [true, "DNI 41223344 · WhatsApp"],
        sofi: [true, "Su nombre y su conversación"],
      },
    },
    {
      title: "Citas",
      see: {
        odontologo: [true, "Hoy 09:40 · Unidad dental 1"],
        recepcion: [true, "Hoy 09:40 · Unidad dental 1 · puede moverla"],
        caja: [false, "No ve la agenda"],
        admin: [true, "Hoy 09:40 · Unidad dental 1"],
        sofi: [true, "Agenda o mueve con el sí de Carlos"],
      },
    },
    {
      title: "Historia clínica y odontograma",
      see: {
        odontologo: [true, "Caries en la 36 · K02.1 · resina"],
        recepcion: ["some", "Solo sus alergias activas"],
        caja: [false, "No la ve"],
        admin: [true, "Caries en la 36 · K02.1 · resina"],
        sofi: [false, "No la ve"],
      },
    },
    {
      title: "Tomografías",
      see: {
        odontologo: [true, "La abre en el visor de la ficha"],
        recepcion: ["some", "Sube la que trae el paciente; no la abre ni la descarga"],
        caja: [false, "No la ve"],
        admin: [true, "La abre en el visor de la ficha"],
        sofi: [false, "No la ve"],
      },
    },
    {
      title: "Presupuesto",
      see: {
        odontologo: [true, "Resina S/ 300 o corona S/ 1.070 · lo arma y ajusta los precios"],
        recepcion: [true, "Lo ve como lo recibe Carlos, lo envía y anota su respuesta; no cambia precios"],
        caja: [true, "Lo ve y anota su respuesta; no cambia precios"],
        admin: [true, "Lo arma, lo ajusta y lo envía"],
        sofi: [true, "Lo reenvía y anota su respuesta con su sí"],
      },
    },
    {
      title: "Cobros",
      see: {
        odontologo: [false, "No lleva la caja"],
        recepcion: [false, "No ve la caja"],
        caja: [true, "Resina · S/ 300 · Efectivo · Pagado"],
        admin: [true, "Resina · S/ 300 · Efectivo · Pagado"],
        sofi: ["some", "Ve su saldo; no cobra y le pasa a caja las preguntas de pago"],
      },
    },
  ],
  notes: {
    odontologo: "Tú atiendes con la historia y el odontograma, y ves los presupuestos de lo que indicaste. Abrir la historia deja su línea en el registro de consultas.",
    recepcion: "Recepción coordina: agenda, conversaciones, contacto y presupuestos. La historia no se le muestra ni el servidor se la entrega; solo ve las alergias, para avisar.",
    caja: "Caja cobra con el tarifario y ve lo que falta pagar. Sin historia clínica ni agenda.",
    admin: "Administración puede todo en la clínica, la caja incluida. Lo que hace cada quien, persona o agente, queda registrado.",
    sofi: "Sofi responde a Carlos en su canal, agenda con su sí y le reenvía su presupuesto. La historia clínica no la ve; lo que no le toca, se lo pasa a tu equipo.",
  },
}

const SETS: Record<Variant, RoleSet> = { medical: MEDICAL, dental: DENTAL }

const NEXT_MS = 3600

export default function RoleView({ variant = "medical" }: { variant?: Variant }) {
  const set = SETS[variant]
  // Se arma en el servidor con la vista del primer rol: sin JavaScript se lee igual.
  const [role, setRole] = useState<string>(set.roles[0][0])
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const order = set.roles.map(([key]) => key)
    setRole(order[1])
    timer.current = window.setInterval(() => setRole((r) => order[(order.indexOf(r) + 1) % order.length]), NEXT_MS)
    return () => window.clearInterval(timer.current)
  }, [set])

  const pick = (key: string) => {
    window.clearInterval(timer.current)
    setRole(key)
  }

  return (
    <div className="lt-roles">
      <fieldset className="lt-roles-roles">
        <legend>Entra como…</legend>
        <div>
          {set.roles.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={key === role} onClick={() => pick(key)}>
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="lt-roles-who">
        <span aria-hidden="true">{set.who.initials}</span>
        <span>
          <b>{set.who.name}</b>
          <span className="lt-roles-age">{set.who.sub}</span>
        </span>
      </div>
      <ul className="lt-roles-rows">
        {set.sections.map((s) => {
          const [ok, text] = s.see[role]
          return (
            <li key={s.title} data-ok={ok === "some" ? "some" : ok || undefined}>
              <span className="lt-roles-icon" aria-hidden="true">
                {ok === "some" ? "◐" : ok ? "✓" : "—"}
              </span>
              <span className="lt-roles-text">
                <b>{s.title}</b>
                <span className="lt-roles-see">
                  <span className="sr-only">{ok === "some" ? "Lo ve en parte: " : ok ? "Lo ve: " : "No lo ve: "}</span>
                  {text}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="lt-roles-note">{set.notes[role]}</p>
      <span className="lt-roles-demo">Demostración con datos de ejemplo. Toca un rol.</span>
    </div>
  )
}
