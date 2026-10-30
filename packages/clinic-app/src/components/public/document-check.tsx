import { buttonVariants, cn } from "@odentia/ui"
import { Ban, CircleCheck, CircleHelp, Clock, Phone, type LucideIcon } from "lucide-react"
import type { DocumentCheck, DocumentCheckState } from "../../lib/document-check"

/** «30 de octubre de 2026». Una fecha sin hora se dice tal cual, sin que la zona la mueva. */
export function checkDate(value: string): string {
  const civil = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(civil ? `${value}T12:00:00Z` : value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString("es", {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(civil ? { timeZone: "UTC" } : {}),
  })
}

const STATES: Record<
  DocumentCheckState,
  { title: string; icon: LucideIcon; tone: string; say: (check: DocumentCheck) => string }
> = {
  vigente: {
    title: "Documento vigente",
    icon: CircleCheck,
    tone: "text-success",
    say: () => "Fue emitido por esta clínica y no ha sido anulado. Compare estos datos con el documento que tiene en la mano.",
  },
  anulado: {
    title: "Documento anulado",
    icon: Ban,
    tone: "text-destructive",
    say: (check) =>
      `No debe usarse. La clínica lo anuló${check.voidedAt ? ` el ${checkDate(check.voidedAt)}` : ""}. Si tiene dudas, llame a la clínica.`,
  },
  revocado: {
    title: "Documento revocado",
    icon: Ban,
    tone: "text-destructive",
    say: (check) =>
      `Quien lo firmó lo dejó sin efecto${check.voidedAt ? ` el ${checkDate(check.voidedAt)}` : ""}. Si tiene dudas, llame a la clínica.`,
  },
  vencido: {
    title: "Documento vencido",
    icon: Clock,
    tone: "text-warning",
    say: (check) =>
      `Fue emitido por esta clínica, pero su vigencia terminó${check.validUntil ? ` el ${checkDate(check.validUntil)}` : ""}. Si tiene dudas, llame a la clínica.`,
  },
}

function Row({ term, children }: { term: string; children: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">{term}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{children}</dd>
    </div>
  )
}

/**
 * Lo que dice la página pública de un documento: su estado con icono y palabra y
 * lo mínimo para cotejar el papel. Nunca dice de qué se trató ni el nombre
 * completo: el servidor no lo entrega.
 */
export function DocumentCheckResult({ check }: { check: DocumentCheck }) {
  const state = STATES[check.state]
  const Icon = state.icon
  const signer = check.signer
    ? [check.signer.name, check.signer.title, check.signer.registration].filter(Boolean).join(" · ")
    : null
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
      <p className="text-center text-sm font-medium text-muted-foreground">{check.clinic.name}</p>
      <section className="elevated flex flex-col overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <Icon aria-hidden className={cn("size-10", state.tone)} />
          <h1 className="font-heading text-xl font-medium">{state.title}</h1>
          <p className="text-sm text-muted-foreground">{state.say(check)}</p>
        </div>
        <dl className="flex flex-col">
          <Row term="Documento">{check.label}</Row>
          {check.issuedAt ? <Row term="Emitido">{checkDate(check.issuedAt)}</Row> : null}
          {check.validUntil ? <Row term="Válido hasta">{checkDate(check.validUntil)}</Row> : null}
          {signer ? <Row term="Firmó">{signer}</Row> : null}
          <Row term="Paciente">{check.patientInitials}</Row>
        </dl>
      </section>
      {check.clinic.phone ? (
        <a href={`tel:${check.clinic.phone}`} className={buttonVariants({ className: "min-h-11 w-full" })}>
          <Phone aria-hidden />
          Llamar a la clínica
        </a>
      ) : null}
    </main>
  )
}

/** Un código que no se puede leer, de un documento que no está o un corte: nunca se dice cuál. */
export function DocumentCheckUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
      <section className="elevated flex flex-col items-center gap-2 rounded-xl border bg-card px-4 py-6 text-center">
        <CircleHelp aria-hidden className="size-10 text-muted-foreground" />
        <h1 className="font-heading text-xl font-medium">No pudimos comprobar este documento</h1>
        <p className="text-sm text-muted-foreground">
          Vuelva a escanear el código del papel. Si sigue igual, pídale a la clínica que emitió el documento que se lo
          confirme.
        </p>
      </section>
      {onRetry ? (
        <button type="button" className={buttonVariants({ variant: "outline", className: "min-h-11 w-full" })} onClick={onRetry}>
          Reintentar
        </button>
      ) : null}
    </main>
  )
}
