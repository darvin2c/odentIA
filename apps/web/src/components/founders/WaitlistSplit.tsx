// «Pide tus USD 100» (Fundadores, issue 165; lienzo, tableros 2 y 3): a la izquierda la marca sobre
// la noche, con las 32 piezas de la portada y la acción de un agente, como entrar y crear cuenta; a la
// derecha la solicitud. Al enviarla, la misma pantalla dice qué sigue. La solicitud va a la ruta
// pública de la API (excepción a ADR 0046, como el Libro de Reclamaciones).
import { AGENTS, CalmPulseScene, CalmToothScene, type DayEvent } from "@odentia/brand-scene"
import { type SyntheticEvent, useEffect, useState } from "react"
import { businessDays } from "../../lib/pricing"
import { MEDICAL, WORDS } from "../../lib/product"
import { waitlistApiUrl } from "../../lib/site"
import "./waitlist.css"

type Props = {
  /** El logotipo claro de la marca (SVG): la página no lleva cabecera y el logo va en el lado oscuro. */
  logo: string
  /** El regalo del plan Fundadores («USD 100»); null si el plan no tiene saldo de prueba. */
  gift: string | null
  discountPercent: number | null
  noFee: boolean
  /** Días hábiles para responder: las condiciones comerciales que rigen. */
  answerDays: number
}

/** Países de habla hispana primero; el código es ISO 3166-1 alfa-2 y el prefijo, E.164. */
const COUNTRIES: [code: string, name: string, dial: string][] = [
  ["AR", "Argentina", "54"],
  ["BO", "Bolivia", "591"],
  ["CL", "Chile", "56"],
  ["CO", "Colombia", "57"],
  ["CR", "Costa Rica", "506"],
  ["EC", "Ecuador", "593"],
  ["SV", "El Salvador", "503"],
  ["ES", "España", "34"],
  ["US", "Estados Unidos", "1"],
  ["GT", "Guatemala", "502"],
  ["HN", "Honduras", "504"],
  ["MX", "México", "52"],
  ["NI", "Nicaragua", "505"],
  ["PA", "Panamá", "507"],
  ["PY", "Paraguay", "595"],
  ["PE", "Perú", "51"],
  ["PR", "Puerto Rico", "1"],
  ["DO", "República Dominicana", "1"],
  ["UY", "Uruguay", "598"],
  ["VE", "Venezuela", "58"],
]
const PROFESSIONALS: [string, string][] = [
  ["1", "1"],
  ["2-3", "2 a 3"],
  ["4-9", "4 a 9"],
  ["10+", "10 o más"],
]
const TOOLS: [string, string][] = [
  ["nada", "Nada todavía"],
  ["cuaderno_excel", "Cuaderno o Excel"],
  ["otro_software", "Otro software"],
]

/** El país del dispositivo, si está en la lista; si no, ninguno (se elige). */
function deviceCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? ""
    return COUNTRIES.some(([code]) => code === region) ? region : ""
  } catch {
    return ""
  }
}

type Sent = { firstName: string; clinicName: string; phone: string; email: string; answerDays: number }

export default function WaitlistSplit({ logo, gift, discountPercent, noFee, answerDays }: Props) {
  const [country, setCountry] = useState("")
  // El país del dispositivo se propone al cargar (en el servidor no se sabe); se puede cambiar.
  useEffect(() => setCountry((current) => current || deviceCountry()), [])
  const dial = COUNTRIES.find(([code]) => code === country)?.[2]
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [work, setWork] = useState<DayEvent | null>(null)

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const data = new FormData(event.currentTarget)
    const value = (name: string) => String(data.get(name) ?? "").trim()
    const rawPhone = value("phone")
    const phone = rawPhone.startsWith("+") || !dial ? rawPhone : `+${dial} ${rawPhone}`
    const body = {
      firstName: value("firstName"),
      lastName: value("lastName"),
      email: value("email"),
      phone,
      clinicName: value("clinicName"),
      countryCode: country,
      city: value("city"),
      professionals: value("professionals"),
      currentTool: value("currentTool"),
    }
    setPending(true)
    setError(null)
    try {
      const res = await fetch(waitlistApiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string }; data?: { answerDays?: number }; answerDays?: number }
      if (!res.ok) {
        setError(payload.error?.message ?? "No pudimos guardar tu solicitud. Intenta nuevamente.")
        return
      }
      setSent({
        firstName: body.firstName,
        clinicName: body.clinicName,
        phone: body.phone,
        email: body.email,
        answerDays: payload.data?.answerDays ?? payload.answerDays ?? answerDays,
      })
      window.scrollTo({ top: 0 })
    } catch {
      setError("No hay conexión. Revisa tu internet e intenta nuevamente; lo que escribiste sigue aquí.")
    } finally {
      setPending(false)
    }
  }

  const agent = work ? AGENTS[work.agent] : null
  return (
    <div className="wl">
      <aside className="wl-aside">
        <div className="wl-aside-copy">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: el logotipo es un SVG propio del repositorio. */}
          <a className="wl-logo" href="/" aria-label={`${WORDS.name}, inicio`} dangerouslySetInnerHTML={{ __html: logo }} />
          {sent ? (
            <>
              <span className="mono wl-tag">[ Solicitud recibida ]</span>
              <p className="wl-title">
                Listo, {sent.firstName}.<br />
                <span className="wl-accent">{sent.clinicName} está en la lista.</span>
              </p>
            </>
          ) : (
            <>
              <span className="mono wl-tag">[ Programa Fundadores ]</span>
              <h1 className="wl-title">
                {gift ? (
                  <>
                    Los primeros <span className="gift wl-gift">{gift}</span> los pagamos nosotros.
                  </>
                ) : (
                  `Tu lugar en ${WORDS.name}.`
                )}
                <br />
                <span className="wl-accent">Tus agentes empiezan hoy.</span>
              </h1>
              <ul className="wl-chips">
                {noFee ? <li>Sin cuota mensual</li> : null}
                {discountPercent ? (
                  <li>
                    {/* En el teléfono las ventajas van en una línea: «50 % menos». */}
                    <span className="wl-long">Acciones con </span>
                    {discountPercent} % menos
                  </li>
                ) : null}
                <li>Sin tarjeta</li>
              </ul>
            </>
          )}
        </div>
        {/* latidIA: el pulso de su acceso en lugar de las piezas de odentIA. */}
        {MEDICAL ? <CalmPulseScene className="wl-scene" /> : <CalmToothScene className="wl-scene" onWork={setWork} />}
        {agent && work ? (
          <div className="wl-work">
            <span className="wl-dot" style={{ background: agent.color }} aria-hidden="true" />
            <strong>{agent.name}</strong>
            <span className="wl-what">{work.text}</span>
            <span className="mono wl-time">{work.time}</span>
          </div>
        ) : null}
      </aside>

      <div className="wl-main">
        {sent ? (
          <div className="wl-card" aria-live="polite">
            <h2 className="wl-h">Qué sigue</h2>
            <ol className="wl-steps">
              <li>Revisamos tu solicitud en {businessDays(sent.answerDays)}.</li>
              <li>Te escribimos por WhatsApp al {sent.phone} para una llamada corta.</li>
              <li>Te llega tu invitación por correo y abres {WORDS.yourClinic} como Fundadora.</li>
            </ol>
            <p className="wl-note">Te enviamos una copia a {sent.email}. Si te equivocaste en un dato, responde ese correo.</p>
            <a className="btn btn-g wl-back" href="/">
              Volver al inicio
            </a>
          </div>
        ) : (
          <form className="wl-card" onSubmit={submit} noValidate={false}>
            <h2 className="wl-h">
              {gift ? (
                <>
                  Pide tus <span className="gift-light">{gift}</span>
                </>
              ) : (
                "Pide tu invitación"
              )}
            </h2>
            <p className="wl-note">Mientras dure el programa, se entra por invitación. Te respondemos en {businessDays(answerDays)}.</p>
            <div className="wl-grid">
              <div className="wl-field">
                <label htmlFor="wl-firstName">Nombre</label>
                <input id="wl-firstName" name="firstName" autoComplete="given-name" required maxLength={80} />
              </div>
              <div className="wl-field">
                <label htmlFor="wl-lastName">Apellidos</label>
                <input id="wl-lastName" name="lastName" autoComplete="family-name" required maxLength={80} />
              </div>
              <div className="wl-field wl-wide">
                <label htmlFor="wl-email">Correo</label>
                <input id="wl-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} />
              </div>
              <div className="wl-field">
                <label htmlFor="wl-countryCode">País</label>
                <select id="wl-countryCode" name="countryCode" required value={country} onChange={(event) => setCountry(event.target.value)}>
                  <option value="" disabled>
                    Elige el país
                  </option>
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wl-field">
                <label htmlFor="wl-city">Ciudad</label>
                <input id="wl-city" name="city" autoComplete="address-level2" required maxLength={80} />
              </div>
              <div className="wl-field wl-wide-sm">
                <label htmlFor="wl-phone">Celular (WhatsApp)</label>
                <span className="wl-phone">
                  {dial ? <span className="mono wl-dial">+{dial}</span> : null}
                  <input id="wl-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" required minLength={6} maxLength={20} />
                </span>
              </div>
              <div className="wl-field wl-wide-sm">
                <label htmlFor="wl-clinicName">{MEDICAL ? "Nombre del consultorio" : "Nombre de la clínica"}</label>
                <input id="wl-clinicName" name="clinicName" autoComplete="organization" required maxLength={120} />
              </div>
              <div className="wl-field">
                <label htmlFor="wl-professionals">{MEDICAL ? "Médicos que atienden" : "Odontólogos que atienden"}</label>
                <select id="wl-professionals" name="professionals" required defaultValue="">
                  <option value="" disabled>
                    Elige
                  </option>
                  {PROFESSIONALS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wl-field">
                <label htmlFor="wl-currentTool">Qué usan hoy</label>
                <select id="wl-currentTool" name="currentTool" required defaultValue="">
                  <option value="" disabled>
                    Elige
                  </option>
                  {TOOLS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="wl-legal">
              Usamos estos datos solo para responder tu solicitud. <a href="/privacidad">Aviso de privacidad</a>.
            </p>
            {error ? (
              <p className="wl-error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="btn btn-p wl-submit" type="submit" disabled={pending}>
              {pending ? "Enviando…" : gift ? `Quiero mis ${gift}` : "Solicitar invitación"}
            </button>
            <p className="wl-note wl-center">¿Te invitó una clínica a su equipo? Abre el enlace de tu correo.</p>
          </form>
        )}
      </div>
    </div>
  )
}
