// La solicitud de Fundadores, sus 9 datos (issue 165): la usan la página «Pide tus USD 100» y,
// como sección, el final de cada guía (ADR 0215). Va a la ruta pública de la API (excepción a ADR
// 0046, como el Libro de Reclamaciones). Cada error, también lo que rechaza el servidor, va bajo su
// campo y el foco al primero. Enviada, «Qué sigue» aparece en el mismo lugar con el foco en su
// título: en una guía larga, la respuesta queda donde está la persona.
// Lo escrito a medias se guarda en la pestaña (sessionStorage) y vuelve al recargar; el correo del
// enlace que mandamos llega en el fragmento (`#correo=`), que no viaja al servidor ni a los
// registros, y se borra de la dirección al leerlo.
import { useForm, useStore } from "@tanstack/react-form"
import { type SyntheticEvent, useEffect, useRef, useState } from "react"
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
import { ofProduct, WORDS } from "../../lib/product"
import { contactEmail, waitlistApiUrl } from "../../lib/site"

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

/** Quién invita a alguien a su equipo: odentIA y latidIA dicen «una clínica» desde siempre. */
const INVITED_BY = ofProduct({ dental: "una clínica", medical: "una clínica", optical: "una óptica" })

/** Lo escrito a medias, en esta pestaña: vuelve al recargar y se borra al enviar. */
const DRAFT_KEY = "odentia:solicitud:v1"

/** El país del dispositivo, si está en la lista; si no, ninguno (se elige). */
function deviceCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? ""
    return COUNTRIES.some(([code]) => code === region) ? region : ""
  } catch {
    return ""
  }
}

export type WaitlistSent = {
  firstName: string
  clinicName: string
  phone: string
  email: string
  answerDays: number
}

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
  if (!v.clinicName.trim()) e.clinicName = `Escribe el nombre ${WORDS.ofTheClinic}`
  if (!v.professionals) e.professionals = `Elige cuántos ${WORDS.clinicians} atienden`
  if (!v.currentTool) e.currentTool = "Elige qué usan hoy"
  return e
}

/** Lo guardado a medias en esta pestaña, si sirve. */
function readDraft(): Partial<Values> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const draft: Partial<Values> = {}
    for (const key of Object.keys(EMPTY) as Field[]) if (typeof parsed[key] === "string") draft[key] = parsed[key] as string
    return draft
  } catch {
    return null
  }
}

function writeDraft(values: Values | null): void {
  try {
    if (values) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values))
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): el formulario sigue igual.
  }
}

/** El correo que llega en el enlace de nuestro correo (`#correo=`), y lo borra de la dirección. */
function emailFromLink(): string | null {
  try {
    const match = /(?:^#|&)correo=([^&]+)/.exec(window.location.hash)
    if (!match?.[1]) return null
    const email = decodeURIComponent(match[1]).trim()
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
    return EMAIL.test(email) ? email : null
  } catch {
    return null
  }
}

/** Atributos de un campo: id, nombre y su error, si lo tiene. */
function a11y(prefix: string, field: Field, error: string | undefined) {
  return {
    id: `${prefix}-${field}`,
    name: field,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${prefix}-${field}-error` : undefined,
  }
}

function FieldError({ prefix, field, message }: { prefix: string; field: Field; message: string | undefined }) {
  if (!message) return null
  return (
    <p className="wl-field-error" id={`${prefix}-${field}-error`}>
      {message}
    </p>
  )
}

type Props = {
  /** El regalo del plan Fundadores («USD 100»); null si el plan no tiene saldo de prueba. */
  gift: string | null
  /** Días hábiles para responder: las condiciones comerciales que rigen. */
  answerDays: number
  /** «page»: la tarjeta de la página de la solicitud; «section»: al final de una guía, sin «Volver al inicio». */
  variant: "page" | "section"
  /** La página de la web desde la que se envía: «Llegó desde» en la administración. */
  sourcePage?: string
  /** Al enviarse, para que la página cambie lo suyo (la de la solicitud, su título). */
  onSent?: (sent: WaitlistSent) => void
}

export default function WaitlistForm({ gift, answerDays, variant, sourcePage, onSent }: Props) {
  const prefix = variant === "page" ? "wl" : "wlg"
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<WaitlistSent | null>(null)
  const nextRef = useRef<HTMLHeadingElement | null>(null)

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
      // La página va en la dirección, no en el cuerpo: la API de antes la ignora (ADR 0215).
      const url = sourcePage ? `${waitlistApiUrl}?desde=${encodeURIComponent(sourcePage)}` : waitlistApiUrl
      let res: Response
      try {
        res = await fetch(url, {
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
      const done: WaitlistSent = {
        firstName: body.firstName,
        clinicName: body.clinicName,
        phone: body.phone,
        email: body.email,
        answerDays: payload?.data?.answerDays ?? payload?.answerDays ?? answerDays,
      }
      writeDraft(null)
      setSent(done)
      onSent?.(done)
    },
  })
  const country = useStore(form.store, (state) => state.values.countryCode)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const values = useStore(form.store, (state) => state.values)
  const dial = COUNTRIES.find(([code]) => code === country)?.[2]
  const restored = useRef(false)

  // Al cargar: lo escrito a medias en esta pestaña, el correo del enlace y el país del dispositivo
  // (en el servidor no se sabe); todo se puede cambiar.
  useEffect(() => {
    const draft = readDraft()
    if (draft) for (const [key, value] of Object.entries(draft)) form.setFieldValue(key as Field, value, { dontUpdateMeta: true })
    const linked = emailFromLink()
    if (linked && !form.getFieldValue("email")) form.setFieldValue("email", linked, { dontUpdateMeta: true })
    if (!form.getFieldValue("countryCode")) form.setFieldValue("countryCode", deviceCountry(), { dontUpdateMeta: true })
    restored.current = true
  }, [form])

  useEffect(() => {
    if (!restored.current || sent) return
    const touched = (Object.keys(EMPTY) as Field[]).some((key) => key !== "countryCode" && values[key].trim())
    writeDraft(touched ? values : null)
  }, [values, sent])

  // «Qué sigue» toma el foco donde está: en la página y en la guía, sin perderse.
  useEffect(() => {
    if (!sent) return
    nextRef.current?.focus({ preventScroll: variant === "page" })
    if (variant === "page") window.scrollTo({ top: 0 })
    else nextRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [sent, variant])

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

  const Heading = variant === "page" ? "h2" : "h3"

  if (sent) {
    return (
      <div className="wl-card" aria-live="polite">
        <Heading className="wl-h" ref={nextRef} tabIndex={-1}>
          Qué sigue
        </Heading>
        <ol className="wl-steps">
          <li>Revisamos tu solicitud en {businessDays(sent.answerDays)}.</li>
          <li>Te escribimos por WhatsApp al {sent.phone} para una llamada corta.</li>
          <li>
            Te llega tu invitación a {sent.email} y abres {WORDS.yourClinic} como Fundadora.
          </li>
        </ol>
        {/* Lo mismo si ese correo ya había pedido entrar: la web no lo dice (ADR 0215). */}
        <p className="wl-note">
          Si te equivocaste en un dato, escríbenos a <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
        </p>
        {variant === "page" ? (
          <a className="btn btn-g wl-back" href="/">
            Volver al inicio
          </a>
        ) : null}
      </div>
    )
  }

  return (
    <form className="wl-card" onSubmit={submit} noValidate>
      <Heading className="wl-h">
        {gift ? (
          <>
            Pide tus <span className="gift-light">{gift}</span>
          </>
        ) : (
          "Pide tu invitación"
        )}
      </Heading>
      <p className="wl-note">Mientras dure el programa, se entra por invitación. Te respondemos en {businessDays(answerDays)}.</p>
      <div className="wl-grid">
        <form.Field name="firstName">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-firstName`}>Nombre</label>
                <input
                  {...a11y(prefix, "firstName", fieldMessage)}
                  autoComplete="given-name"
                  required
                  maxLength={80}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError prefix={prefix} field="firstName" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="lastName">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-lastName`}>Apellidos</label>
                <input
                  {...a11y(prefix, "lastName", fieldMessage)}
                  autoComplete="family-name"
                  required
                  maxLength={80}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError prefix={prefix} field="lastName" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="email">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field wl-wide">
                <label htmlFor={`${prefix}-email`}>Correo</label>
                <input
                  {...a11y(prefix, "email", fieldMessage)}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError prefix={prefix} field="email" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="countryCode">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-countryCode`}>País</label>
                <select
                  {...a11y(prefix, "countryCode", fieldMessage)}
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
                <FieldError prefix={prefix} field="countryCode" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="city">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-city`}>Ciudad</label>
                <input
                  {...a11y(prefix, "city", fieldMessage)}
                  autoComplete="address-level2"
                  required
                  maxLength={80}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError prefix={prefix} field="city" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="phone">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field wl-wide-sm">
                <label htmlFor={`${prefix}-phone`}>Celular (WhatsApp)</label>
                <span className="wl-phone">
                  {dial ? <span className="mono wl-dial">+{dial}</span> : null}
                  <input
                    {...a11y(prefix, "phone", fieldMessage)}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    required
                    maxLength={20}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </span>
                <FieldError prefix={prefix} field="phone" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="clinicName">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field wl-wide-sm">
                <label htmlFor={`${prefix}-clinicName`}>{`Nombre ${WORDS.ofTheClinic}`}</label>
                <input
                  {...a11y(prefix, "clinicName", fieldMessage)}
                  autoComplete="organization"
                  required
                  maxLength={120}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError prefix={prefix} field="clinicName" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="professionals">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-professionals`}>{`${WORDS.clinicians.charAt(0).toUpperCase()}${WORDS.clinicians.slice(1)} que atienden`}</label>
                <select
                  {...a11y(prefix, "professionals", fieldMessage)}
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
                <FieldError prefix={prefix} field="professionals" message={fieldMessage} />
              </div>
            )
          }}
        </form.Field>
        <form.Field name="currentTool">
          {(field) => {
            const fieldMessage = fieldError(field.state.meta)
            return (
              <div className="wl-field">
                <label htmlFor={`${prefix}-currentTool`}>Qué usan hoy</label>
                <select
                  {...a11y(prefix, "currentTool", fieldMessage)}
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
                <FieldError prefix={prefix} field="currentTool" message={fieldMessage} />
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
      {variant === "page" ? (
        <p className="wl-note wl-center">{`¿Te invitó ${INVITED_BY} a su equipo? Abre el enlace de tu correo.`}</p>
      ) : null}
    </form>
  )
}
