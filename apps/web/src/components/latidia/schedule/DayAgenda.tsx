// La agenda del día del Consultorio San Martín (lienzo de latidIA, tablero «Agenda»): Sala 1 y
// Sala 2 de 08:30 a 11:00 con la línea de «ahora» que avanza. Rosa llega, espera, la atiende la
// Dra. Vela y queda «Atendida»; Sofi agenda a Julia para mañana y llega Luis. Los momentos de la
// cita se dicen con las palabras de la app («Llegó · espera 6 min», «En atención · con…»), nunca
// solo con color. Con movimiento reducido se ve el estado final.
import { useEffect, useState } from "react"
import "./day-agenda.css"

type Status = "c" | "w6" | "w2" | "in" | "done" | "new"

/** Cada paso de la mañana: la hora de la línea (en minutos) y el momento de Rosa y de Luis. */
const STEPS: { now: number; rosa: Status; luis: Status; toast?: boolean }[] = [
  { now: 530, rosa: "c", luis: "c" },
  { now: 546, rosa: "w6", luis: "c" },
  { now: 552, rosa: "in", luis: "c" },
  { now: 574, rosa: "done", luis: "c" },
  { now: 581, rosa: "done", luis: "c", toast: true },
  { now: 602, rosa: "done", luis: "w2", toast: true },
  { now: 609, rosa: "done", luis: "in", toast: true },
]
const LAST = STEPS.length - 1

const LABELS: Record<Status, string> = {
  c: "Confirmada",
  w6: "Llegó · espera 6 min",
  w2: "Llegó · espera 2 min",
  in: "En atención · con la Dra. Vela",
  done: "Atendida",
  new: "Nueva · agendada por Sofi",
}

/** La rejilla empieza a las 08:30 (510 min) y cada media hora mide 72 px. */
const START = 510
const ROW = 72
const HOURS = ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]
const top = (minutes: number) => ((minutes - START) / 30) * ROW

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

type Block = { start: number; name: string; time: string; reason: string; status: Status; fresh?: boolean }

function AppointmentBlock({ block }: { block: Block }) {
  return (
    <div className={`da-blk da-${block.status}${block.fresh ? " da-pop" : ""}`} style={{ top: top(block.start) + 3 }}>
      <span className="da-blk-top">
        <b>{block.name}</b>
        <span className="da-time">{block.time}</span>
      </span>
      <span className="da-reason">{block.reason}</span>
      <span className={`da-chip da-chip-${block.status}`}>{LABELS[block.status]}</span>
    </div>
  )
}

export default function DayAgenda() {
  // Se arma en el servidor con la mañana completa: sin JavaScript o con movimiento reducido, se lee entera.
  const [step, setStep] = useState(LAST)
  const [day, setDay] = useState<"hoy" | "manana">("hoy")

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    setStep(0)
    const timer = window.setInterval(() => {
      setStep((s) => {
        if (s >= LAST - 1) window.clearInterval(timer)
        return Math.min(s + 1, LAST)
      })
    }, 1700)
    return () => window.clearInterval(timer)
  }, [])

  const s = STEPS[step]
  const today = day === "hoy"
  const room1: Block[] = today
    ? [{ start: 540, name: "Rosa Paredes Luna", time: "09:00", reason: "Consulta por dolor de cabeza", status: s.rosa }]
    : [{ start: 570, name: "Julia Ramos Vega", time: "09:30", reason: "Chequeo anual", status: "new", fresh: true }]
  const room2: Block[] = today
    ? [{ start: 600, name: "Luis Gómez Salas", time: "10:00", reason: "Control de presión arterial", status: s.luis }]
    : []

  return (
    <div className="da">
      <div className="da-head">
        <span className="da-title">
          <b>Agenda</b>
          <span>Sede San Martín · Profesionales: todos</span>
        </span>
        <fieldset className="da-days">
          <legend className="sr-only">Día</legend>
          {(
            [
              ["hoy", "Hoy · lun 26"],
              ["manana", "Mañana · mar 27"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={day === id} onClick={() => setDay(id)}>
              {label}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="da-grid-wrap">
        <div className="da-cols da-cols-head">
          <span />
          <span className="da-room-h">Sala 1</span>
          <span className="da-room-h">Sala 2</span>
        </div>
        <div className="da-cols da-body">
          <div className="da-hours">
            {HOURS.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          <div className="da-room">
            {room1.map((b) => (
              <AppointmentBlock key={b.name} block={b} />
            ))}
          </div>
          <div className="da-room">
            {room2.map((b) => (
              <AppointmentBlock key={b.name} block={b} />
            ))}
          </div>
          {today && (
            <div className="da-now" aria-hidden="true" style={{ top: top(s.now) }}>
              <span>{hm(s.now)}</span>
              <i />
            </div>
          )}
        </div>
      </div>

      <div className="da-toast-slot" aria-live="polite">
        {s.toast && (
          <button type="button" className="da-toast" onClick={() => setDay(today ? "manana" : "hoy")}>
            <span className="da-sofi" aria-hidden="true">
              S
            </span>
            <span className="da-toast-text">
              <b>Sofi agendó a Julia Ramos Vega</b>
              <span>Mañana 09:30 · Chequeo anual · Sala 1 · por WhatsApp, con su sí</span>
            </span>
            <span className="da-toast-go">{today ? "Ver mañana" : "Ver hoy"}</span>
          </button>
        )}
      </div>
      <span className="da-note">Demostración con datos de ejemplo. El día avanza solo; cambia entre hoy y mañana.</span>
    </div>
  )
}
