// La agenda del día de Clínica Sonrisa Norte (portada de /agenda-odontologica): Unidad dental 1 y
// Unidad dental 2 de 08:30 a 11:30 con la línea de «ahora» que avanza. Rosa llega, espera, la atiende
// la Dra. Paredes y queda «Atendida»; Sofi agenda a Julia para mañana y llega Carlos. Los momentos de
// la cita se dicen con las palabras de la app («Llegó 09:00 · espera 6 min», «En atención · con la
// Dra. Paredes desde 09:12»), nunca solo con color. Con movimiento reducido se ve el estado final.
import { useEffect, useState } from "react"
import "./day-agenda.css"

type Status = "c" | "w" | "in" | "done" | "new"

/** Cada paso de la mañana: la hora de la línea (en minutos) y el momento de Rosa y de Carlos. */
const STEPS: { now: number; rosa: Status; carlos: Status; toast?: boolean }[] = [
  { now: 530, rosa: "c", carlos: "c" },
  { now: 546, rosa: "w", carlos: "c" },
  { now: 552, rosa: "in", carlos: "c" },
  { now: 574, rosa: "done", carlos: "c" },
  { now: 581, rosa: "done", carlos: "c", toast: true },
  { now: 602, rosa: "done", carlos: "w", toast: true },
  { now: 609, rosa: "done", carlos: "in", toast: true },
]
const LAST = STEPS.length - 1

/** La rejilla empieza a las 08:30 (510 min) y cada media hora mide 72 px. */
const START = 510
const ROW = 72
const HOURS = ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]
const top = (minutes: number) => ((minutes - START) / 30) * ROW

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

type Block = {
  start: number
  name: string
  time: string
  reason: string
  /** Quien atiende, como figura en la agenda. */
  who: string
  status: Status
  /** La palabra del momento, ya armada con su hora, como la dice la app. */
  label: string
  fresh?: boolean
}

type Moment = { arrived: string; wait: string; who: string; since: string; end: string }

/** El momento en palabras: «Llegó 09:00 · espera 6 min», «En atención · con la Dra. Paredes desde 09:12». */
function momentLabel(status: Status, m: Moment): string {
  switch (status) {
    case "c":
      return "Confirmada"
    case "w":
      return `Llegó ${m.arrived} · espera ${m.wait} min`
    case "in":
      return `En atención · con ${m.who} desde ${m.since}`
    case "done":
      return `Atendida · ${m.end}`
    default:
      return "Por confirmar"
  }
}

function AppointmentBlock({ block }: { block: Block }) {
  return (
    <div className={`dag-blk dag-${block.status}${block.fresh ? " dag-pop" : ""}`} style={{ top: top(block.start) + 3 }}>
      <span className="dag-blk-top">
        <b>{block.name}</b>
        <span className="dag-time">{block.time}</span>
      </span>
      <span className="dag-reason">{block.reason}</span>
      <span className="dag-reason">{block.who}</span>
      <span className={`dag-chip dag-chip-${block.status}`}>{block.label}</span>
    </div>
  )
}

const ROSA: Moment = { arrived: "09:00", wait: "6", who: "la Dra. Paredes", since: "09:12", end: "09:34" }
const CARLOS: Moment = { arrived: "10:00", wait: "2", who: "el Dr. Ríos", since: "10:09", end: "10:40" }
const JULIA: Moment = { arrived: "", wait: "", who: "", since: "", end: "" }

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
  const unit1: Block[] = today
    ? [
        {
          start: 540,
          name: "Rosa Vega",
          time: "09:00",
          reason: "Limpieza dental (profilaxis)",
          who: "Dra. Paredes",
          status: s.rosa,
          label: momentLabel(s.rosa, ROSA),
        },
      ]
    : [
        {
          start: 570,
          name: "Julia Ramos",
          time: "09:30",
          reason: "Evaluación odontológica",
          who: "Dra. Paredes",
          status: "new",
          label: momentLabel("new", JULIA),
          fresh: true,
        },
      ]
  const unit2: Block[] = today
    ? [
        {
          start: 600,
          name: "Carlos Medina",
          time: "10:00",
          reason: "Obturación con resina · pieza 36",
          who: "Dr. Ríos",
          status: s.carlos,
          label: momentLabel(s.carlos, CARLOS),
        },
      ]
    : []

  return (
    <div className="dag">
      <div className="dag-head">
        <span className="dag-title">
          <b>Agenda</b>
          <span>Sede Los Olivos · Odontólogos: todos</span>
        </span>
        <fieldset className="dag-days">
          <legend className="sr-only">Día</legend>
          {(
            [
              ["hoy", "Hoy · lun 26"],
              ["manana", "Mañana · mar 27"],
            ] as const
          ).map(([id, text]) => (
            <button key={id} type="button" aria-pressed={day === id} onClick={() => setDay(id)}>
              {text}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="dag-grid-wrap">
        <div className="dag-cols dag-cols-head">
          <span />
          <span className="dag-room-h">Unidad dental 1</span>
          <span className="dag-room-h">Unidad dental 2</span>
        </div>
        <div className="dag-cols dag-body">
          <div className="dag-hours">
            {HOURS.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          <div className="dag-room">
            {unit1.map((b) => (
              <AppointmentBlock key={b.name} block={b} />
            ))}
          </div>
          <div className="dag-room">
            {unit2.map((b) => (
              <AppointmentBlock key={b.name} block={b} />
            ))}
          </div>
          {today && (
            <div className="dag-now" aria-hidden="true" style={{ top: top(s.now) }}>
              <span>{hm(s.now)}</span>
              <i />
            </div>
          )}
        </div>
      </div>

      <div className="dag-toast-slot" aria-live="polite">
        {s.toast && (
          <button type="button" className="dag-toast" onClick={() => setDay(today ? "manana" : "hoy")}>
            <span className="dag-sofi" aria-hidden="true">
              S
            </span>
            <span className="dag-toast-text">
              <b>Sofi agendó a Julia Ramos</b>
              <span>Mañana 09:30 · Evaluación odontológica · Unidad dental 1 · por WhatsApp, con su sí</span>
            </span>
            <span className="dag-toast-go">{today ? "Ver mañana" : "Ver hoy"}</span>
          </button>
        )}
      </div>
      <span className="dag-note">Demostración con datos de ejemplo. El día avanza solo; cambia entre hoy y mañana.</span>
    </div>
  )
}
