// Hoja de Reclamación virtual (Anexo I del reglamento del Libro de Reclamaciones): datos del proveedor, fecha y
// los cuatro bloques en orden. Valida junto a cada campo (también lo que rechaza el servidor), lleva el foco al
// primer error, conserva lo escrito si el envío falla y, al terminar, muestra el número de hoja con la opción
// de imprimirla.
import { useForm, useStore } from "@tanstack/react-form"
import { type ReactNode, type SubmitEvent, useEffect, useRef, useState } from "react"
import {
  COMPLAINTS_PROVIDER,
  CURRENCIES,
  complaintsApiUrl,
  DOCUMENT_TYPES,
  KINDS,
  LIMITS,
  RESPONSE_DAYS,
} from "../../lib/complaints"
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
import { WORDS } from "../../lib/product"
import "./complaints.css"

type Values = {
  consumerName: string
  consumerAddress: string
  documentType: string
  documentNumber: string
  phone: string
  email: string
  isMinor: boolean
  guardianName: string
  itemType: string
  itemDescription: string
  amount: string
  currency: string
  kind: string
  detail: string
  request: string
  privacyAccepted: boolean
}
type Field = keyof Values
type Errors = Partial<Record<Field, string>>
type Receipt = { number: string; createdAt: string; emailSent: boolean }

const EMPTY: Values = {
  consumerName: "",
  consumerAddress: "",
  documentType: "DNI",
  documentNumber: "",
  phone: "",
  email: "",
  isMinor: false,
  guardianName: "",
  itemType: "servicio",
  itemDescription: "",
  amount: "",
  currency: "PEN",
  kind: "",
  detail: "",
  request: "",
  privacyAccepted: false,
}

/** Mismas reglas que el servidor (`consumerComplaintInputSchema`); el servidor vuelve a validar. */
function validate(v: Values): Errors {
  const e: Errors = {}
  const t = (s: string) => s.trim()
  if (t(v.consumerName).length < 3) e.consumerName = "Escribe tu nombre completo"
  if (t(v.consumerAddress).length < 5) e.consumerAddress = "Escribe tu domicilio"
  const doc = t(v.documentNumber).toUpperCase()
  if (!doc) e.documentNumber = "Escribe el número de documento"
  else if (v.documentType === "DNI" && !/^\d{8}$/.test(doc))
    e.documentNumber = "El DNI tiene 8 dígitos"
  else if (v.documentType === "CE" && !/^[A-Z0-9]{8,12}$/.test(doc))
    e.documentNumber = "El carné de extranjería tiene de 8 a 12 letras o números"
  else if (v.documentType === "PASAPORTE" && !/^[A-Z0-9]{6,12}$/.test(doc))
    e.documentNumber = "El pasaporte tiene de 6 a 12 letras o números"
  if (!PHONE.test(t(v.phone))) e.phone = "Escribe un teléfono válido, solo con números"
  if (!EMAIL.test(t(v.email))) e.email = "Escribe un correo válido, por ejemplo nombre@correo.com"
  if (v.isMinor && !t(v.guardianName))
    e.guardianName = "Si eres menor de edad, escribe el nombre de tu padre, madre o apoderado"
  if (t(v.itemDescription).length < 3)
    e.itemDescription = "Escribe qué producto o servicio contrataste"
  if (t(v.amount) && !/^\d{1,9}([.,]\d{1,2})?$/.test(t(v.amount)))
    e.amount = "Escribe el monto con números, por ejemplo 150.50"
  if (!v.kind) e.kind = "Elige si es un reclamo o una queja"
  if (t(v.detail).length < 10) e.detail = "Cuéntanos qué pasó (al menos 10 caracteres)"
  else if (t(v.detail).length > LIMITS.detail)
    e.detail = `Usa como máximo ${LIMITS.detail} caracteres`
  if (t(v.request).length < 3) e.request = "Escribe qué pides"
  if (!v.privacyAccepted)
    e.privacyAccepted = "Acepta el tratamiento de tus datos para que podamos atender tu reclamación"
  return e
}

const SEND_FAILED = "No pudimos registrar tu reclamación. Intenta nuevamente en unos minutos."

/** Atributos comunes de un campo: id, nombre, error y descripción. */
function a11y(field: Field, error: string | undefined, hint?: string) {
  const described = [hint, error ? `${field}-error` : null].filter(Boolean).join(" ")
  return {
    id: field,
    name: field,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": described || undefined,
  }
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "long" }).format(
    date,
  )
}
function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "long",
    timeStyle: "short",
  }).format(date)
}

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null
  return (
    <p className="lr-error" id={id}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5v.01" strokeLinecap="round" />
      </svg>
      {message}
    </p>
  )
}

function Block({
  n,
  title,
  children,
  note,
}: {
  n: string
  title: string
  children?: ReactNode
  note?: ReactNode
}) {
  const id = `lr-block-${n}`
  return (
    <section className="lr-block" aria-labelledby={id}>
      <h3 className="lr-block-t" id={id}>
        <span className="lr-n" aria-hidden="true">
          {n}
        </span>
        <span className="sr-only">{n}. </span>
        {title}
      </h3>
      {note && <p className="lr-note">{note}</p>}
      {children}
    </section>
  )
}

export default function ComplaintForm() {
  const [sendError, setSendError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [today, setToday] = useState<string | null>(null)
  // Un envío por hoja: reintentar tras un fallo reutiliza el mismo id y el servidor no la duplica.
  const submissionId = useRef<string | null>(null)
  const confirmRef = useRef<HTMLHeadingElement>(null)

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
      submissionId.current ??= crypto.randomUUID()
      let res: Response
      try {
        res = await fetch(complaintsApiUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            submissionId: submissionId.current,
            kind: value.kind,
            consumerName: value.consumerName.trim(),
            consumerAddress: value.consumerAddress.trim(),
            documentType: value.documentType,
            documentNumber: value.documentNumber.trim().toUpperCase(),
            phone: value.phone.trim(),
            email: value.email.trim(),
            isMinor: value.isMinor,
            guardianName: value.isMinor ? value.guardianName.trim() : null,
            itemType: value.itemType,
            itemDescription: value.itemDescription.trim(),
            amount: value.amount.trim() || null,
            currency: value.amount.trim() ? value.currency : null,
            detail: value.detail.trim(),
            request: value.request.trim(),
            privacyAccepted: value.privacyAccepted,
          }),
        })
      } catch {
        throw new SubmitRejected(
          "No pudimos enviar tu reclamación. Revisa tu conexión e intenta nuevamente.",
        )
      }
      const body = (await res.json().catch(() => null)) as { data?: Receipt } | null
      if (res.ok && body?.data) {
        setReceipt(body.data)
        return
      }
      if (res.status === 429)
        throw new SubmitRejected(
          "Recibimos demasiados envíos desde tu conexión. Intenta nuevamente en unos minutos.",
        )
      // Un 400 dice en `fields` qué dato rechazó: cada uno va a su campo.
      if (res.status === 400) throw rejectionOf(body, SEND_FAILED)
      throw new SubmitRejected(SEND_FAILED)
    },
  })
  const s = useStore(form.store, (state) => state.values)
  const sending = useStore(form.store, (state) => state.isSubmitting)
  const errorCount = useStore(
    form.store,
    (state) =>
      Object.entries(state.fieldMeta).filter(
        // El apoderado solo cuenta mientras está en pantalla.
        ([name, meta]) => (name !== "guardianName" || state.values.isMinor) && fieldError(meta),
      ).length,
  )

  // La fecha se pone en el navegador: la página se genera por adelantado.
  useEffect(() => setToday(formatDate(new Date())), [])
  useEffect(() => {
    if (receipt) confirmRef.current?.focus()
  }, [receipt])

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (form.state.isSubmitting) return
    const root = event.currentTarget
    setSendError(null)
    clearRejection(form)
    try {
      await form.handleSubmit()
    } catch (error) {
      setSendError(applyRejection(form, error, SEND_FAILED))
    }
    if (!form.state.isSubmitSuccessful) focusFirstInvalid(root)
  }

  if (receipt) {
    const kind = KINDS.find((k) => k.value === s.kind)?.label ?? ""
    const doc = DOCUMENT_TYPES.find((d) => d.value === s.documentType)?.label ?? s.documentType
    const currency = s.currency === "USD" ? "USD" : "S/"
    const rows: [string, string][] = [
      ["Proveedor", `${COMPLAINTS_PROVIDER.legalName} · RUC ${COMPLAINTS_PROVIDER.ruc}`],
      ["Domicilio del proveedor", COMPLAINTS_PROVIDER.address],
      ["Nombre completo", s.consumerName.trim()],
      ["Domicilio", s.consumerAddress.trim()],
      ["Documento", `${doc} ${s.documentNumber.trim().toUpperCase()}`],
      ["Teléfono", s.phone.trim()],
      ["Correo electrónico", s.email.trim()],
      ...(s.isMinor
        ? ([["Padre, madre o apoderado", s.guardianName.trim()]] as [string, string][])
        : []),
      [
        "Bien contratado",
        `${s.itemType === "producto" ? "Producto" : "Servicio"}: ${s.itemDescription.trim()}`,
      ],
      ["Monto reclamado", s.amount.trim() ? `${currency} ${s.amount.trim()}` : "No indicado"],
      ["Tipo", kind],
      ["Detalle", s.detail.trim()],
      ["Pedido", s.request.trim()],
    ]
    return (
      <section className="lr-sheet lr-done" aria-labelledby="lr-done-t">
        <div className="lr-done-head">
          <span className="lr-ok" aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              aria-hidden="true"
            >
              <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h2 id="lr-done-t" ref={confirmRef} tabIndex={-1}>
            Recibimos tu {kind.toLowerCase()}
          </h2>
        </div>
        <dl className="lr-receipt">
          <div>
            <dt>Hoja de Reclamación</dt>
            <dd className="lr-big">N.º {receipt.number}</dd>
          </div>
          <div>
            <dt>Fecha</dt>
            <dd>{formatDateTime(new Date(receipt.createdAt))}</dd>
          </div>
        </dl>
        {receipt.emailSent ? (
          <p className="lr-msg">
            Enviamos una copia de esta hoja a <strong>{s.email.trim()}</strong>. Te responderemos a
            ese correo en un plazo no mayor a quince ({RESPONSE_DAYS}) días hábiles.
          </p>
        ) : (
          <p className="lr-msg lr-warn" role="note">
            Tu hoja quedó registrada, pero no pudimos enviar la copia a tu correo.{" "}
            <strong>Guárdala o imprímela</strong> con el botón de abajo. Te responderemos a{" "}
            <strong>{s.email.trim()}</strong> en un plazo no mayor a quince ({RESPONSE_DAYS}) días
            hábiles.
          </p>
        )}
        <details className="lr-copy" open>
          <summary>Lo que registraste</summary>
          <dl>
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
        <p className="lr-small">
          La formulación del reclamo no impide acudir a otras vías de solución de controversias ni
          es requisito previo para interponer una denuncia ante el INDECOPI.
        </p>
        <div className="lr-actions no-print">
          <button type="button" className="btn btn-d" onClick={() => window.print()}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z" strokeLinejoin="round" />
            </svg>
            Imprimir
          </button>
          <a className="btn btn-l" href="/">
            Volver al inicio
          </a>
        </div>
      </section>
    )
  }

  return (
    <form className="lr-sheet" onSubmit={onSubmit} noValidate aria-labelledby="lr-sheet-t">
      <header className="lr-head">
        <div>
          <h2 id="lr-sheet-t" className="lr-title">
            Hoja de Reclamación
          </h2>
          <p className="lr-sub">Libro de Reclamaciones virtual</p>
        </div>
        <dl className="lr-meta">
          <div>
            <dt>Fecha</dt>
            <dd>{today ?? "—"}</dd>
          </div>
          <div>
            <dt>N.º de hoja</dt>
            <dd>Se asigna al enviar</dd>
          </div>
        </dl>
      </header>

      <dl className="lr-provider" aria-label="Datos del proveedor">
        <div>
          <dt>Razón social</dt>
          <dd>{COMPLAINTS_PROVIDER.legalName}</dd>
        </div>
        <div>
          <dt>RUC</dt>
          <dd>{COMPLAINTS_PROVIDER.ruc}</dd>
        </div>
        <div className="lr-wide">
          <dt>Domicilio</dt>
          <dd>{COMPLAINTS_PROVIDER.address}</dd>
        </div>
      </dl>

      <p className="lr-required">
        Todos los campos son obligatorios salvo los marcados como opcionales.
      </p>

      <Block n="1" title="Identificación del consumidor reclamante">
        <div className="lr-grid">
          <form.Field name="consumerName">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field lr-wide">
                  <label htmlFor="consumerName">Nombre completo</label>
                  <input
                    {...a11y("consumerName", error)}
                    autoComplete="name"
                    maxLength={160}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError id="consumerName-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="consumerAddress">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field lr-wide">
                  <label htmlFor="consumerAddress">Domicilio</label>
                  <input
                    {...a11y("consumerAddress", error, "consumerAddress-hint")}
                    autoComplete="street-address"
                    maxLength={300}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="lr-hint" id="consumerAddress-hint">
                    Calle, número, distrito y ciudad.
                  </p>
                  <FieldError id="consumerAddress-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="documentType">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="documentType">Tipo de documento</label>
                  <select
                    {...a11y("documentType", error)}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  >
                    {DOCUMENT_TYPES.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <FieldError id="documentType-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="documentNumber">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="documentNumber">Número de documento</label>
                  <input
                    {...a11y("documentNumber", error)}
                    autoComplete="off"
                    inputMode={s.documentType === "DNI" ? "numeric" : "text"}
                    maxLength={12}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError id="documentNumber-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="phone">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="phone">Teléfono</label>
                  <input
                    {...a11y("phone", error)}
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={20}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError id="phone-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="email">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="email">Correo electrónico</label>
                  <input
                    {...a11y("email", error, "email-hint")}
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="lr-hint" id="email-hint">
                    Aquí te llega la copia de esta hoja y nuestra respuesta.
                  </p>
                  <FieldError id="email-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="isMinor">
            {(field) => (
              <div className="lr-field lr-wide">
                <label className="lr-check">
                  <input
                    type="checkbox"
                    name="isMinor"
                    checked={field.state.value}
                    onChange={(e) => field.handleChange(e.target.checked)}
                  />
                  <span>Soy menor de edad</span>
                </label>
              </div>
            )}
          </form.Field>
          {s.isMinor && (
            <form.Field name="guardianName">
              {(field) => {
                const error = fieldError(field.state.meta)
                return (
                  <div className="lr-field lr-wide">
                    <label htmlFor="guardianName">Nombre del padre, madre o apoderado</label>
                    <input
                      {...a11y("guardianName", error)}
                      maxLength={160}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                    <FieldError id="guardianName-error" message={error} />
                  </div>
                )
              }}
            </form.Field>
          )}
        </div>
      </Block>

      <Block n="2" title="Identificación del bien contratado">
        <div className="lr-grid">
          <form.Field name="itemType">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <fieldset
                  className="lr-field lr-wide lr-choice"
                  aria-describedby={error ? "itemType-error" : undefined}
                  data-invalid={error ? "true" : undefined}
                >
                  <legend>¿Fue un producto o un servicio?</legend>
                  <div className="lr-radios">
                    {(["servicio", "producto"] as const).map((v) => (
                      <label key={v} className="lr-radio" htmlFor={`itemType-${v}`}>
                        <input
                          type="radio"
                          id={`itemType-${v}`}
                          name="itemType"
                          value={v}
                          checked={field.state.value === v}
                          onChange={() => field.handleChange(v)}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? "itemType-error" : undefined}
                        />
                        <span>{v === "servicio" ? "Servicio" : "Producto"}</span>
                      </label>
                    ))}
                  </div>
                  <FieldError id="itemType-error" message={error} />
                </fieldset>
              )
            }}
          </form.Field>
          <form.Field name="itemDescription">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field lr-wide">
                  <label htmlFor="itemDescription">Descripción</label>
                  <input
                    {...a11y("itemDescription", error, "itemDescription-hint")}
                    maxLength={LIMITS.itemDescription}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="lr-hint" id="itemDescription-hint">
                    Por ejemplo: «Plan mensual de {WORDS.name}» o «Soporte técnico».
                  </p>
                  <FieldError id="itemDescription-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="amount">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="amount">
                    Monto reclamado <span className="lr-opt">(opcional)</span>
                  </label>
                  <input
                    {...a11y("amount", error)}
                    inputMode="decimal"
                    placeholder="0.00"
                    maxLength={13}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldError id="amount-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="currency">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field">
                  <label htmlFor="currency">Moneda</label>
                  <select
                    {...a11y("currency", error)}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <FieldError id="currency-error" message={error} />
                </div>
              )
            }}
          </form.Field>
        </div>
      </Block>

      <Block n="3" title="Detalle de la reclamación y pedido del consumidor">
        <div className="lr-grid">
          <form.Field name="kind">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <fieldset
                  className="lr-field lr-wide lr-choice"
                  aria-describedby={error ? "kind-error" : undefined}
                  data-invalid={error ? "true" : undefined}
                >
                  <legend>¿Es un reclamo o una queja?</legend>
                  <div className="lr-kinds">
                    {KINDS.map((k) => (
                      <label key={k.value} className="lr-kind" htmlFor={`kind-${k.value}`}>
                        <input
                          type="radio"
                          id={`kind-${k.value}`}
                          name="kind"
                          value={k.value}
                          checked={field.state.value === k.value}
                          onChange={() => field.handleChange(k.value)}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={
                            error ? `kind-${k.value}-hint kind-error` : `kind-${k.value}-hint`
                          }
                        />
                        <span className="lr-kind-t">{k.label}</span>
                        <span className="lr-kind-h" id={`kind-${k.value}-hint`}>
                          {k.hint}
                        </span>
                      </label>
                    ))}
                  </div>
                  <FieldError id="kind-error" message={error} />
                </fieldset>
              )
            }}
          </form.Field>
          <form.Field name="detail">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field lr-wide">
                  <label htmlFor="detail">Detalle</label>
                  <textarea
                    {...a11y("detail", error, "detail-count")}
                    rows={6}
                    maxLength={LIMITS.detail}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="lr-count" id="detail-count" aria-live="polite">
                    {field.state.value.length} de {LIMITS.detail} caracteres
                  </p>
                  <FieldError id="detail-error" message={error} />
                </div>
              )
            }}
          </form.Field>
          <form.Field name="request">
            {(field) => {
              const error = fieldError(field.state.meta)
              return (
                <div className="lr-field lr-wide">
                  <label htmlFor="request">Pedido</label>
                  <textarea
                    {...a11y("request", error, "request-hint")}
                    rows={3}
                    maxLength={LIMITS.request}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="lr-hint" id="request-hint">
                    Qué solución esperas de nosotros.
                  </p>
                  <FieldError id="request-error" message={error} />
                </div>
              )
            }}
          </form.Field>
        </div>
      </Block>

      <Block
        n="4"
        title="Observaciones y acciones adoptadas por el proveedor"
        note={`Este bloque lo completa ${WORDS.name} al responder. Te llegará por correo en un plazo no mayor a quince (${RESPONSE_DAYS}) días hábiles improrrogables.`}
      />

      <ul className="lr-notices">
        <li>
          La formulación del reclamo no impide acudir a otras vías de solución de controversias ni
          es requisito previo para interponer una denuncia ante el INDECOPI.
        </li>
        <li>
          El proveedor debe responder en un plazo no mayor a quince ({RESPONSE_DAYS}) días hábiles
          improrrogables.
        </li>
        <li>Al enviar, te llega una copia de esta hoja a tu correo electrónico.</li>
      </ul>

      <form.Field name="privacyAccepted">
        {(field) => {
          const error = fieldError(field.state.meta)
          return (
            <div className="lr-field">
              <label className="lr-check" htmlFor="privacyAccepted">
                <input
                  type="checkbox"
                  id="privacyAccepted"
                  name="privacyAccepted"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "privacyAccepted-error" : undefined}
                />
                <span>
                  Acepto el tratamiento de mis datos personales para atender esta reclamación, según
                  la <a href="/privacidad">política de privacidad</a>.
                </span>
              </label>
              <FieldError id="privacyAccepted-error" message={error} />
            </div>
          )
        }}
      </form.Field>

      <div className="lr-submit">
        <button type="submit" className="btn btn-d" disabled={sending} aria-disabled={sending}>
          {sending ? "Enviando…" : "Enviar reclamación"}
        </button>
        <div className="lr-status" role="status" aria-live="polite">
          {errorCount > 0 && !sendError && (
            <p className="lr-error">
              {errorCount === 1
                ? "Revisa el campo marcado."
                : `Revisa los ${errorCount} campos marcados.`}
            </p>
          )}
        </div>
      </div>
      {sendError && (
        <p className="lr-send-error" role="alert">
          {sendError} Lo que escribiste sigue aquí.
        </p>
      )}
    </form>
  )
}
