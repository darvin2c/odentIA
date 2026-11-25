// Las plantillas de una guía y el aviso al descargar (lienzo, tablero 3; acta de la mesa del 24 nov):
// el PDF baja sin pedir nada. Recién al tocarlo aparece, debajo, «Se está descargando · ¿No bajó?
// Ábrelo aquí» y, con Fundadores, el correo opcional: le llegan las plantillas adjuntas con la puerta
// para pedir entrar (`POST /api/public/founders/contact`, ADR 0215). Con el alta abierta no se pide
// nada: el botón de toda la web. Los estados van en la misma caja, del alto del más alto, y un
// segundo PDF no vuelve a pedir el correo. Nunca dice si ese correo ya pidió entrar, y si no se
// sabe si el correo salió no invita a reintentarlo: el servidor no lo manda dos veces.
import { type FormEvent, useEffect, useRef, useState } from "react"
import { EMAIL } from "../../lib/form"
import "./guide-downloads.css"

type Sheet = { sheet: string; label: string; detail: string; href: string }

type Props = {
  sheets: Sheet[]
  /** La guía: «/guias/como-llenar-un-odontograma». */
  page: string
  /** «correo» con Fundadores; «boton» con el alta abierta, que lleva al de toda la web. */
  ask: "correo" | "boton"
  cta: { href: string; label: string }
  contactUrl: string
}

/**
 * Lo que pasó con el correo: lo que se ve en la caja del aviso. «recent»: ese buzón ya las
 * pidió hoy; «doubt»: no se pudo confirmar que salió.
 */
type Phase = "form" | "sending" | "sent" | "recent" | "doubt"

const FAILED = "No pudimos enviarte el correo. Intenta nuevamente en unos minutos; tus plantillas ya bajaron."
const BUSY = "Ahora no pudimos enviarlo: hay muchos pedidos. Prueba de nuevo en unos minutos; tus plantillas ya bajaron."

/** Lo que se dice bajo el campo: un error del correo (`field`) o algo que no es suyo. */
type Problem = { text: string; field: boolean }

const ERROR_ID = "gd-email-error"

export default function GuideDownloads({ sheets, page, ask, cta, contactUrl }: Props) {
  const [downloaded, setDownloaded] = useState<Sheet | null>(null)
  const [phase, setPhase] = useState<Phase>("form")
  const [email, setEmail] = useState("")
  const [sentTo, setSentTo] = useState("")
  const [error, setError] = useState<Problem | null>(null)
  const [trap, setTrap] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const doneRef = useRef<HTMLParagraphElement | null>(null)
  const changing = useRef(false)

  // Al cambiar de estado, el foco va a lo que hay que leer o escribir: nunca queda perdido.
  useEffect(() => {
    if (phase === "sent" || phase === "recent" || phase === "doubt") doneRef.current?.focus()
    else if (phase === "form" && changing.current) {
      changing.current = false
      inputRef.current?.focus()
    }
  }, [phase])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (phase === "sending") return
    const value = email.trim()
    if (!value) {
      setError({ text: "Escribe tu correo", field: true })
      inputRef.current?.focus()
      return
    }
    if (!EMAIL.test(value)) {
      setError({ text: "Escribe un correo válido, como nombre@clinica.com", field: true })
      inputRef.current?.focus()
      return
    }
    setError(null)
    setPhase("sending")
    let res: Response
    try {
      res = await fetch(contactUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value, page, sheets: sheets.map((item) => item.sheet), website: trap }),
      })
    } catch {
      setPhase("form")
      setError({ text: "No hay conexión. Revisa tu internet e intenta nuevamente.", field: false })
      return
    }
    const payload = (await res.json().catch(() => null)) as {
      sent?: boolean
      reason?: string
      error?: { code?: string; message?: string; fields?: Record<string, string> }
    } | null
    const done: Phase | null =
      res.ok && payload?.sent
        ? "sent"
        : res.ok && payload?.reason === "reciente"
          ? "recent"
          : payload?.error?.code === "MAIL_UNCONFIRMED"
            ? "doubt"
            : null
    if (done) {
      setSentTo(value)
      setPhase(done)
      return
    }
    setPhase("form")
    // Un correo que el servidor rechaza es del campo; un tope o un error no son de la persona: no
    // se marcan en el campo ni lo llevan ahí (lo que escribió está bien, y sus plantillas, bajadas).
    const rejected = payload?.error?.fields?.email
    if (rejected) {
      setError({ text: rejected, field: true })
      inputRef.current?.focus()
      return
    }
    setError({ text: res.status === 429 ? BUSY : FAILED, field: false })
  }

  // Al tocar un PDF, el aviso que aparece debajo queda a la vista.
  const noticeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (downloaded) noticeRef.current?.scrollIntoView({ block: "nearest" })
  }, [downloaded])

  // En el teléfono el error queda bajo el botón: se trae a la vista cuando aparece.
  useEffect(() => {
    if (error) document.getElementById(ERROR_ID)?.scrollIntoView({ block: "nearest" })
  }, [error])

  function change() {
    changing.current = true
    setPhase("form")
  }

  const showForm = phase === "form" || phase === "sending"
  const errorId = ERROR_ID
  return (
    <div className="gd">
      <div className="gd-cards">
        {sheets.map((item) => (
          <a key={item.sheet} className="gd-card" href={item.href} download onClick={() => setDownloaded(item)}>
            <span className="gd-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v11" />
                <path d="M7 10l5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
            </span>
            <span className="gd-what">
              <b>{item.label}</b>
              <span>{item.detail}</span>
            </span>
          </a>
        ))}
      </div>
      <p className="gd-free">Descarga directa, sin pedir tu correo.</p>
      {downloaded ? (
        <div className="gd-notice" ref={noticeRef}>
          <p className="gd-status" role="status">
            Se está descargando «{downloaded.label}».{" "}
            <a href={downloaded.href} target="_blank" rel="noopener">
              ¿No bajó? Ábrelo aquí
            </a>
          </p>
          {ask === "boton" ? (
            <div className="gd-offer">
              <p>¿Tienes una clínica? En odentIA lo llenas sin papel.</p>
              <a className="btn btn-d btn-sm" href={cta.href}>
                {cta.label}
              </a>
            </div>
          ) : (
            <div className="gd-stage">
              <form className="gd-form" onSubmit={submit} noValidate inert={!showForm} aria-hidden={!showForm}>
                <p>¿Tienes una clínica? Déjanos tu correo y te mostramos cómo llenarlo sin papel.</p>
                <div className="gd-row">
                  <label className="gd-field">
                    <span>Tu correo (opcional)</span>
                    <input
                      ref={inputRef}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      maxLength={254}
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        if (error) setError(null)
                      }}
                      aria-invalid={error?.field ? true : undefined}
                      aria-describedby={error ? errorId : undefined}
                    />
                  </label>
                  <button className="btn btn-d btn-sm" type="submit" aria-disabled={phase === "sending" ? true : undefined}>
                    {phase === "sending" ? "Enviando…" : "Quiero verlo"}
                  </button>
                </div>
                {/* Solo para quien no ve la página: una persona no lo llena. */}
                <label className="gd-trap" aria-hidden="true">
                  Tu sitio web
                  <input tabIndex={-1} autoComplete="off" value={trap} onChange={(event) => setTrap(event.target.value)} />
                </label>
                <p className="gd-error" id={errorId} role="alert">
                  {error?.text ?? ""}
                </p>
              </form>
              {showForm ? null : (
                <div className="gd-done">
                  <p ref={doneRef} tabIndex={-1}>
                    {phase === "sent" ? (
                      <>
                        <b>Listo, te escribimos a {sentTo}.</b> En unos minutos te llegan las plantillas de esta guía en PDF y cómo se hace en odentIA.
                      </>
                    ) : phase === "recent" ? (
                      <>
                        <b>Hoy ya pediste las plantillas para {sentTo}.</b> Si no las ves, revisa la carpeta de spam.
                      </>
                    ) : (
                      <>
                        <b>No pudimos confirmar que salió el correo a {sentTo}.</b> Si no te llega en unos minutos,
                        las plantillas están aquí arriba.
                      </>
                    )}
                  </p>
                  <button type="button" className="gd-change" onClick={change}>
                    Cambiar correo
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
