// Hoja de Reclamación virtual (Anexo I del reglamento del Libro de Reclamaciones): datos del proveedor, fecha y
// los cuatro bloques en orden. Valida junto a cada campo, lleva el foco al primer error, conserva lo escrito si
// el envío falla y, al terminar, muestra el número de hoja con la opción de imprimirla.
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

/** Orden de los campos en la hoja: el foco va al primero con error. */
const ORDER: Field[] = [
  "consumerName",
  "consumerAddress",
  "documentType",
  "documentNumber",
  "phone",
  "email",
  "guardianName",
  "itemType",
  "itemDescription",
  "amount",
  "currency",
  "kind",
  "detail",
  "request",
  "privacyAccepted",
]

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
  if (!/^\+?[0-9][0-9 ()-]{5,19}$/.test(t(v.phone)))
    e.phone = "Escribe un teléfono válido, solo con números"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(v.email)))
    e.email = "Escribe un correo válido, por ejemplo nombre@correo.com"
  if (v.isMinor && t(v.guardianName).length < 3)
    e.guardianName = "Escribe el nombre de tu padre, madre o apoderado"
  if (t(v.itemDescription).length < 3)
    e.itemDescription = "Escribe qué producto o servicio contrataste"
  if (t(v.amount) && !/^\d{1,9}([.,]\d{1,2})?$/.test(t(v.amount)))
    e.amount = "Escribe el monto con números, por ejemplo 150.50"
  if (!v.kind) e.kind = "Elige si es un reclamo o una queja"
  if (t(v.detail).length < 10) e.detail = "Cuéntanos qué pasó (al menos 10 caracteres)"
  else if (v.detail.length > LIMITS.detail) e.detail = `Usa como máximo ${LIMITS.detail} caracteres`
  if (t(v.request).length < 3) e.request = "Escribe qué pides"
  if (!v.privacyAccepted)
    e.privacyAccepted = "Acepta el tratamiento de tus datos para que podamos atender tu reclamación"
  return e
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
  const [values, setValues] = useState<Values>(EMPTY)
  const [errors, setErrors] = useState<Errors>({})
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [today, setToday] = useState<string | null>(null)
  // Un envío por hoja: reintentar tras un fallo reutiliza el mismo id y el servidor no la duplica.
  const submissionId = useRef<string | null>(null)
  const confirmRef = useRef<HTMLHeadingElement>(null)

  // La fecha se pone en el navegador: la página se genera por adelantado.
  useEffect(() => setToday(formatDate(new Date())), [])
  useEffect(() => {
    if (receipt) confirmRef.current?.focus()
  }, [receipt])

  function set<K extends Field>(field: K, value: Values[K]) {
    setValues((prev) => ({ ...prev, [field]: value }))
    // Corregir un campo retira su mensaje al momento.
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  /** Atributos comunes de un campo: id, etiqueta asociada, error y descripción. */
  function a11y(field: Field, hint?: string) {
    const described = [hint, errors[field] ? `${field}-error` : null].filter(Boolean).join(" ")
    return {
      id: field,
      name: field,
      "aria-invalid": errors[field] ? true : undefined,
      "aria-describedby": described || undefined,
    }
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending) return
    const found = validate(values)
    setErrors(found)
    const first = ORDER.find((f) => found[f])
    if (first) {
      setSendError(null)
      const target = document.getElementById(
        first === "kind" ? "kind-reclamo" : first === "itemType" ? "itemType-servicio" : first,
      )
      target?.focus()
      return
    }
    submissionId.current ??= crypto.randomUUID()
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch(complaintsApiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: submissionId.current,
          kind: values.kind,
          consumerName: values.consumerName.trim(),
          consumerAddress: values.consumerAddress.trim(),
          documentType: values.documentType,
          documentNumber: values.documentNumber.trim().toUpperCase(),
          phone: values.phone.trim(),
          email: values.email.trim(),
          isMinor: values.isMinor,
          guardianName: values.isMinor ? values.guardianName.trim() : null,
          itemType: values.itemType,
          itemDescription: values.itemDescription.trim(),
          amount: values.amount.trim() || null,
          currency: values.amount.trim() ? values.currency : null,
          detail: values.detail.trim(),
          request: values.request.trim(),
          privacyAccepted: values.privacyAccepted,
        }),
      })
      const body = (await res.json().catch(() => null)) as {
        data?: Receipt
        error?: { message?: string }
      } | null
      if (res.ok && body?.data) {
        setReceipt(body.data)
        return
      }
      if (res.status === 429)
        setSendError(
          "Recibimos demasiados envíos desde tu conexión. Intenta nuevamente en unos minutos.",
        )
      else if (res.status === 400 && body?.error?.message) setSendError(body.error.message)
      else setSendError("No pudimos registrar tu reclamación. Intenta nuevamente en unos minutos.")
    } catch {
      setSendError("No pudimos enviar tu reclamación. Revisa tu conexión e intenta nuevamente.")
    } finally {
      setSending(false)
    }
  }

  const s = values

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

  const errorCount = Object.values(errors).filter(Boolean).length

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
          <div className="lr-field lr-wide">
            <label htmlFor="consumerName">Nombre completo</label>
            <input
              {...a11y("consumerName")}
              autoComplete="name"
              maxLength={160}
              value={s.consumerName}
              onChange={(e) => set("consumerName", e.target.value)}
            />
            <FieldError id="consumerName-error" message={errors.consumerName} />
          </div>
          <div className="lr-field lr-wide">
            <label htmlFor="consumerAddress">Domicilio</label>
            <input
              {...a11y("consumerAddress", "consumerAddress-hint")}
              autoComplete="street-address"
              maxLength={300}
              value={s.consumerAddress}
              onChange={(e) => set("consumerAddress", e.target.value)}
            />
            <p className="lr-hint" id="consumerAddress-hint">
              Calle, número, distrito y ciudad.
            </p>
            <FieldError id="consumerAddress-error" message={errors.consumerAddress} />
          </div>
          <div className="lr-field">
            <label htmlFor="documentType">Tipo de documento</label>
            <select
              {...a11y("documentType")}
              value={s.documentType}
              onChange={(e) => set("documentType", e.target.value)}
            >
              {DOCUMENT_TYPES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="lr-field">
            <label htmlFor="documentNumber">Número de documento</label>
            <input
              {...a11y("documentNumber")}
              autoComplete="off"
              inputMode={s.documentType === "DNI" ? "numeric" : "text"}
              maxLength={12}
              value={s.documentNumber}
              onChange={(e) => set("documentNumber", e.target.value)}
            />
            <FieldError id="documentNumber-error" message={errors.documentNumber} />
          </div>
          <div className="lr-field">
            <label htmlFor="phone">Teléfono</label>
            <input
              {...a11y("phone")}
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              maxLength={20}
              value={s.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
            <FieldError id="phone-error" message={errors.phone} />
          </div>
          <div className="lr-field">
            <label htmlFor="email">Correo electrónico</label>
            <input
              {...a11y("email", "email-hint")}
              type="email"
              autoComplete="email"
              maxLength={254}
              value={s.email}
              onChange={(e) => set("email", e.target.value)}
            />
            <p className="lr-hint" id="email-hint">
              Aquí te llega la copia de esta hoja y nuestra respuesta.
            </p>
            <FieldError id="email-error" message={errors.email} />
          </div>
          <div className="lr-field lr-wide">
            <label className="lr-check">
              <input
                type="checkbox"
                checked={s.isMinor}
                onChange={(e) => set("isMinor", e.target.checked)}
              />
              <span>Soy menor de edad</span>
            </label>
          </div>
          {s.isMinor && (
            <div className="lr-field lr-wide">
              <label htmlFor="guardianName">Nombre del padre, madre o apoderado</label>
              <input
                {...a11y("guardianName")}
                maxLength={160}
                value={s.guardianName}
                onChange={(e) => set("guardianName", e.target.value)}
              />
              <FieldError id="guardianName-error" message={errors.guardianName} />
            </div>
          )}
        </div>
      </Block>

      <Block n="2" title="Identificación del bien contratado">
        <div className="lr-grid">
          <fieldset className="lr-field lr-wide lr-choice">
            <legend>¿Fue un producto o un servicio?</legend>
            <div className="lr-radios">
              {(["servicio", "producto"] as const).map((v) => (
                <label key={v} className="lr-radio" htmlFor={`itemType-${v}`}>
                  <input
                    type="radio"
                    id={`itemType-${v}`}
                    name="itemType"
                    value={v}
                    checked={s.itemType === v}
                    onChange={() => set("itemType", v)}
                  />
                  <span>{v === "servicio" ? "Servicio" : "Producto"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="lr-field lr-wide">
            <label htmlFor="itemDescription">Descripción</label>
            <input
              {...a11y("itemDescription", "itemDescription-hint")}
              maxLength={LIMITS.itemDescription}
              value={s.itemDescription}
              onChange={(e) => set("itemDescription", e.target.value)}
            />
            <p className="lr-hint" id="itemDescription-hint">
              Por ejemplo: «Plan mensual de odentIA» o «Soporte técnico».
            </p>
            <FieldError id="itemDescription-error" message={errors.itemDescription} />
          </div>
          <div className="lr-field">
            <label htmlFor="amount">
              Monto reclamado <span className="lr-opt">(opcional)</span>
            </label>
            <input
              {...a11y("amount")}
              inputMode="decimal"
              placeholder="0.00"
              maxLength={13}
              value={s.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
            <FieldError id="amount-error" message={errors.amount} />
          </div>
          <div className="lr-field">
            <label htmlFor="currency">Moneda</label>
            <select
              {...a11y("currency")}
              value={s.currency}
              onChange={(e) => set("currency", e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Block>

      <Block n="3" title="Detalle de la reclamación y pedido del consumidor">
        <div className="lr-grid">
          <fieldset
            className="lr-field lr-wide lr-choice"
            aria-describedby={errors.kind ? "kind-error" : undefined}
            data-invalid={errors.kind ? "true" : undefined}
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
                    checked={s.kind === k.value}
                    onChange={() => set("kind", k.value)}
                    aria-invalid={errors.kind ? true : undefined}
                    aria-describedby={
                      errors.kind ? `kind-${k.value}-hint kind-error` : `kind-${k.value}-hint`
                    }
                  />
                  <span className="lr-kind-t">{k.label}</span>
                  <span className="lr-kind-h" id={`kind-${k.value}-hint`}>
                    {k.hint}
                  </span>
                </label>
              ))}
            </div>
            <FieldError id="kind-error" message={errors.kind} />
          </fieldset>
          <div className="lr-field lr-wide">
            <label htmlFor="detail">Detalle</label>
            <textarea
              {...a11y("detail", "detail-count")}
              rows={6}
              maxLength={LIMITS.detail}
              value={s.detail}
              onChange={(e) => set("detail", e.target.value)}
            />
            <p className="lr-count" id="detail-count" aria-live="polite">
              {s.detail.length} de {LIMITS.detail} caracteres
            </p>
            <FieldError id="detail-error" message={errors.detail} />
          </div>
          <div className="lr-field lr-wide">
            <label htmlFor="request">Pedido</label>
            <textarea
              {...a11y("request", "request-hint")}
              rows={3}
              maxLength={LIMITS.request}
              value={s.request}
              onChange={(e) => set("request", e.target.value)}
            />
            <p className="lr-hint" id="request-hint">
              Qué solución esperas de nosotros.
            </p>
            <FieldError id="request-error" message={errors.request} />
          </div>
        </div>
      </Block>

      <Block
        n="4"
        title="Observaciones y acciones adoptadas por el proveedor"
        note={`Este bloque lo completa odentIA al responder. Te llegará por correo en un plazo no mayor a quince (${RESPONSE_DAYS}) días hábiles improrrogables.`}
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

      <div className="lr-field">
        <label className="lr-check" htmlFor="privacyAccepted">
          <input
            type="checkbox"
            id="privacyAccepted"
            checked={s.privacyAccepted}
            onChange={(e) => set("privacyAccepted", e.target.checked)}
            aria-invalid={errors.privacyAccepted ? true : undefined}
            aria-describedby={errors.privacyAccepted ? "privacyAccepted-error" : undefined}
          />
          <span>
            Acepto el tratamiento de mis datos personales para atender esta reclamación, según la{" "}
            <a href="/privacidad">política de privacidad</a>.
          </span>
        </label>
        <FieldError id="privacyAccepted-error" message={errors.privacyAccepted} />
      </div>

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
