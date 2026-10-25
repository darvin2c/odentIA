// La atención de Rosa dictándose, en la portada de /agentes/asistente-clinico de latidIA (tablero
// «Clio»): la barra «Dictando…» con la onda y lo que se oye; Clío propone por bloque (Consulta, Examen
// físico, Diagnóstico, Documentos) con «Confirmar» y «Editar»; la temperatura se corrige en voz alta
// (38,5 → 38,4); «Dictado terminado», todo confirmado y el descanso médico, que no se confirma: se
// emite con la firma. Parece la app real (sugerencias en lila suave). El botón «Volver a dictar» de la
// portada vive en el HTML (`data-clio-replay`) y la reinicia. Con movimiento reducido, el estado final.
import { useEffect, useRef, useState } from "react"
import "./clio-dictation.css"

const LAST = 9
const STEP_MS = 1700

/** Lo que dicta la Dra. Vela, paso a paso (datos de la demo). */
const HEARD = [
  "«Viene por fiebre y dolor de garganta hace tres días.»",
  "«Viene por fiebre y dolor de garganta hace tres días.»",
  "«Presión 118 con 76, pulso 96, temperatura 38 y medio.»",
  "«Garganta: amígdalas aumentadas con placas blanquecinas.»",
  "«Amigdalitis aguda, presuntiva.»",
  "«No, la temperatura es 38,4.»",
  "«Descanso médico por tres días.»",
]

type Item = { from: number; text: string; sub: string; doc?: boolean; corrected?: boolean }

export default function ClioDictation() {
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
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) play()
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

  const dictating = step <= 6
  const confirmed = step >= 8
  const corrected = step === 5 || step === 6
  const blocks: { title: string; items: Item[] }[] = [
    { title: "Consulta", items: [{ from: 1, text: "Motivo: fiebre y dolor de garganta hace tres días", sub: "Motivo de consulta" }] },
    {
      title: "Examen físico",
      items: [
        {
          from: 2,
          text: `PA 118/76 mmHg · FC 96 lpm · T ${step >= 5 ? "38,4" : "38,5"} °C`,
          sub: corrected ? "Corregido por voz" : "Signos vitales",
          corrected,
        },
        { from: 3, text: "Boca y garganta · con hallazgos", sub: "Amígdalas aumentadas con placas blanquecinas" },
      ],
    },
    { title: "Diagnóstico", items: [{ from: 4, text: "J03.9 · Amigdalitis aguda, no especificada", sub: "Presuntivo" }] },
    {
      title: "Documentos",
      items: [
        {
          from: 6,
          text: "Descanso médico · 3 días desde hoy",
          sub: step >= 9 ? "Firmado por la Dra. Vela · CMP 045678" : "Listo para emitir con tu firma",
          doc: true,
        },
      ],
    },
  ]

  const banner = dictating
    ? { title: "Dictando…", sub: "Habla como le contarías a un colega." }
    : step === 7
      ? { title: "Dictado terminado: 5 sugerencias", sub: "4 listas. Todavía no hay nada en la historia." }
      : step === 8
        ? { title: "4 confirmadas", sub: "Falta emitir el descanso médico: se emite con tu firma." }
        : { title: "Todo en la historia", sub: "Descanso médico emitido. Falta solo «Finalizar y firmar»." }

  return (
    <div className="lcd">
      <div className="lcd-top">
        <span className="lcd-who">
          <span className="lcd-crumbs">Pacientes › Rosa Paredes Luna › Atención</span>
          <b>Rosa Paredes Luna</b>
          <span className="lcd-meta">46 años · inicio 09:04 · Dra. Elena Vela</span>
        </span>
        <span className="lcd-saved">{step >= 8 ? "Guardado 09:16" : "Guardado 09:12"}</span>
      </div>

      <div className="lcd-bar">
        <div className="lcd-bar-head">
          <span className="lcd-mic" aria-hidden="true">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </span>
          <span className="lcd-bar-text" role="status">
            <b>{banner.title}</b>
            <span>{banner.sub}</span>
          </span>
          {dictating && (
            <span className="lcd-rec" aria-hidden="true">
              <i />
              REC
            </span>
          )}
        </div>
        {dictating && (
          <div className="lcd-heard">
            <span className="lcd-wave" aria-hidden="true">
              {Array.from({ length: 18 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: barras fijas de la onda, sin datos
                <i key={i} />
              ))}
            </span>
            <span className="lcd-quote">{HEARD[Math.min(step, 6)]}</span>
          </div>
        )}
        {step === 7 && (
          <div className="lcd-bulk" aria-hidden="true">
            <span className="lcd-btn p">Confirmar las 4 listas</span>
            <span className="lcd-btn g">Seguir dictando</span>
          </div>
        )}
      </div>

      {blocks.map((block) => {
        const items = block.items.filter((item) => step >= item.from)
        const open = items.filter((item) => !(item.doc ? step >= 9 : confirmed)).length
        return (
          <div key={block.title} className="lcd-block">
            <div className="lcd-block-head">
              <b>{block.title}</b>
              <span>{items.length === 0 ? "Sin sugerencias" : open === 0 ? "En la historia" : `${open} ${open === 1 ? "sugerencia" : "sugerencias"}`}</span>
            </div>
            {items.map((item) => {
              const done = item.doc ? step >= 9 : confirmed
              return (
                <div key={item.text.slice(0, 14)} className={`lcd-item${done ? " done" : ""}${step === item.from ? " new" : ""}`}>
                  <span className="lcd-item-text">
                    <span>{item.text}</span>
                    <span className={item.corrected ? "lcd-sub fixed" : "lcd-sub"}>{item.sub}</span>
                  </span>
                  <span className="lcd-actions" aria-hidden={done ? undefined : true}>
                    {done ? (
                      <span className="lcd-btn ok">{item.doc ? "Emitido y firmado" : "Confirmado"}</span>
                    ) : item.doc ? (
                      <span className="lcd-btn p">Emitir descanso</span>
                    ) : (
                      <>
                        <span className="lcd-btn p">Confirmar</span>
                        <span className="lcd-btn g">Editar</span>
                      </>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
      <span className="lcd-note">Demostración con datos de ejemplo.</span>
    </div>
  )
}
