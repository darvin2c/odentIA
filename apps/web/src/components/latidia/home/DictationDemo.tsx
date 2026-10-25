// La portada de latidIA (lienzo «Inicio», sección 1): la Dra. Vela dicta la consulta de Rosa sobre
// la línea de pulso «72 lpm» y Clío propone cada cosa en su bloque; la temperatura se corrige por
// voz y al final la doctora confirma las cinco listas. El descanso no se confirma: se emite aparte.
// Se repite en bucle con «Pausar» y «Repetir»; sin movimiento se ve el final.
import { useState } from "react"
import { useLoop } from "./loop"
import "./dictation-demo.css"

/** Lo que dice la doctora en cada paso (el 0 es antes de dictar; el 7 y el 8, el final). */
const PHRASES = [
  "",
  "«Viene por fiebre y dolor de garganta hace tres días.»",
  "«Presión 118 sobre 76, frecuencia 96, temperatura 38,5.»",
  "«Amígdalas aumentadas, con placas blanquecinas.»",
  "«Amigdalitis aguda, presuntivo.»",
  "«Le doy descanso de tres días.»",
  "«No, la temperatura es 38,4.»",
]

/** Cada bloque de la atención, desde qué paso tiene su sugerencia y cuántas. */
const BLOCKS = [
  { title: "Consulta", at: 1, n: 2, text: "Motivo: fiebre y dolor de garganta · 3 días de enfermedad" },
  { title: "Examen físico", at: 2, n: 1, text: "PA 118/76 mmHg · FC 96 lpm · T ", vitals: true },
  { title: "Boca y garganta", at: 3, n: 1, text: "Con hallazgos: amígdalas aumentadas con placas blanquecinas" },
  { title: "Diagnóstico", at: 4, n: 1, text: "J03.9 · Amigdalitis aguda · Presuntivo" },
  { title: "Documentos", at: 5, n: 1, text: "Descanso médico · 3 días desde hoy", doc: true },
]

/** La misma línea de pulso que la marca: tres latidos a 72 por minuto. */
const ECG =
  "M0 50 L40 50 Q48 42 56 50 L76 50 L84 58 L92 8 L100 72 L108 50 L128 50 Q142 36 156 50 L200 50 L240 50 Q248 42 256 50 L276 50 L284 58 L292 8 L300 72 L308 50 L328 50 Q342 36 356 50 L400 50 L440 50 Q448 42 456 50 L476 50 L484 58 L492 8 L500 72 L508 50 L528 50 Q542 36 556 50 L600 50"

export default function DictationDemo() {
  const [paused, setPaused] = useState(false)
  const { step, restart } = useLoop({ len: 9, hold: 3, ms: 1900, paused })
  const fixed = step >= 6
  const done = step >= 8
  const listening = step < 7

  let count = 0
  const rows = BLOCKS.map((block) => {
    const has = step >= block.at
    if (has) count += block.n
    return { ...block, has, confirmed: done && !block.doc }
  })

  const status = step === 0 ? "Clío está escuchando" : listening ? "Dictando…" : done ? "Confirmado" : "Dictado terminado"
  const heard = step === 0 ? "Toca «Dictar» y atiende como siempre." : step >= 7 ? "Dictado terminado: 6 sugerencias." : PHRASES[step]
  const before = step >= 2 && step <= 7 ? PHRASES[Math.min(step, 6) - 1] : ""
  const headTitle = done
    ? "5 confirmadas · ya están en la historia"
    : step >= 7
      ? "Dictado terminado: 6 sugerencias"
      : `Clío propone · ${count} ${count === 1 ? "sugerencia" : "sugerencias"}`
  const headSub = done ? "El descanso se emite aparte, con tu firma." : step >= 7 ? "5 listas. Todavía no hay nada en la historia." : "Cada cosa cae en su bloque."

  return (
    <figure className="ld" aria-label="Demostración: Clío ordena la consulta que dicta la Dra. Vela">
      <div className="ld-top">
        <span className="ld-who">
          <span className="ld-wide">Consulta de Rosa Paredes · Dra. Elena Vela</span>
          <span className="ld-narrow">Rosa · Dra. Vela</span>
        </span>
        <span className={`ld-status${listening ? " live" : ""}`}>
          <i className="ld-blink" aria-hidden="true"></i>
          <span>{status}</span>
        </span>
      </div>

      <div className="ld-pulse">
        <div className="ld-pulse-head">
          <span className="ld-listen">Clío escucha</span>
          <span className="ld-bpm">
            <span className="ld-heart" aria-hidden="true"></span>
            <b>72</b>
            <span>lpm</span>
          </span>
        </div>
        <svg viewBox="0 0 600 80" preserveAspectRatio="none" aria-hidden="true" className="ld-ecg">
          <path d={ECG} className="ld-ecg-base" vectorEffect="non-scaling-stroke"></path>
          <path d={ECG} className="ld-ecg-line" pathLength={1000} vectorEffect="non-scaling-stroke"></path>
        </svg>
        <div className="ld-words">
          <span className="ld-before">{before}</span>
          <span className="ld-now">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <rect x="5.5" y="1.5" width="5" height="8" rx="2.5"></rect>
              <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"></path>
            </svg>
            <span className={`ld-heard${step === 0 ? " idle" : step >= 7 ? " end" : ""}`}>{heard}</span>
          </span>
        </div>
      </div>

      <div className="ld-app">
        <div className="ld-head">
          <span className="ld-bot" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="5" width="12" height="9" rx="3"></rect>
              <path d="M9 2v3M6.5 9h.01M11.5 9h.01"></path>
            </svg>
          </span>
          <span className="ld-head-copy">
            <b>{headTitle}</b>
            <span>{headSub}</span>
          </span>
          {step >= 7 && <span className={`ld-all${done ? " done" : ""}`}>{done ? "✓ Listo" : "Confirmar las 5 listas"}</span>}
        </div>
        {rows.map((row) => (
          <div className="ld-row" key={row.title}>
            <span className="ld-row-name">
              <b>{row.title}</b>
              <span>{row.has ? (row.confirmed ? "en la historia" : row.n === 2 ? "2 sugerencias" : "1 sugerencia") : "esperando"}</span>
            </span>
            <div className={`ld-box${!row.has ? " empty" : row.confirmed ? " ok" : ""}`}>
              <span className="ld-text">
                {!row.has ? (
                  "Sin sugerencias todavía"
                ) : row.vitals ? (
                  <>
                    {row.text}
                    {fixed && <s>38,5</s>} <span className={fixed ? "ld-fixed" : undefined}>{fixed ? "38,4" : "38,5"}</span> °C
                    {fixed && <span className="ld-voice">corregido por voz</span>}
                  </>
                ) : (
                  row.text
                )}
              </span>
              {row.has && !row.doc && !row.confirmed && (
                <span className="ld-acts">
                  <span className="ld-ok">Confirmar</span>
                  <span className="ld-edit">Editar</span>
                  <span className="ld-tick" aria-hidden="true">✓</span>
                </span>
              )}
              {row.has && row.doc && (
                <span className="ld-emit">
                  <span className="ld-wide">Emitir descanso</span>
                  <span className="ld-narrow">Emitir</span>
                </span>
              )}
              {row.confirmed && (
                <span className="ld-done">
                  <span className="ld-wide">✓ Confirmado</span>
                  <span className="ld-narrow">✓</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="ld-foot">
        <span className="ld-note">Demostración con datos de prueba. Nada entra a la historia hasta que la doctora confirma.</span>
        <span className="ld-btns">
          <button type="button" className="ld-btn" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? "Seguir" : "Pausar"}
          </button>
          <button
            type="button"
            className="ld-btn ld-replay"
            onClick={() => {
              setPaused(false)
              restart()
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M2 7a5 5 0 1 0 1.6-3.7M2 1.5v3h3"></path>
            </svg>
            Repetir
          </button>
        </span>
      </div>
    </figure>
  )
}
