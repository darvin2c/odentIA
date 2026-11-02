import { Button, buttonVariants, cn } from "@odentia/ui"
import { useRef, useState } from "react"
import {
  Ban,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  FileSearch,
  type LucideIcon,
  Phone,
} from "lucide-react"
import {
  type DocumentCheck,
  type DocumentCheckState,
  matchesFingerprint,
} from "../../lib/document-check"

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
    say: () =>
      "Fue emitido por esta clínica y no ha sido anulado. Compare estos datos con el documento que tiene en la mano; si duda de lo que dice, llame a la clínica.",
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

type CompareResult = "pending" | "same" | "different" | "unavailable" | null

/**
 * A quien le llegó el documento como PDF: compara su archivo con el que guardó la
 * clínica, sin subirlo. Un papel impreso no se puede comparar así: por eso se dice que
 * una foto o un escaneo nunca coinciden, para no hacer dudar de un papel verdadero.
 */
export function DocumentFileCompare({
  fingerprints,
  initial = null,
}: {
  fingerprints: string[]
  initial?: CompareResult
}) {
  const input = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<CompareResult>(initial)
  async function compare(file: File) {
    setResult("pending")
    try {
      const same = await matchesFingerprint(file, fingerprints)
      setResult(same === null ? "unavailable" : same ? "same" : "different")
    } catch {
      setResult("unavailable")
    }
  }
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">¿Le enviaron este documento como PDF?</h2>
        <p className="text-sm text-muted-foreground">
          Compruebe que es el original. El archivo no se envía a ningún lado: se compara aquí mismo.
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void compare(file)
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        disabled={result === "pending"}
        onClick={() => input.current?.click()}
      >
        <FileSearch aria-hidden />
        {result === "same" || result === "different" ? "Comprobar otro archivo" : "Elegir el PDF"}
      </Button>
      <div aria-live="polite">
        {result === "pending" ? (
          <p className="text-sm text-muted-foreground">Comparando…</p>
        ) : null}
        {result === "same" ? (
          <p className="flex gap-2 text-sm">
            <CircleCheck aria-hidden className="size-5 shrink-0 text-success" />
            <span>
              <span className="font-medium">Es el original.</span> Este archivo es exactamente el
              que guardó la clínica: nadie lo modificó.
            </span>
          </p>
        ) : null}
        {result === "different" ? (
          <p className="flex gap-2 text-sm">
            <CircleX aria-hidden className="size-5 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">No coincide con el original.</span> Pudo modificarse.
              Una foto, un escaneo o un PDF guardado de nuevo tampoco coinciden aunque digan lo
              mismo. Llame a la clínica para confirmarlo.
            </span>
          </p>
        ) : null}
        {result === "unavailable" ? (
          <p className="text-sm text-muted-foreground">
            No se pudo comparar el archivo desde este navegador. Pruebe con otro o llame a la
            clínica.
          </p>
        ) : null}
      </div>
    </section>
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
      {check.fingerprints.length > 0 ? (
        <DocumentFileCompare fingerprints={check.fingerprints} />
      ) : null}
      {check.clinic.phone ? (
        <a
          href={`tel:${check.clinic.phone}`}
          className={buttonVariants({ className: "min-h-11 w-full" })}
        >
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
          Vuelva a escanear el código del papel. Si sigue igual, pídale a la clínica que emitió el
          documento que se lo confirme.
        </p>
      </section>
      {onRetry ? (
        <button
          type="button"
          className={buttonVariants({ variant: "outline", className: "min-h-11 w-full" })}
          onClick={onRetry}
        >
          Reintentar
        </button>
      ) : null}
    </main>
  )
}
