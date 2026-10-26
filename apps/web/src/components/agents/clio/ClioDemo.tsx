// La demo de la portada de Clío en odentIA: se ve que la Dra. Paredes le está hablando (su globo con
// el micrófono y la onda, la frase palabra por palabra) y, mientras habla, Clío pone cada cosa en su
// sitio: la 36 se marca en el odontograma real de la app y aparecen la nota, el diagnóstico, el
// presupuesto con dos opciones y el control. Al terminar, «Confirmar las 5» y todo pasa a la
// historia. Sin movimiento (prefers-reduced-motion) se ve el estado final. El botón «Volver a dictar»
// de la portada vive en el HTML (`data-clio-replay`) y la reinicia, igual que el del pie.
import { useCallback, useEffect, useRef, useState } from "react"
import OdontogramArch, { type ExampleFinding } from "../../odontogram/OdontogramArch"
import { AgentFoot, AgentHead, prefersStill, VoiceBubble } from "../frame/AgentFrame"
import "../frame/agent-frame.css"
import "./clio-demo.css"

/** Lo que dicta la Dra. Paredes, frase a frase (datos de ejemplo). */
const SAID = [
  "Carlos viene por dolor al frío en una muela de abajo, desde hace una semana.",
  "En la 36 hay caries oclusal profunda; la percusión es negativa.",
  "Le hacemos una resina, o si no, una corona.",
  "Y control en seis meses.",
]

/** Lo que propone Clío y desde qué paso aparece. */
const PROPOSED = [
  { block: "Nota", text: "Dolor al frío hace una semana", from: 1 },
  { block: "Odontograma", text: "36 · caries oclusal profunda", from: 2 },
  { block: "Diagnóstico", text: "K02.1 · caries de la dentina", from: 2 },
  { block: "Presupuesto", text: "Resina o corona, con tus precios", from: 3 },
  { block: "Control", text: "En 6 meses, con recordatorio", from: 4 },
]

/** Pasos: 0–3 dicta, 4 listo para confirmar, 5 confirmado. */
const READY = SAID.length
const LAST = READY + 1
const STEP_MS = 2600
/** Lo que se espera con todo listo antes de que la doctora confirme sola en la demo. */
const CONFIRM_MS = 3200

/** La 46 ausente y la 11 con corona ya estaban en la ficha de Carlos. */
const BEFORE: Partial<Record<number, ExampleFinding>> = { 46: "ausente", 11: "corona" }
const AFTER: Partial<Record<number, ExampleFinding>> = { ...BEFORE, 36: "caries" }

export default function ClioDemo() {
  // En el servidor y sin movimiento, el estado final: la página se lee entera sin animación.
  const [step, setStep] = useState(LAST)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  // Cada paso agenda el siguiente; el último (confirmar) espera un poco más.
  const play = useCallback(() => {
    stop()
    const next = (s: number) => {
      setStep(s)
      if (s >= LAST) return
      timer.current = setTimeout(() => next(s + 1), s === READY ? CONFIRM_MS : STEP_MS)
    }
    next(0)
  }, [stop])

  useEffect(() => {
    if (!prefersStill()) play()
    // «Volver a dictar» lo pide quien mira: se repite aunque prefiera menos movimiento.
    const onClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest("[data-clio-replay]")) play()
    }
    document.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("click", onClick)
      stop()
    }
  }, [play, stop])

  const speaking = step < READY
  const confirmed = step >= LAST
  const marked = step >= 2
  const shown = PROPOSED.filter((item) => item.from <= Math.min(step, READY))
  const confirmNow = () => {
    stop()
    setStep(LAST)
  }

  return (
    <div className="af-card cl">
      <AgentHead
        agent="clio"
        name="Clío · en la consulta"
        meta="Carlos Medina · Dra. Paredes · 09:40"
        state={speaking ? "Escuchando…" : confirmed ? "En la historia" : "Listo para confirmar"}
        live={speaking}
        done={confirmed}
      />
      <VoiceBubble
        initials="DP"
        who="Dra. Paredes"
        text={SAID[Math.min(step, SAID.length - 1)]}
        speaking={speaking}
        idle="dictado terminado · 1 min 12 s"
      />
      <div className="cl-work">
        <div className="cl-arch">
          <span className="cl-label">Odontograma</span>
          <OdontogramArch
            findings={marked ? AFTER : BEFORE}
            selected={marked ? 36 : null}
            description={
              marked
                ? "Odontograma de Carlos: la 46 ausente, la 11 con corona y la 36 con caries oclusal, recién dictada."
                : "Odontograma de Carlos: la 46 ausente y la 11 con corona."
            }
          />
        </div>
        <div className="cl-props">
          <span className="cl-label">Clío propone · {shown.length} de 5</span>
          <ul className="cl-list" aria-live="polite">
            {PROPOSED.map((item) => {
              const on = item.from <= Math.min(step, READY)
              return (
                <li
                  key={item.block}
                  className={`cl-item${on ? " on" : ""}${on && item.from === step ? " new" : ""}`}
                  aria-hidden={on ? undefined : true}
                >
                  <span className="cl-block">{item.block}</span>
                  <span className="cl-text">{item.text}</span>
                  <span className={`cl-chip${confirmed ? " ok" : ""}`} title={confirmed ? "Guardado" : "Por confirmar"}>
                    <span aria-hidden="true">{confirmed ? "✓" : ""}</span>
                    <span className="sr-only">{confirmed ? "Guardado" : "Por confirmar"}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
      <div className="cl-bulk" data-ready={(!speaking && !confirmed) || undefined}>
        {confirmed ? (
          <span className="cl-done">✓ La Dra. Paredes confirmó. Ya está en la historia de Carlos, con su presupuesto de dos opciones.</span>
        ) : (
          <>
            <button type="button" className="cl-confirm" disabled={speaking} onClick={confirmNow}>
              Confirmar las 5
            </button>
            <span className="cl-hint">Nada entra a la historia sin tu sí.</span>
          </>
        )}
      </div>
      <AgentFoot note="Datos de ejemplo." replay="Volver a dictar" onReplay={play} />
    </div>
  )
}
