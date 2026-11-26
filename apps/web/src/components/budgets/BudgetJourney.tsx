// El recorrido del presupuesto de Carlos («Pruébalo aquí» de Presupuestos y de la guía del
// presupuesto): tu consulta, su celular y tu tablero, lado a lado. Avanza cuando la persona toca, no
// solo. Lo que dice es lo que hace la app:
// - Clío propone la resina con la incrustación como alternativa; las opciones salen al confirmar
//   (`confirmPlanChoice` en @odentia/services).
// - Los precios son los del tarifario; el motivo se pide solo al bajar un precio (`adjustBudgetLines`).
// - Al cerrar, «¿Enviárselo ahora?» y sale la plantilla «Presupuesto listo» con «Ver y responder»
//   (`BUDGET_READY_MESSAGE`).
// - En Su enlace la opción recomendada viene marcada (sin decir quién la recomienda), se acepta y se
//   reserva ahí mismo.
// - El tablero pasa a «Presupuesto enviado» al entregarlo y a «Decidió» al aceptar.
// - Sin respuesta, a los dos días sale un recordatorio a quien aceptó novedades; si no se le puede
//   escribir, una tarea. Aceptado sin cita: tarea a los 7 días (`admin-lines.ts`).
// Los montos en soles son del ejemplo (una clínica de Perú). No guarda nada.
import { useEffect, useRef, useState } from "react"
import "./budget-journey.css"

type Pick = "A" | "B"
/** 0 dictado, 1 opciones listas, 2 enviado, 3 aceptó, 4 reservó. */
type Stage = 0 | 1 | 2 | 3 | 4

const OPTIONS: Record<Pick, { name: string; lines: Array<[string, string]>; total: string }> = {
  A: {
    name: "Resina",
    lines: [
      ["Resina · 36", "S/ 180"],
      ["Limpieza", "S/ 120"],
    ],
    total: "S/ 300",
  },
  B: {
    name: "Incrustación",
    lines: [
      ["Incrustación · 36", "S/ 650"],
      ["Limpieza", "S/ 120"],
    ],
    total: "S/ 770",
  },
}

const STEPS: Array<{
  who: string
  tone: "clio" | "team" | "argos"
  title: string
}> = [
  { who: "Clío", tone: "clio", title: "Dictas el plan" },
  { who: "Tú", tone: "team", title: "Confirmas las opciones" },
  { who: "Al cerrar", tone: "team", title: "«¿Enviárselo ahora?»" },
  { who: "El paciente", tone: "team", title: "Elige desde su celular" },
  { who: "Argos", tone: "argos", title: "Retoma lo pendiente" },
]

const SLOTS = ["Martes 4 · 10:30", "Martes 4 · 16:00", "Jueves 6 · 09:00"]

interface Card {
  who: string
  what: string
  note: string
  tone?: "won" | "argos" | "moved"
}

interface Props {
  /** La llamada a la acción del sitio, al terminar el recorrido (en la guía no va: tiene la suya). */
  cta?: { href: string; label: string }
}

export default function BudgetJourney({ cta }: Props) {
  const [stage, setStage] = useState<Stage>(0)
  const [pick, setPick] = useState<Pick>("A")
  const [silent, setSilent] = useState(false)
  const [slot, setSlot] = useState<string | null>(null)
  const [restarted, setRestarted] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // El botón tocado desaparece: el foco sigue en la acción siguiente. Corre en cada render y solo
  // actúa después de un toque (`moved`).
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    root.current?.querySelector<HTMLElement>("[data-next]")?.focus()
  })

  const go = (next: Stage) => {
    moved.current = true
    setRestarted(false)
    setStage(next)
  }
  const reset = () => {
    moved.current = true
    setStage(0)
    setPick("A")
    setSilent(false)
    setSlot(null)
    setRestarted(true)
  }
  const ignore = () => {
    moved.current = true
    setSilent(true)
  }

  // El paso de la barra: lo dictado ya está, así que se empieza en «Confirmas» (2); con las opciones,
  // «Al cerrar» (3); enviado, el paciente (4); con «¿Y si no responde?», Argos (5).
  const current = silent && stage === 2 ? 4 : Math.min(stage + 1, 3)
  // Con Argos (paso 5), el paciente aún no eligió: el paso 4 no se marca hecho.
  const done = silent && stage === 2 ? 3 : current
  const carlos = "Resina o incrustación · 36"
  const board: Array<{ step: string; when: string; cards: Card[] }> = [
    {
      step: "Interesado",
      when: "Preguntó por un precio",
      cards: [{ who: "Jorge", what: "Ortodoncia", note: "Lo pidió por WhatsApp hoy" }],
    },
    {
      step: "Evaluación agendada",
      when: "Al agendar su cita",
      cards: [
        { who: "Rosa", what: "Implante · 46", note: "Jueves 29 · 16:30" },
        ...(stage < 2 ? [{ who: "Carlos", what: carlos, note: "Hoy en consulta" }] : []),
      ],
    },
    {
      step: "Presupuesto enviado",
      when: "Al enviarle el presupuesto",
      cards:
        stage === 2
          ? [
              silent
                ? {
                    who: "Carlos",
                    what: carlos,
                    note: "Recordado a los 2 días",
                    tone: "argos" as const,
                  }
                : {
                    who: "Carlos",
                    what: carlos,
                    note: "Esperando su respuesta",
                    tone: "moved" as const,
                  },
            ]
          : [],
    },
    {
      step: "Decidió",
      when: "Al aceptarlo o rechazarlo",
      cards: [
        {
          who: "Andrea",
          what: "Resina y limpieza",
          note: "Ganada · S/ 300",
          tone: "won",
        },
        ...(stage >= 3
          ? [
              {
                who: "Carlos",
                what: `Opción ${pick} · ${OPTIONS[pick].name}`,
                note: `Ganada · ${OPTIONS[pick].total}`,
                tone: "won" as const,
              },
            ]
          : []),
      ],
    },
  ]
  // Una sola región que se lee: cada paso dice algo distinto, para que el lector lo anuncie.
  const says =
    stage === 0
      ? `${restarted ? "Volviste al inicio. " : ""}Carlos está en su evaluación de hoy. Cuando le envíes el presupuesto, su tarjeta pasa sola.`
      : stage === 1
        ? "Salieron las opciones A y B con tu tarifario. Carlos sigue en su evaluación hasta que se lo envíes."
        : stage === 2
          ? silent
            ? "A los dos días sin respuesta, Argos le envió un recordatorio por WhatsApp, porque aceptó recibir novedades. Si no se le pudiera escribir, dejaría una tarea para llamarlo."
            : "Su tarjeta pasó sola a «Presupuesto enviado». Nadie la movió."
          : stage === 3
            ? "Aceptó: su tarjeta pasó sola a «Decidió», como ganada. Si no reserva, a los 7 días Argos deja una tarea para llamarlo."
            : `Aceptó y reservó su cita (${slot}) desde su celular. Nadie tuvo que llamar.`

  return (
    <div className="bj" ref={root}>
      <div className="bj-in">
        <ol className="bj-steps" aria-label="Los pasos">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className={index === current ? "now" : index < current && index < done ? "done" : ""}
              aria-current={index === current ? "step" : undefined}
            >
              <span className={`bj-who ${step.tone}`}>
                0{index + 1} · {step.who}
              </span>
              <b>{step.title}</b>
            </li>
          ))}
        </ol>
        {/* En angosto la barra son rayas: el paso en que vas, escrito debajo (el lector ya lo tiene en la lista). */}
        <p className="bj-now" aria-hidden="true">
          0{current + 1} · {STEPS[current]?.who}: {STEPS[current]?.title}
        </p>

        <div className="bj-panels">
          <section
            className={`bj-panel bj-desk${stage >= 2 ? " bj-later" : ""}`}
            aria-label="Tu consulta"
          >
            <span className="bj-label">Tu consulta · Carlos Medina</span>
            <div className="bj-dictation">
              <span className="bj-mic" aria-hidden="true">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </span>
              <span>
                <span className="bj-mono">Tú dictas · Clío escucha</span>
                <span className="bj-quote">
                  «Resina oclusal en la 36, o si no una incrustación. Y una limpieza.»
                </span>
              </span>
            </div>
            {stage === 0 ? (
              <>
                <button type="button" className="bj-btn" data-next onClick={() => go(1)}>
                  Confirmar lo que propone Clío
                </button>
                <span className="bj-hint">
                  Clío propone la resina, con la incrustación como otra opción. Tú confirmas y salen
                  las opciones.
                </span>
              </>
            ) : (
              <>
                <div className="bj-opts">
                  {(["A", "B"] as const).map((key) => (
                    <div key={key} className="bj-opt">
                      <b>Opción {key}</b>
                      {OPTIONS[key].lines.map(([label, amount]) => (
                        <span key={label} className="bj-line">
                          <span>{label}</span>
                          <span>{amount}</span>
                        </span>
                      ))}
                      <span className="bj-line bj-total">
                        <span>Total</span>
                        <span>{OPTIONS[key].total}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <span className="bj-hint">
                  Con los precios de tu tarifario. Si bajas un precio, escribes el motivo. Aquí van
                  dos opciones; puedes ofrecer hasta tres.
                </span>
                {stage === 1 ? (
                  <div className="bj-ask">
                    <b>Al cerrar la atención: «¿Enviárselo ahora?»</b>
                    <button type="button" className="bj-btn" data-next onClick={() => go(2)}>
                      Enviar por WhatsApp
                    </button>
                  </div>
                ) : (
                  <span className="bj-chip">Enviado por WhatsApp con su enlace</span>
                )}
                {silent && stage === 2 ? (
                  <span className="bj-chip bj-argos">
                    Dos días sin respuesta: le llegó un recordatorio
                  </span>
                ) : null}
              </>
            )}
          </section>

          <section
            className={`bj-phone-wrap${stage < 2 ? " bj-later" : ""}`}
            aria-label="El celular de Carlos"
          >
            <div className="bj-phone">
              <div className="bj-screen">
                <span className="bj-notch" aria-hidden="true" />
                <span className="bj-mono">Clínica Sonrisa Norte · Su enlace</span>
                {stage < 2 ? (
                  <span className="bj-empty">
                    El celular de Carlos. Aquí llega lo que le envíes.
                  </span>
                ) : stage === 2 ? (
                  <>
                    <span className="bj-bubble">
                      Hola, Carlos. Tu presupuesto está listo: resina o incrustación en la 36.
                      Puedes verlo y decirnos qué aceptas aquí.{" "}
                      <span className="bj-bubble-btn">Ver y responder</span>
                    </span>
                    <b className="bj-phone-t">Tu presupuesto</b>
                    {(["A", "B"] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        className={`bj-pick${pick === key ? " on" : ""}`}
                        aria-pressed={pick === key}
                        onClick={() => setPick(key)}
                      >
                        <span>
                          Opción {key} · {OPTIONS[key].name}
                        </span>
                        <span>{OPTIONS[key].total}</span>
                      </button>
                    ))}
                    <span className="bj-small">Puedes aceptar solo una parte.</span>
                    <button
                      type="button"
                      className="bj-btn bj-dark"
                      data-next
                      onClick={() => go(3)}
                    >
                      Aceptar la opción {pick}
                    </button>
                    {/* Lo de Argos se ve aquí, donde se tocó: en el celular el tablero queda abajo. */}
                    {silent ? (
                      <span className="bj-chip bj-argos">
                        Dos días después: le llegó un recordatorio
                      </span>
                    ) : (
                      <button type="button" className="bj-link" onClick={ignore}>
                        ¿Y si no responde?
                      </button>
                    )}
                  </>
                ) : stage === 3 ? (
                  <>
                    <span className="bj-ok">
                      Aceptaste la opción {pick} · {OPTIONS[pick].total}
                    </span>
                    <b className="bj-phone-t">Elige tu horario</b>
                    {SLOTS.map((label, index) => (
                      <button
                        key={label}
                        type="button"
                        className="bj-slot"
                        data-next={index === 0 ? "" : undefined}
                        onClick={() => {
                          setSlot(label)
                          go(4)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="bj-done">
                    <svg
                      width="40"
                      height="40"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="m8 12 3 3 5-6" />
                    </svg>
                    <b>Tu cita está reservada</b>
                    <span>{slot} · Dra. Paredes</span>
                  </span>
                )}
              </div>
            </div>
          </section>

          <section className="bj-panel bj-board-wrap" aria-label="Tu tablero de Oportunidades">
            <span className="bj-label">Tu tablero · Oportunidades</span>
            <ol className="bj-board">
              {board.map((column) => (
                <li key={column.step} className="bj-col">
                  <b>{column.step}</b>
                  <span className="bj-when">{column.when}</span>
                  {column.cards.map((card) => (
                    <span
                      key={card.who}
                      className={`bj-card${card.tone ? ` ${card.tone}` : ""}${card.who === "Carlos" ? "" : " bj-other"}`}
                    >
                      <b>{card.who}</b>
                      <span>{card.what}</span>
                      <span className="bj-note">{card.note}</span>
                    </span>
                  ))}
                </li>
              ))}
            </ol>
            <p className="bj-says" aria-live="polite">
              {says}
            </p>
          </section>
        </div>

        <div className="bj-foot">
          <span>
            Ejemplo con montos de una clínica de Perú, no precios de odentIA. No guarda nada.
          </span>
          <span className="bj-actions">
            {stage === 4 && cta ? (
              <a className="btn btn-p" href={cta.href} data-next="">
                {cta.label}
              </a>
            ) : null}
            {stage > 0 || silent ? (
              <button
                type="button"
                className="bj-btn bj-soft"
                data-next={stage === 4 && !cta ? "" : undefined}
                onClick={reset}
              >
                Volver a empezar
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  )
}
