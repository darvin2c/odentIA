// El descanso médico de Rosa (lienzo de latidIA, tablero «Receta»): eliges los días (1 a 365) y si
// la persona autoriza que figure el diagnóstico; al emitirlo sale numerado y firmado y se le envía
// por su canal; no se corrige: se anula con motivo y se emite uno nuevo, con otro número.
import { useEffect, useRef, useState } from "react"
import "./sick-leave-demo.css"

type Doc = "draft" | "emitted" | "annulled"

const MIN_DAYS = 1
const MAX_DAYS = 365
/** dd/mm/aaaa, como en la constancia. */
const dmy = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`

export default function SickLeaveDemo() {
  const [days, setDays] = useState(3)
  const [auth, setAuth] = useState(false)
  const [doc, setDoc] = useState<Doc>("draft")
  const [number, setNumber] = useState(1)
  const locked = doc !== "draft"

  // El botón que se tocó cambia por otro: el foco pasa al nuevo (no al montar).
  const nextFocus = useRef<HTMLButtonElement>(null)
  const acted = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se mueve el foco cada vez que cambia el estado del documento.
  useEffect(() => {
    if (acted.current) nextFocus.current?.focus()
  }, [doc])
  const go = (next: Doc) => {
    acted.current = true
    setDoc(next)
  }

  // Desde el sábado 24 de octubre de 2026, el día de la demo.
  const from = new Date(2026, 9, 24)
  const to = new Date(2026, 9, 24 + days - 1)
  const plural = days === 1 ? "1 día de descanso" : `${days} días de descanso`
  const range = days === 1 ? `${plural}, el ${dmy(from)}` : `${plural}, del ${dmy(from)} al ${dmy(to)}`

  return (
    <div className="sl">
      <div className="sl-form">
        <span className="sl-head">
          <b>Emitir descanso médico</b>
          <span>Queda firmado con tu perfil profesional. No se corrige: se anula con motivo.</span>
        </span>
        <span className="sl-field">
          <span className="sl-label">Desde</span>
          <span className="sl-pill">Sáb 24 oct 2026</span>
        </span>
        <fieldset className="sl-field" disabled={locked}>
          <legend className="sl-label">Días</legend>
          <span className="sl-step">
            <button type="button" aria-label="Un día menos" disabled={days <= MIN_DAYS} onClick={() => setDays((d) => Math.max(MIN_DAYS, d - 1))}>
              −
            </button>
            <span className="sl-days" aria-live="polite">
              {days}
            </span>
            <button type="button" aria-label="Un día más" disabled={days >= MAX_DAYS} onClick={() => setDays((d) => Math.min(MAX_DAYS, d + 1))}>
              +
            </button>
          </span>
          <span className="sl-range">{range}.</span>
        </fieldset>
        {/* En el teléfono no se muestra: la constancia de al lado ya lo dice, y así los días y el documento
            caben en una pantalla. */}
        <span className="sl-field sl-indic">
          <span className="sl-label">Indicaciones (opcional)</span>
          <span className="sl-box">Reposo relativo, sin esfuerzo físico</span>
        </span>
        <button type="button" className="sl-auth" aria-pressed={auth} disabled={locked} onClick={() => setAuth((a) => !a)}>
          <span className={`sl-check${auth ? " on" : ""}`} aria-hidden="true">
            {auth ? "✓" : ""}
          </span>
          <span className="sl-auth-t">
            <b>La persona autoriza que el diagnóstico figure</b>
            <span>Sin su autorización, el diagnóstico no va en la constancia ni se guarda en ella.</span>
          </span>
        </button>
        <div className="sl-actions">
          {doc === "draft" && (
            <button ref={nextFocus} type="button" className="sl-btn main" onClick={() => go("emitted")}>
              Emitir descanso médico
            </button>
          )}
          {doc === "emitted" && (
            <button ref={nextFocus} type="button" className="sl-btn grey" onClick={() => go("annulled")}>
              Anular descanso médico
            </button>
          )}
          {doc === "annulled" && (
            <button
              ref={nextFocus}
              type="button"
              className="sl-btn main"
              onClick={() => {
                setNumber((n) => n + 1)
                go("draft")
              }}
            >
              Emitir uno nuevo
            </button>
          )}
        </div>
      </div>

      <div className="sl-out">
        <div className={`sl-paper${doc === "annulled" ? " void" : ""}`}>
          <div className="sl-ptop">
            <span className="sl-pt">
              <span className="sl-org">CONSULTORIO SAN MARTÍN · AV. PERÚ 1820</span>
              <b>{doc === "draft" ? "Descanso médico · borrador" : `Descanso médico N.º ${number}`}</b>
            </span>
            <span className={`sl-badge ${doc}`}>{doc === "draft" ? "Sin emitir" : doc === "emitted" ? "Emitido" : "Anulado"}</span>
          </div>
          <span className="sl-p">
            <b>Rosa Paredes Luna</b> · 46 años
          </span>
          <span className="sl-p strong">{range.charAt(0).toUpperCase() + range.slice(1)}.</span>
          <span className={`sl-p${auth ? " dx" : " nodx"}`}>
            {auth ? "Diagnóstico: J03.9 Amigdalitis aguda." : "Sin diagnóstico: la persona no autorizó que figure."}
          </span>
          <span className="sl-p">Reposo relativo, sin esfuerzo físico</span>
          <span className="sl-sign">
            {doc === "draft"
              ? "Se firma al emitir: Elena Vela · médico cirujano · CMP 045678"
              : "Emitido el 24/10/2026 por Elena Vela · CMP 045678"}
          </span>
        </div>
        <div className={`sl-sent ${doc}`} aria-live="polite">
          <span className="sl-wa" aria-hidden="true">
            W
          </span>
          <span className="sl-st">
            <b>
              {doc === "draft" ? "Al emitirlo, lo envías" : doc === "emitted" ? "Enviado a Rosa por WhatsApp · 10:59" : "Anulado con motivo"}
            </b>
            <span>
              {doc === "draft"
                ? "Como PDF, por WhatsApp o por correo. También puedes imprimirlo."
                : doc === "emitted"
                  ? "También puedes imprimirlo."
                  : "Motivo: los días no eran los correctos. Emite uno nuevo con otro número."}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}
