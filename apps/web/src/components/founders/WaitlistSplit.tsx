// «Pide tus USD 100» (Fundadores, issue 165; lienzo, tableros 2 y 3): a la izquierda la marca sobre
// la noche, con las 32 piezas de la portada y la acción de un agente, como entrar y crear cuenta; a la
// derecha la solicitud. Al enviarla, la misma pantalla dice qué sigue. La solicitud va a la ruta
// pública de la API (excepción a ADR 0046, como el Libro de Reclamaciones). Cada error, también lo que
// rechaza el servidor, va bajo su campo y el foco al primero.
import { AGENTS, CalmPulseScene, CalmToothScene, type DayEvent } from "@odentia/brand-scene"
import { useForm, useStore } from "@tanstack/react-form"
import { type SyntheticEvent, useEffect, useState } from "react"
import {
  applyRejection,
  clearRejection,
  EMAIL,
  fieldError,
  focusFirstInvalid,
  PHONE,
  rejectionOf,
  SubmitRejected,
} from "../../lib/form"
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

/** Los campos se llaman como en el cuerpo de la API: lo que rechaza el servidor cae en su campo. */
type Values = {
  firstName: string
  lastName: string
  email: string
  countryCode: string
  city: string
  phone: string
  clinicName: string
  professionals: string
  currentTool: string
}
type Field = keyof Values

const EMPTY: Values = {
  firstName: "",
  lastName: "",
  email: "",
  countryCode: "",
  city: "",
  phone: "",
  clinicName: "",
  professionals: "",
  currentTool: "",
}

const SAVE_FAILED = "No pudimos guardar tu solicitud. Intenta nuevamente."

/** El celular como lo recibe el servidor: con el prefijo del país, salvo que ya lo traiga. */
function fullPhone(phone: string, countryCode: string): string {
  const raw = phone.trim()
  const dial = COUNTRIES.find(([code]) => code === countryCode)?.[2]
  return raw.startsWith("+") || !dial ? raw : `+${dial} ${raw}`
}

/** Mismas reglas que el servidor (`waitlistInputSchema`, saas-founders.ts); el servidor vuelve a validar. */
function validate(v: Values): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {}
  if (!v.firstName.trim()) e.firstName = "Escribe tu nombre"
  if (!v.lastName.trim()) e.lastName = "Escribe tus apellidos"
  if (!v.email.trim()) e.email = "Escribe tu correo"
  else if (!EMAIL.test(v.email.trim())) e.email = "Escribe un correo válido, como nombre@clinica.com"
  if (!v.countryCode) e.countryCode = "Elige el país"
  if (!v.city.trim()) e.city = "Escribe la ciudad"
  const phone = fullPhone(v.phone, v.countryCode)
  if (!v.phone.trim()) e.phone = "Escribe tu celular"
  else if (!PHONE.test(phone))
    e.phone =
      /^\+?[0-9][0-9 ()-]*$/.test(phone) && phone.length > 21
        ? "El celular es demasiado largo; escríbelo sin el código del país"
        : "Escribe un celular válido, solo con números"
  if (!v.clinicName.trim())
    e.clinicName = MEDICAL ? "Escribe el nombre del consultorio" : "Escribe el nombre de la clínica"
  if (!v.professionals) e.professionals = `Elige cuántos ${MEDICAL ? "médicos" : "odontólogos"} atienden`
  if (!v.currentTool) e.currentTool = "Elige qué usan hoy"
  return e
}

/** Atributos de un campo: id, nombre y su error, si lo tiene. */
function a11y(field: Field, error: string | undefined) {
  return {
    id: `wl-${field}`,
    name: field,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `wl-${field}-error` : undefined,
  }
}

function FieldError({ field, message }: { field: Field; message: string | undefined }) {
  if (!message) return null
  return (
    <p className="wl-field-error" id={`wl-${field}-error`}>
      {message}
    </p>
  )
}

export default function WaitlistSplit({ logo, gift, discountPercent, noFee, answerDays }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [work, setWork] = useState<DayEvent | null>(null)

  const form = useForm({
    defaultValues: EMPTY,
    validators: {
      // Al enviar; corregir un campo retira su mensaje al momento. Los campos no llaman a
      // `handleBlur`: en TanStack Form salir de un campo borra el error del envío aunque siga mal.
      onSubmit: ({ value }) => {
        const fields = validate(value)
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const body = {
        firstName: value.firstName.trim(),
        lastName: value.lastName.trim(),
        email: value.email.trim(),
        phone: fullPhone(value.phone, value.countryCode),
        clinicName: value.clinicName.trim(),
        countryCode: value.countryCode,
        city: value.city.trim(),
        professionals: value.professionals,
        currentTool: value.currentTool,
      }
      let res: Response
      try {
        res = await fetch(waitlistApiUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      } catch {
        throw new SubmitRejected(
          "No hay conexión. Revisa tu internet e intenta nuevamente; lo que escribiste sigue aquí.",
        )
      }
      const payload = (await res.json().catch(() => null)) as {
        data?: { answerDays?: number }
        answerDays?: number
      } | null
      // Un 400 dice en `fields` qué dato rechazó: cada uno va a su campo.
      if (!res.ok) throw rejectionOf(payload, SAVE_FAILED)
      setSent({
        firstName: body.firstName,
        clinicName: body.clinicName,
        phone: body.phone,
        email: body.email,
        answerDays: payload?.data?.answerDays ?? payload?.answerDays ?? answerDays,
      })
      window.scrollTo({ top: 0 })
    },
  })
  const country = useStore(form.store, (state) => state.values.countryCode)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const dial = COUNTRIES.find(([code]) => code === country)?.[2]
  // El país del dispositivo se propone al cargar (en el servidor no se sabe); se puede cambiar.
  useEffect(() => {
    if (!form.getFieldValue("countryCode"))
      form.setFieldValue("countryCode", deviceCountry(), { dontUpdateMeta: true })
  }, [form])

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (form.state.isSubmitting) return
    const root = event.currentTarget
    setError(null)
    clearRejection(form)
    try {
      await form.handleSubmit()
    } catch (rejection) {
      setError(applyRejection(form, rejection, SAVE_FAILED))
    }
    if (!form.state.isSubmitSuccessful) focusFirstInvalid(root)
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
          <form className="wl-card" onSubmit={submit} noValidate>
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
              <form.Field name="firstName">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-firstName">Nombre</label>
                      <input
                        {...a11y("firstName", fieldMessage)}
                        autoComplete="given-name"
                        required
                        maxLength={80}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldError field="firstName" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="lastName">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-lastName">Apellidos</label>
                      <input
                        {...a11y("lastName", fieldMessage)}
                        autoComplete="family-name"
                        required
                        maxLength={80}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldError field="lastName" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="email">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field wl-wide">
                      <label htmlFor="wl-email">Correo</label>
                      <input
                        {...a11y("email", fieldMessage)}
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        required
                        maxLength={254}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldError field="email" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="countryCode">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-countryCode">País</label>
                      <select
                        {...a11y("countryCode", fieldMessage)}
                        required
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="" disabled>
                          Elige el país
                        </option>
                        {COUNTRIES.map(([code, name]) => (
                          <option key={code} value={code}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <FieldError field="countryCode" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="city">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-city">Ciudad</label>
                      <input
                        {...a11y("city", fieldMessage)}
                        autoComplete="address-level2"
                        required
                        maxLength={80}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldError field="city" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="phone">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field wl-wide-sm">
                      <label htmlFor="wl-phone">Celular (WhatsApp)</label>
                      <span className="wl-phone">
                        {dial ? <span className="mono wl-dial">+{dial}</span> : null}
                        <input
                          {...a11y("phone", fieldMessage)}
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel-national"
                          required
                          maxLength={20}
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </span>
                      <FieldError field="phone" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="clinicName">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field wl-wide-sm">
                      <label htmlFor="wl-clinicName">{MEDICAL ? "Nombre del consultorio" : "Nombre de la clínica"}</label>
                      <input
                        {...a11y("clinicName", fieldMessage)}
                        autoComplete="organization"
                        required
                        maxLength={120}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <FieldError field="clinicName" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="professionals">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-professionals">{MEDICAL ? "Médicos que atienden" : "Odontólogos que atienden"}</label>
                      <select
                        {...a11y("professionals", fieldMessage)}
                        required
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="" disabled>
                          Elige
                        </option>
                        {PROFESSIONALS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <FieldError field="professionals" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
              <form.Field name="currentTool">
                {(field) => {
                  const fieldMessage = fieldError(field.state.meta)
                  return (
                    <div className="wl-field">
                      <label htmlFor="wl-currentTool">Qué usan hoy</label>
                      <select
                        {...a11y("currentTool", fieldMessage)}
                        required
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="" disabled>
                          Elige
                        </option>
                        {TOOLS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <FieldError field="currentTool" message={fieldMessage} />
                    </div>
                  )
                }}
              </form.Field>
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
