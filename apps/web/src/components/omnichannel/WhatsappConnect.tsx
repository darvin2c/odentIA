// Conectar WhatsApp en tres pasos (odentIA, /whatsapp-para-clinicas-dentales): la misma pantalla de la
// aplicación, con sus pasos y sus palabras. Cada paso se comprueba solo: la cuenta, la dirección que Meta
// verifica y el primer «hola» al número de la clínica, que cae en la Bandeja y lo atiende Sofi. Avanza
// cada 1,8 s y se puede repetir. Con movimiento reducido se ve el final, quieto. Datos de ejemplo.
import { useCallback, useEffect, useRef, useState } from "react"
import "./whatsapp-connect.css"

const STEP_MS = 1800
const LAST = 4

type State = "done" | "current" | "todo"

const STEPS: { title: string; todo: string; done: string }[] = [
  {
    title: "Tu cuenta de WhatsApp Business",
    todo: "Los cuatro datos están en la app de Meta de la clínica.",
    done: "La cuenta es Clínica Sonrisa Norte.",
  },
  {
    title: "Que WhatsApp nos avise",
    todo: "Copia estos dos valores en tu app de Meta, en WhatsApp › Configuración.",
    done: "Meta verificó la dirección.",
  },
  {
    title: "Prueba y listo",
    todo: "Escribe «hola» al número de la clínica desde cualquier teléfono.",
    done: "Llegó el primer mensaje.",
  },
]

export default function WhatsappConnect() {
  // Se arma en el servidor con los tres pasos hechos: sin JavaScript se lee igual.
  const [n, setN] = useState(LAST)
  const timer = useRef<number | undefined>(undefined)

  const play = useCallback(() => {
    window.clearInterval(timer.current)
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setN(LAST)
      return
    }
    let step = 0
    setN(0)
    timer.current = window.setInterval(() => {
      step += 1
      setN(step)
      if (step >= LAST) window.clearInterval(timer.current)
    }, STEP_MS)
  }, [])

  useEffect(() => {
    play()
    return () => window.clearInterval(timer.current)
  }, [play])

  // n = cuántos pasos están hechos (de 0 a 3); en 4 llegó además el mensaje a la Bandeja.
  const done = Math.min(n, 3)
  const stateOf = (i: number): State => (i < done ? "done" : i === done ? "current" : "todo")

  return (
    <div className="wc">
      <div className="wc-head">
        <div>
          <b>Conectar WhatsApp</b>
          <span>Tres pasos. Cada uno se comprueba solo y dice qué encontró; puedes cerrar y volver cuando quieras.</span>
        </div>
        <button type="button" className="wc-replay" onClick={play}>
          <span aria-hidden="true">↻</span> Volver a ver
        </button>
      </div>
      <ol className="wc-steps" aria-live="polite">
        {STEPS.map((s, i) => {
          const state = stateOf(i)
          return (
            <li key={s.title} className="wc-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="wc-num" aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="wc-text">
                <b>{s.title}</b>
                <span>{state === "done" ? s.done : s.todo}</span>
                {state === "current" && i === 1 && <span className="wc-wait">Esperando a Meta. Esta pantalla lo detecta sola cuando verifique la dirección.</span>}
                {state === "current" && i === 2 && <span className="wc-wait">Esperando el primer mensaje. Esta pantalla lo detecta sola en cuanto llegue.</span>}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="wc-inbox" data-on={n >= LAST || undefined} aria-hidden={n >= LAST ? undefined : true}>
        <span className="wc-inbox-k">Bandeja · WhatsApp</span>
        <div className="wc-row">
          <span className="wc-av" aria-hidden="true">
            +
          </span>
          <span className="wc-row-text">
            <b>hola</b>
            <span>Primer mensaje al número de la clínica</span>
          </span>
          <span className="wc-chip">La atiende Sofi</span>
        </div>
        <span className="wc-ok">Conectado. Desde ahora, cada mensaje llega a la ficha de la persona.</span>
      </div>
      <span className="wc-foot">Demostración con datos de ejemplo.</span>
    </div>
  )
}
