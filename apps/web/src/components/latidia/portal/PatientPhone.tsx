// Lo que ve Rosa en su teléfono al abrir Su enlace (lienzo de latidIA, tablero «Enlace»): su próxima
// cita con «Cambiar», «Cancelar» y «Cómo llegar», sus datos y su salud, sus papeles y sus mensajes.
// Las tarjetas aparecen una a una y después «Cambiar» invita a tocarlo; todo se puede tocar.
// Lo que dice es lo que hace la página real (`/reserva`): «Tus papeles» son la receta y el
// comprobante de los últimos 30 días, y «Tus mensajes» elige qué mensajes recibe.
import { useEffect, useState } from "react"
import "./patient-phone.css"

type View = "home" | "change" | "cancel" | "canceled" | "map"

const SLOTS = [
  { label: "Lunes 26 · 11:00 · Sala 1", when: "Lunes 26 de octubre · 11:00", short: "lunes 26 a las 11:00", room: "Sala 1" },
  { label: "Martes 27 · 10:30 · Sala 2", when: "Martes 27 de octubre · 10:30", short: "martes 27 a las 10:30", room: "Sala 2" },
  { label: "Miércoles 28 · 16:00 · Sala 1", when: "Miércoles 28 de octubre · 16:00", short: "miércoles 28 a las 16:00", room: "Sala 1" },
]
const BASE = { when: "Lunes 26 de octubre · 09:00", short: "lunes 26 a las 09:00", room: "Sala 1" }

/** Los papeles de la consulta del 24 de octubre: se descargan 30 días, hasta el 23 de noviembre. */
const PAPERS = [
  { id: "receta", name: "Receta N.º 1", sub: "24 de octubre · disponible hasta el 23 de noviembre" },
  { id: "comprobante", name: "Comprobante N.º 000001", sub: "24 de octubre · disponible hasta el 23 de noviembre" },
]

/** Los tres interruptores de «Tus mensajes»; las novedades solo con su sí. */
const MESSAGES = [
  { id: "recordatorio", title: "Recordatorios de tus citas" },
  { id: "seguimiento", title: "Controles y seguimiento" },
  { id: "novedades", title: "Novedades y promociones" },
] as const
type MessageId = (typeof MESSAGES)[number]["id"]

const LAST = 5

export default function PatientPhone() {
  // Se arma en el servidor con todo a la vista: sin JavaScript o con movimiento reducido, se lee entero.
  const [step, setStep] = useState(4)
  const [view, setView] = useState<View>("home")
  const [slot, setSlot] = useState(-1)
  const [changedTo, setChangedTo] = useState(-1)
  const [healthSent, setHealthSent] = useState(false)
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
    }, 550)
    return () => window.clearInterval(timer)
  }, [])

  const cur = changedTo >= 0 ? SLOTS[changedTo] : BASE
  const card = (n: number) => `pp-card${step >= n ? "" : " pp-hidden"}`
  const goChange = () => {
    setView("change")
    setSlot(-1)
    setStep(LAST)
  }

  return (
    <div className="pp">
      <div className="pp-screen">
        <div className="pp-status">
          <span>9:41</span>
          <span className="pp-notch" aria-hidden="true" />
          <span>latidia72.com</span>
        </div>
        <div className="pp-body">
          <span className="pp-hello">
            <span>CONSULTORIO SAN MARTÍN</span>
            <b>Hola, Rosa</b>
          </span>

          <section className={card(1)} aria-label="Tu próxima cita">
            <span className="pp-h">{view === "canceled" ? "TU CITA" : "TU PRÓXIMA CITA"}</span>
            {view === "home" && (
              <>
                <b className="pp-when">{cur.when}</b>
                <span className="pp-what">Consulta por dolor de cabeza</span>
                <span className="pp-sub">Dra. Elena Vela · {cur.room}</span>
                {changedTo >= 0 && <span className="pp-ok">Cita cambiada · el horario de antes quedó libre</span>}
                <div className="pp-row">
                  <button type="button" className={`pp-btn main${step >= LAST && changedTo < 0 ? " pp-pulse" : ""}`} onClick={goChange}>
                    Cambiar
                  </button>
                  <button type="button" className="pp-btn" onClick={() => setView("cancel")}>
                    Cancelar
                  </button>
                  <button type="button" className="pp-btn" onClick={() => setView("map")}>
                    Cómo llegar
                  </button>
                </div>
              </>
            )}
            {view === "change" && (
              <>
                <fieldset className="pp-slots">
                  <legend className="pp-what">Elige otro horario con la Dra. Vela:</legend>
                  {SLOTS.map((s, i) => (
                    <button key={s.label} type="button" className="pp-slot" aria-pressed={slot === i} onClick={() => setSlot(i)}>
                      {s.label}
                    </button>
                  ))}
                </fieldset>
                <div className="pp-row">
                  <button
                    type="button"
                    className="pp-btn main"
                    disabled={slot < 0}
                    onClick={() => {
                      setChangedTo(slot)
                      setView("home")
                    }}
                  >
                    Confirmar el cambio
                  </button>
                  <button type="button" className="pp-btn" onClick={() => setView("home")}>
                    Volver
                  </button>
                </div>
              </>
            )}
            {view === "cancel" && (
              <>
                <b className="pp-q">¿Cancelar tu cita del {cur.short}?</b>
                <span className="pp-sub">El horario queda libre para otra persona.</span>
                <div className="pp-row">
                  <button
                    type="button"
                    className="pp-btn danger"
                    onClick={() => {
                      setView("canceled")
                      setChangedTo(-1)
                    }}
                  >
                    Sí, cancelar
                  </button>
                  <button type="button" className="pp-btn" onClick={() => setView("home")}>
                    No, mantenerla
                  </button>
                </div>
              </>
            )}
            {view === "canceled" && (
              <>
                <b className="pp-q">Cancelaste tu cita.</b>
                <span className="pp-sub">Cuando quieras, eliges otra fecha aquí mismo.</span>
                <button type="button" className="pp-btn main" onClick={goChange}>
                  Elegir otra fecha
                </button>
              </>
            )}
            {view === "map" && (
              <>
                <b className="pp-q">Av. Perú 1820</b>
                <span className="pp-sub">San Martín de Porres, Lima · Consultorio San Martín</span>
                <div className="pp-map" aria-hidden="true">
                  <span />
                </div>
                <div className="pp-row">
                  {/* En la app abre Google Maps; aquí es solo el dibujo del botón. */}
                  <span className="pp-btn main pp-fake">Abrir en el mapa</span>
                  <button type="button" className="pp-btn" onClick={() => setView("home")}>
                    Volver
                  </button>
                </div>
              </>
            )}
          </section>

          <section className={card(2)} aria-label="Tus datos y tu salud">
            <span className="pp-h">TUS DATOS Y TU SALUD</span>
            <span className="pp-line">
              <span>Tus datos</span>
              <span className="pp-done">Completos ✓</span>
            </span>
            <span className="pp-line sep">
              <span>Alergias y antecedentes</span>
              {healthSent ? (
                <span className="pp-sent">Enviado · lo confirma tu médico</span>
              ) : (
                <button type="button" className="pp-chip-btn" onClick={() => setHealthSent(true)}>
                  Completar
                </button>
              )}
            </span>
          </section>

          <section className={card(3)} aria-label="Tus papeles">
            <span className="pp-h">TUS PAPELES</span>
            {PAPERS.map((p) => (
              <span key={p.id} className="pp-paper">
                <span className="pp-paper-name">
                  <b>{p.name}</b>
                  <span>{p.sub}</span>
                </span>
                <button
                  type="button"
                  className={`pp-chip-btn${got[p.id] ? " ok" : ""}`}
                  onClick={() => setGot((g) => ({ ...g, [p.id]: true }))}
                >
                  {got[p.id] ? "Descargado ✓" : "Descargar"}
                </button>
              </span>
            ))}
            <span className="pp-sub small">Cada papel queda aquí 30 días. Después, pídeselo al consultorio.</span>
          </section>

          <section className={card(4)} aria-label="Tus mensajes">
            <span className="pp-h">TUS MENSAJES</span>
            <span className="pp-sub small">Elige qué mensajes quieres recibir del consultorio.</span>
            {MESSAGES.map((m) => (
              <span key={m.id} className="pp-line sep">
                <span>{m.title}</span>
                <button
                  type="button"
                  className="pp-switch"
                  aria-pressed={messages[m.id]}
                  onClick={() => setMessages((x) => ({ ...x, [m.id]: !x[m.id] }))}
                >
                  <span className="sr-only">{m.title}: </span>
                  {messages[m.id] ? "Sí" : "No"}
                  <i aria-hidden="true" />
                </button>
              </span>
            ))}
            <span className="pp-sub small">Los avisos de tu cita y tus papeles te llegan siempre.</span>
          </section>
        </div>
      </div>
    </div>
  )
}
