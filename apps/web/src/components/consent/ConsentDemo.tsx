// La firma del consentimiento en la tablet (guía del consentimiento, «Pruébalo aquí»), con las palabras
// de la app (`consent-signing.tsx` y `@odentia/clinical/consent`): la hoja con sus secciones, «Entendí
// lo que me explicaron y acepto» y «Firma aquí con el dedo». Como en la app, son dos pasos: firma el
// paciente («Listo») y después confirma el profesional que informó, con su perfil. Se firma de verdad
// con el dedo o el ratón; con el teclado, Enter en el recuadro pone una firma de ejemplo. No guarda nada.
import { useEffect, useRef, useState } from "react"
import "./consent-demo.css"

const SECTIONS: Array<[string, string]> = [
  ["Procedimiento propuesto", "Extracción del 38 (tercera molar de abajo, a la izquierda), con anestesia local."],
  ["Diagnóstico que lo motiva", "Tercera molar que salió a medias; la encía de encima se inflama a repetición."],
  ["Beneficios esperados", "Que no vuelva el dolor ni la inflamación."],
  ["Riesgos y molestias", "Dolor e hinchazón unos días, boca que abre poco, sangrado leve, alveolitis, daño a la muela de al lado; rara vez, labio o lengua adormecidos unas semanas, y muy rara vez para siempre."],
  ["Riesgos propios de su caso", "Toma un anticoagulante: puede sangrar más."],
  ["Alternativas", "Controlarla y tratar cada inflamación, sabiendo que puede volver."],
  ["Consecuencias de no tratarse", "Más inflamaciones, caries de la muela de al lado o infección."],
  ["Información adicional", "Los cuidados de después y a quién llamar si algo no va bien."],
]

const DECLARATION =
  "He leído y comprendido la información, pude hacer preguntas y fueron respondidas. Autorizo el procedimiento descrito y sé que puedo revocar este consentimiento antes de que se realice."

type Point = [number, number]

export default function ConsentDemo() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Point[][]>([])
  const drawing = useRef(false)
  const [understood, setUnderstood] = useState(false)
  const [signed, setSigned] = useState(false)
  /** «paciente»: lee, marca y firma; «profesional»: confirma quien informó; «listo». */
  const [step, setStep] = useState<"paciente" | "profesional" | "listo">("paciente")

  const paint = () => {
    const el = canvas.current
    const ctx = el?.getContext("2d")
    if (!el || !ctx) return
    const ratio = window.devicePixelRatio || 1
    const { width, height } = el.getBoundingClientRect()
    if (el.width !== Math.round(width * ratio)) {
      el.width = Math.round(width * ratio)
      el.height = Math.round(height * ratio)
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.strokeStyle = "#0f172a"
    ctx.lineWidth = 2.2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    for (const stroke of strokes.current) {
      ctx.beginPath()
      stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)))
      ctx.stroke()
    }
  }

  useEffect(() => {
    paint()
    const onResize = () => paint()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  })

  const at = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect()
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]
  }

  const clear = () => {
    strokes.current = []
    setSigned(false)
    paint()
  }

  /** Una firma de ejemplo, para quien usa el teclado. */
  const sample = () => {
    const wave: Point[] = Array.from({ length: 40 }, (_, i) => {
      const t = i / 39
      return [0.12 + t * 0.7, 0.58 - Math.sin(t * Math.PI * 3) * 0.18 * (1 - t * 0.4)]
    })
    strokes.current = [wave, [[0.3, 0.75], [0.72, 0.7]]]
    setSigned(true)
    paint()
  }

  const ready = understood && signed

  return (
    <div className="cd">
      <div className="cd-tablet">
        <div className="cd-head">
          <b>Firma del consentimiento</b>
          <span>Rosa Quispe · Historia clínica 000124</span>
        </div>
        <div className="cd-sheet" role="region" aria-label="La hoja del consentimiento">
          <b className="cd-title">CONSENTIMIENTO INFORMADO · EXTRACCIÓN DENTAL</b>
          {SECTIONS.map(([label, text]) => (
            <p key={label}>
              <span className="cd-k">{label}</span>
              {text}
            </p>
          ))}
          <p className="cd-decl">{DECLARATION}</p>
        </div>

        <label className="cd-check">
          <input
            type="checkbox"
            disabled={step !== "paciente"}
            checked={understood}
            onChange={(event) => {
              setUnderstood(event.target.checked)
            }}
          />
          <strong>Entendí lo que me explicaron y acepto</strong>
        </label>

        <fieldset className="cd-pad">
          <legend>Firma aquí con el dedo</legend>
          <canvas
            ref={canvas}
            tabIndex={0}
            role="button"
            aria-label={signed ? "Firma puesta. Borrar para firmar otra vez." : "Recuadro de la firma: firma con el dedo o el ratón; con el teclado, Enter pone una firma de ejemplo."}
            onKeyDown={(event) => {
              if (step === "paciente" && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault()
                sample()
              }
            }}
            onPointerDown={(event) => {
              if (step !== "paciente") return
              event.currentTarget.setPointerCapture(event.pointerId)
              drawing.current = true
              strokes.current.push([at(event)])
            }}
            onPointerMove={(event) => {
              if (!drawing.current) return
              strokes.current.at(-1)?.push(at(event))
              paint()
            }}
            onPointerUp={() => {
              drawing.current = false
              if ((strokes.current.at(-1)?.length ?? 0) > 2) setSigned(true)
            }}
            onPointerCancel={() => {
              drawing.current = false
            }}
          />
          <button type="button" className="cd-clear" onClick={() => {
              clear()
              canvas.current?.focus()
            }} disabled={!signed || step !== "paciente"}>
            Borrar
          </button>
        </fieldset>

        {step === "paciente" ? (
          <button type="button" className="cd-save" disabled={!ready} onClick={() => setStep("profesional")}>
            Listo
          </button>
        ) : step === "profesional" ? (
          <div className="cd-pro">
            <span>
              <b>Profesional que informa</b>
              Dra. Lucía Paredes · Colegiatura 12345
            </span>
            <button type="button" className="cd-save" onClick={() => setStep("listo")}>
              Guardar y confirmar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cd-again"
            onClick={() => {
              setUnderstood(false)
              setStep("paciente")
              clear()
            }}
          >
            Volver a empezar
          </button>
        )}
        <p className={`cd-status${step === "listo" ? " ok" : ""}`} role="status">
          {step === "listo"
            ? "Consentimiento firmado. El PDF queda en su historia clínica, con la fecha y la hora."
            : step === "profesional"
              ? "El paciente ya firmó. Ahora confirma el profesional que le explicó."
              : !understood
                ? "Marca la casilla y firma para seguir."
                : !signed
                  ? "Ahora firma en el recuadro."
                  : "Toca «Listo» para pasar al profesional."}
        </p>
      </div>
    </div>
  )
}
