// La demo de la portada de Clío (lienzo del paso 3, tablero «Clio»): mientras la doctora dicta
// aparecen las líneas que Clío propone y la 36 se marca con caries en el odontograma real de la
// app. Sin movimiento (prefers-reduced-motion) se ve el estado final. El botón «Volver a dictar»
// de la portada vive en el HTML (`data-clio-replay`) y la reinicia.
import { useEffect, useRef, useState } from "react"
import OdontogramArch, { type ExampleFinding } from "../../odontogram/OdontogramArch"
import "./clio-demo.css"

const LINES = [
  { block: "Dictado", text: "«Dolor al frío en la 36 desde hace una semana…»" },
  { block: "Nota", text: "Dolor al frío en 36 hace una semana; percusión negativa." },
  { block: "Odontograma", text: "36 · caries oclusal profunda (por confirmar)" },
  { block: "Diagnóstico", text: "CIE-10 · K02.1 caries de la dentina · pieza 36" },
  { block: "Plan", text: "Resina en 36, o si no una corona: dos opciones en el presupuesto" },
]
const LAST = LINES.length - 1
/** La línea en que la doctora dicta la pieza: desde ahí la 36 aparece en el odontograma. */
const TOOTH_STEP = 2
const STEP_MS = 1700

/** La 46 ausente y la 11 con corona ya estaban en la ficha de Carlos. */
const BEFORE: Partial<Record<number, ExampleFinding>> = { 46: "ausente", 11: "corona" }
const AFTER: Partial<Record<number, ExampleFinding>> = { ...BEFORE, 36: "caries" }

export default function ClioDemo() {
  // En el servidor y sin movimiento, el estado final: la página se lee entera sin animación.
  const [step, setStep] = useState(LAST)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const play = () => {
      if (timer.current) clearInterval(timer.current)
      setStep(0)
      timer.current = setInterval(() => {
        setStep((s) => {
          if (s + 1 >= LAST && timer.current) clearInterval(timer.current)
          return Math.min(LAST, s + 1)
        })
      }, STEP_MS)
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!reduce) play()
    // «Volver a dictar» lo pide quien mira: se repite aunque prefiera menos movimiento.
    const onClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest("[data-clio-replay]")) play()
    }
    document.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("click", onClick)
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  const done = step >= LAST
  const dictated = step >= TOOTH_STEP
  return (
    <div className="cd">
      <div className="cd-top">
        <span className="cd-who">Consulta de Carlos · Dra. Paredes</span>
        <span className={`cd-state${done ? "" : " live"}`} role="status">
          <i aria-hidden="true" />
          {done ? "Listo para confirmar" : "Escuchando…"}
        </span>
      </div>
      <div className="cd-arch">
        <OdontogramArch
          findings={dictated ? AFTER : BEFORE}
          selected={dictated ? 36 : null}
          description={
            dictated
              ? "Odontograma de Carlos: la 46 ausente, la 11 con corona y la 36 con caries oclusal, recién dictada."
              : "Odontograma de Carlos: la 46 ausente y la 11 con corona."
          }
        />
      </div>
      <ol className="cd-lines">
        {LINES.map((line, i) => (
          <li key={line.block} className={i <= step ? "on" : undefined}>
            <span className="cd-block">{line.block}</span>
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
