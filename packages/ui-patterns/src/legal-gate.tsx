import { Checkbox, Dialog, DialogContent, DialogDescription, DialogTitle, toast } from "@odentia/ui"
import { useEffect, useId, useState } from "react"
import type { AuthFetch } from "./access-link-gate.js"
import { SubmitButton } from "./form/submit-button.js"

export type LegalLinks = { terms: string; privacy: string; agreement: string; support: string }

type TermsStatus = {
  terms: {
    state: "ok" | "first" | "updated"
    version: string
    effectiveAt: string
    changes: string[]
  }
}
export type ClinicAgreementStatus = {
  needed: boolean
  first: boolean
  version: string
  changes: string[]
}

/** «1 de marzo de 2027». */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`))
}

/**
 * Lo que falta aceptar al entrar (lienzo «Términos con Google», tablero 3):
 * una versión nueva de los términos y el aviso (cada persona) y, para quien
 * administra la clínica, el contrato de encargo si la clínica no lo aceptó en
 * su versión vigente. No se cierra sin aceptar (decisión 3). La primera vez sin
 * ninguna aceptación no pasa por aquí: el panel muestra «Un paso antes de
 * seguir».
 */
export function LegalGate({
  request,
  clinic,
  links,
}: {
  request: AuthFetch
  clinic?:
    | { load: () => Promise<ClinicAgreementStatus>; accept: (version: string) => Promise<void> }
    | undefined
  links: LegalLinks
}) {
  const id = useId()
  const [terms, setTerms] = useState<TermsStatus["terms"] | null>(null)
  const [agreement, setAgreement] = useState<ClinicAgreementStatus | null>(null)
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void request("/legal/status", { method: "GET" }).then(({ data }) => {
      const status = data as TermsStatus | null
      if (alive && status?.terms.state === "updated") setTerms(status.terms)
    })
    void clinic
      ?.load()
      .then((status) => {
        if (alive && status.needed) setAgreement(status)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [request, clinic])

  if (!terms && !agreement) return null

  const docs = [
    ...(terms
      ? [
          { href: links.terms, label: "Términos del servicio" },
          { href: links.privacy, label: "Aviso de privacidad" },
        ]
      : []),
    ...(agreement ? [{ href: links.agreement, label: "Contrato de encargo de tratamiento" }] : []),
  ]
  const changes = [...(terms?.changes ?? []), ...(agreement?.changes ?? [])]
  const title = terms
    ? "Actualizamos los términos"
    : agreement?.first
      ? "El contrato de encargo de tu clínica"
      : "Actualizamos el contrato de encargo"
  const intro = terms
    ? `Rigen desde el ${longDate(terms.effectiveAt)}.${changes.length ? " Lo que cambió:" : ""}`
    : agreement?.first
      ? "Tu clínica confía a odentIA los datos de sus pacientes. Como la administras, acéptalo en su nombre."
      : "Lo que cambió:"

  async function accept() {
    if (!checked) {
      setError("Marca la casilla para seguir.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (terms) {
        const { error: failure } = await request("/legal/accept", {
          method: "POST",
          body: { termsVersion: terms.version },
        })
        if (failure) throw new Error(failure.message || "No pudimos guardarlo.")
      }
      if (agreement) await clinic?.accept(agreement.version)
      setTerms(null)
      setAgreement(null)
      toast.success("Listo. Gracias por aceptarlos.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pudimos guardarlo. Inténtalo de nuevo.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-8"
      >
        <div className="flex flex-col gap-4">
          <span aria-hidden className="mx-auto -mt-2 h-1.5 w-11 rounded-full bg-muted sm:hidden" />
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-xl font-extrabold tracking-[-0.02em]">{title}</DialogTitle>
            <DialogDescription>{intro}</DialogDescription>
          </div>
          {changes.length ? (
            <ul className="flex list-disc flex-col gap-1.5 rounded-xl border bg-muted/40 py-3 pr-3 pl-7 text-sm">
              {changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <Checkbox
              id={`${id}-acepto`}
              className="mt-0.5"
              checked={checked}
              onCheckedChange={(value) => {
                setChecked(value === true)
                setError(null)
              }}
            />
            <label htmlFor={`${id}-acepto`}>
              Leí y acepto{" "}
              {docs.map((d, i) => (
                <span key={d.href}>
                  {i > 0 ? (i === docs.length - 1 ? " y " : ", ") : ""}
                  {d.label.startsWith("Términos") ? "los " : "el "}
                  <a
                    href={d.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    {d.label}
                  </a>
                </span>
              ))}
              {terms ? " actualizados" : ""}.
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
          <SubmitButton
            type="button"
            pending={saving}
            onClick={() => void accept()}
            className="w-full"
          >
            Aceptar y seguir
          </SubmitButton>
          <p className="text-xs text-muted-foreground">
            Si no estás de acuerdo,{" "}
            <a href={links.support} className="underline">
              escríbenos
            </a>
            {terms && new Date(`${terms.effectiveAt}T00:00:00Z`).getTime() > Date.now()
              ? ` antes del ${longDate(terms.effectiveAt)}`
              : ""}
            .
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
