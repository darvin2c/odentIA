// Lo que ve Andrea en su teléfono al abrir Su enlace (portada de /portal-del-paciente): su cita con
// «Confirmar», «Cambiar» y «Cancelar», su presupuesto con «Ver y responder», sus papeles y sus mensajes. Las tarjetas aparecen una a una; todo se puede tocar.
// Las palabras son las de la página real (`/reserva`): «Tu cita», «Por confirmar», «Ver y responder»,
// «Tus papeles» (la receta y el comprobante de los últimos 30 días) y «Tus mensajes».
import { useEffect, useState } from "react"
import "./patient-phone.css"

type View = "home" | "change" | "cancel" | "canceled"

const SLOTS = [
  { label: "Jueves 29 · 16:30 · Dr. Ríos", when: "Jueves 29 de octubre · 16:30", who: "Dr. Ríos", short: "jueves 29 de octubre · 16:30" },
  { label: "Viernes 30 · 09:00 · Dra. Paredes", when: "Viernes 30 de octubre · 09:00", who: "Dra. Paredes", short: "viernes 30 de octubre · 09:00" },
  { label: "Sábado 31 · 10:00 · Dra. Paredes", when: "Sábado 31 de octubre · 10:00", who: "Dra. Paredes", short: "sábado 31 de octubre · 10:00" },
]
const BASE = { when: "Jueves 29 de octubre · 10:30", who: "Dra. Paredes", short: "jueves 29 de octubre · 10:30" }

/** Los papeles de la atención del 24 de octubre: se descargan 30 días, hasta el 23 de noviembre. */
const PAPERS = [
  { id: "comprobante", name: "Comprobante N.º 000001", sub: "24 de octubre · disponible hasta el 23 de noviembre" },
  { id: "receta", name: "Receta N.º 1", sub: "24 de octubre · disponible hasta el 23 de noviembre" },
]

/** Los tres interruptores de «Tus mensajes»; las novedades solo con su sí. */
const MESSAGES = [
  { id: "recordatorio", title: "Recordatorios de tus citas", detail: "Te avisamos un día antes y unas horas antes." },
  { id: "seguimiento", title: "Controles y seguimiento", detail: "Cuándo te toca tu control, o si faltaste a una cita." },
  { id: "novedades", title: "Novedades y promociones", detail: "Campañas y ofertas de la clínica." },
] as const
type MessageId = (typeof MESSAGES)[number]["id"]

const LAST = 4

export default function PatientPhone() {
  // Se arma en el servidor con todo a la vista: sin JavaScript o con movimiento reducido, se lee entero.
  const [step, setStep] = useState(4)
  const [view, setView] = useState<View>("home")
  const [slot, setSlot] = useState(-1)
  const [changedTo, setChangedTo] = useState(-1)
  const [confirmed, setConfirmed] = useState(false)
  const [budget, setBudget] = useState<"pending" | "open" | "done">("pending")
  const [got, setGot] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<Record<MessageId, boolean>>({ recordatorio: true, seguimiento: true, novedades: false })

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    setStep(0)
    const timer = window.setInterval(() => {
      setStep((s) => {
        if (s >= LAST - 1) window.clearInterval(timer)
        return Math.min(s + 1, LAST)
      })
    }, 520)
    return () => window.clearInterval(timer)
  }, [])

  const cur = changedTo >= 0 ? SLOTS[changedTo] : BASE
  const card = (n: number) => `dpp-card${step >= n ? "" : " dpp-hidden"}`
  const goChange = () => {
    setView("change")
    setSlot(-1)
    setStep(LAST)
  }

  return (
    <div className="dpp">
      <div className="dpp-screen">
        <div className="dpp-status">
          <span>9:41</span>
          <span className="dpp-notch" aria-hidden="true" />
          <span>sonrisanorte.pe</span>
        </div>
        <div className="dpp-body">
          <span className="dpp-hello">
            <span className="dpp-org">Clínica Sonrisa Norte</span>
            <b>Hola, Andrea</b>
          </span>

          <section className={card(1)} aria-label="Tu cita">
            <span className="dpp-row-h">
              <span className="dpp-h">Tu cita</span>
              {view !== "canceled" && <span className={`dpp-badge${confirmed ? " ok" : ""}`}>{confirmed ? "Confirmada" : "Por confirmar"}</span>}
            </span>
            {view === "home" && (
              <>
                <b className="dpp-when">{cur.when}</b>
                <span className="dpp-what">Obturación con resina · Sede Los Olivos · {cur.who}</span>
                <span className="dpp-sub">Av. Alfredo Mendiola 3500, Los Olivos</span>
                {changedTo >= 0 && <span className="dpp-ok">Cita cambiada · el horario de antes quedó libre</span>}
                <div className="dpp-row">
                  {!confirmed && (
                    <button type="button" className="dpp-btn main" onClick={() => setConfirmed(true)}>
                      Confirmar
                    </button>
                  )}
                  <button type="button" className={`dpp-btn${confirmed && changedTo < 0 && step >= LAST ? " dpp-pulse" : ""}`} onClick={goChange}>
                    Cambiar
                  </button>
                  <button type="button" className="dpp-btn" onClick={() => setView("cancel")}>
                    Cancelar
                  </button>
                </div>
              </>
            )}
            {view === "change" && (
              <>
                <fieldset className="dpp-slots">
                  <legend className="dpp-what">Elige otro horario:</legend>
                  {SLOTS.map((s, i) => (
                    <button key={s.label} type="button" className="dpp-slot" aria-pressed={slot === i} onClick={() => setSlot(i)}>
                      {s.label}
                    </button>
                  ))}
                </fieldset>
                <div className="dpp-row">
                  <button
                    type="button"
                    className="dpp-btn main"
                    disabled={slot < 0}
                    onClick={() => {
                      setChangedTo(slot)
                      setView("home")
                    }}
                  >
                    Confirmar el cambio
                  </button>
                  <button type="button" className="dpp-btn" onClick={() => setView("home")}>
                    Conservar mi cita
                  </button>
                </div>
              </>
            )}
            {view === "cancel" && (
              <>
                <b className="dpp-q">¿Cancelar tu cita?</b>
                <span className="dpp-sub">{capital(cur.short)}. El horario queda libre para otra persona.</span>
                <div className="dpp-row">
                  <button
                    type="button"
                    className="dpp-btn danger"
                    onClick={() => {
                      setView("canceled")
                      setChangedTo(-1)
                    }}
                  >
                    Sí, cancelar
                  </button>
                  <button type="button" className="dpp-btn" onClick={() => setView("home")}>
                    No, conservarla
                  </button>
                </div>
              </>
            )}
            {view === "canceled" && (
              <>
                <b className="dpp-q">Tu cita quedó cancelada</b>
                <span className="dpp-sub">Cuando quieras, eliges otra fecha aquí mismo.</span>
                <button type="button" className="dpp-btn main" onClick={goChange}>
                  Elegir otra fecha
                </button>
              </>
            )}
          </section>

          <section className={card(2)} aria-label="Tu presupuesto">
            <span className="dpp-row-h">
              <span className="dpp-h">Tu presupuesto</span>
              <span className={`dpp-badge${budget === "done" ? " ok" : ""}`}>{budget === "done" ? "Respondido" : "Por responder"}</span>
            </span>
            {budget === "pending" && (
              <>
                <span className="dpp-what">Pieza 36: resina o corona</span>
                <button type="button" className="dpp-btn dpp-wide" onClick={() => setBudget("open")}>
                  Ver y responder
                </button>
              </>
            )}
            {budget === "open" && (
              <>
                <span className="dpp-opt dpp-pick">
                  <span className="dpp-opt-row">
                    <b>Opción A · Resina</b>
                    <b>S/ 300</b>
                  </span>
                  <span className="dpp-sub">Recomendada por la Dra. Paredes</span>
                </span>
                <span className="dpp-opt">
                  <span className="dpp-opt-row">
                    <b>Opción B · Corona</b>
                    <b>S/ 1.070</b>
                  </span>
                </span>
                <span className="dpp-sub">Puedes aceptar solo una parte.</span>
                <button type="button" className="dpp-btn main dpp-wide" onClick={() => setBudget("done")}>
                  Aceptar la opción A
                </button>
              </>
            )}
            {budget === "done" && (
              <>
                <b className="dpp-q">Gracias, recibimos tu respuesta</b>
                <span className="dpp-sub">Aceptaste la opción A. Si cambias de opinión, escríbenos por el chat.</span>
              </>
            )}
          </section>

          <section className={card(3)} aria-label="Tus papeles">
            <span className="dpp-h">Tus papeles</span>
            {PAPERS.map((p) => (
              <span key={p.id} className="dpp-paper">
                <span className="dpp-paper-name">
                  <b>{p.name}</b>
                  <span>{p.sub}</span>
                </span>
                <button type="button" className={`dpp-chip-btn${got[p.id] ? " ok" : ""}`} onClick={() => setGot((g) => ({ ...g, [p.id]: true }))}>
                  {got[p.id] ? "Descargado ✓" : "Descargar"}
                </button>
              </span>
            ))}
            <span className="dpp-sub small">Cada papel queda aquí 30 días. Después, pídeselo a la clínica.</span>
          </section>

          <section className={card(4)} aria-label="Tus mensajes">
            <span className="dpp-h">Tus mensajes</span>
            <span className="dpp-sub small">Elige qué mensajes quieres recibir de la clínica.</span>
            {MESSAGES.map((m) => (
              <span key={m.id} className="dpp-line">
                <span className="dpp-line-t">
                  <b>{m.title}</b>
                  <span>{m.detail}</span>
                </span>
                <button
                  type="button"
                  className="dpp-switch"
                  aria-pressed={messages[m.id]}
                  onClick={() => setMessages((x) => ({ ...x, [m.id]: !x[m.id] }))}
                >
                  <span className="sr-only">{m.title}: </span>
                  {messages[m.id] ? "Encendido" : "Apagado"}
                  <i aria-hidden="true" />
                </button>
              </span>
            ))}
            <span className="dpp-line">
              <span className="dpp-line-t">
                <b>Avisos de tus citas y papeles</b>
              </span>
              <span className="dpp-always">Siempre</span>
            </span>
          </section>
        </div>
      </div>
    </div>
  )
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
