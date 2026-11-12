import { CONSENT_SECTION_LABELS, type ConsentSections } from "@odentia/clinical"
import { cn } from "@odentia/ui"
import { type ReactNode, type Ref, useId } from "react"
import type { ConsentLetterhead } from "../../lib/clinical-forms"

/** El membrete del papel: nombre, «razón social · RUC», logo y, con una sola sede, su dirección. */
export type ConsentSheetClinic = ConsentLetterhead

/** Iniciales del membrete sin logo: la primera letra de las dos primeras palabras, como el PDF (`document-kit`). */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => [...(word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")][0] ?? "")
    .join("")
    .toLocaleUpperCase("es")
}

/**
 * El papel en pantalla: claro siempre, también con la app en oscuro (`theme-light`). Con
 * la hoja membretada de la clínica (ADR 0181) lleva su parte de arriba y la de abajo de
 * borde a borde, como el PDF; el papel ya va centrado y del ancho de una hoja.
 */
export function SheetPaper({
  clinic,
  className,
  children,
  ...rest
}: { clinic: ConsentSheetClinic | null | undefined } & React.ComponentProps<"article">): React.JSX.Element {
  const sheet = clinic?.sheet ?? null
  return (
    <article
      {...rest}
      className={cn(
        "theme-light flex flex-col rounded-sm border bg-card text-card-foreground shadow-sm",
        sheet ? "overflow-hidden" : "px-5 py-6 sm:px-10 sm:py-10",
        className,
      )}
    >
      {sheet ? (
        <>
          <img src={sheet.topBand} alt="" className="block h-auto w-full" />
          <div className="flex flex-col px-5 pt-1 pb-6 sm:px-10 sm:pb-8">{children}</div>
          <img src={sheet.bottomBand} alt="" className="block h-auto w-full" />
        </>
      ) : (
        children
      )}
    </article>
  )
}

/**
 * El membrete del papel, el mismo de su PDF: logo o iniciales, nombre, «razón
 * social · RUC» y, con una sola sede, su dirección. Lo usan las hojas que se firman.
 * Con la hoja membretada, su diseño dice quién es: queda la línea chica de sus datos.
 */
export function SheetLetterhead({ clinic }: { clinic: ConsentSheetClinic }): React.JSX.Element {
  if (clinic.sheet) {
    const line = [clinic.fiscalLine, clinic.branchName, clinic.address, clinic.phone].filter(Boolean).join(" · ")
    return (
      <header className="flex flex-col items-end text-right text-sm text-muted-foreground">
        <span className="sr-only">{clinic.name}</span>
        {line ? <span className="break-words">{line}</span> : null}
      </header>
    )
  }
  return (
    <header
      className="flex flex-wrap items-center gap-3 border-b-2 border-foreground pb-3"
      // La línea y las iniciales llevan el color de la marca, como el PDF (ADR 0162).
      style={clinic.brandInk ? { borderColor: clinic.brandInk } : undefined}
    >
      {clinic.logo ? (
        <img src={clinic.logo} alt="" className="h-12 max-w-32 object-contain" />
      ) : (
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center bg-foreground font-serif text-base font-semibold text-background"
          style={clinic.brandInk ? { backgroundColor: clinic.brandInk, color: "#ffffff" } : undefined}
        >
          {initialsOf(clinic.name)}
        </span>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="font-serif text-xl leading-tight font-semibold break-words">
          {clinic.name}
        </span>
        {clinic.fiscalLine ? (
          <span className="text-sm text-muted-foreground">{clinic.fiscalLine}</span>
        ) : null}
      </div>
      {clinic.branchName || clinic.address || clinic.phone ? (
        <div className="ml-auto flex min-w-0 flex-col text-right text-sm text-muted-foreground">
          {clinic.branchName ? <span className="font-medium">{clinic.branchName}</span> : null}
          {clinic.address ? <span>{clinic.address}</span> : null}
          {clinic.phone ? <span>{clinic.phone}</span> : null}
        </div>
      ) : null}
    </header>
  )
}

export interface ConsentSheetProps {
  clinic: ConsentSheetClinic | null
  title: string
  /** La pieza o zona: «Exodoncia pieza 38». */
  procedureRef?: string | null
  /** La fila de datos del papel: paciente, documento e historia clínica. */
  facts: { label: string; value: string; strong?: boolean }[]
  /** «CIE-10 MINSA · K04.0 · Pulpitis». */
  diagnosis?: string | null
  sections: Partial<ConsentSections> | null | undefined
  /** El texto completo de un consentimiento sin secciones (los antiguos). */
  body?: string | null
  declaration: string
  /** La casilla que acepta la declaración; recibe el id del texto para describirla. */
  accept?: (declarationId: string) => ReactNode
  /** Menor de edad: firma su representante legal, como avisa el papel. */
  minor?: boolean
  /** Quien firma: «Paciente» o «Representante legal», y lo que se escribe o dibuja. */
  signer?: { heading: string; name: string; detail?: string | null; children?: ReactNode }
  /** Lo que falta del profesional: se dice como pendiente, nunca como firmado. */
  professional?: { name?: string | null; detail?: string | null; note: string }
  /** «Firma en la clínica» y lo que pasa con su firma, al pie como en el papel. */
  signatureWords?: string | null
  signatureNote?: string | null
  /** Letra grande para leer en la tablet. */
  large?: boolean
  /** El título, para llevar ahí la vista y el foco al pasar al siguiente. */
  titleRef?: Ref<HTMLHeadingElement>
  className?: string
}

/**
 * La hoja del consentimiento en pantalla: lo mismo y en el mismo orden que su PDF
 * (`consent-pdf.ts`), para que quien firma lea lo que queda guardado. En pantalla
 * las firmas van una debajo de otra y el texto se acomoda al ancho; el papel las
 * pone lado a lado y pagina. Es papel: claro siempre, también con la app en oscuro.
 */
export function ConsentSheet({
  clinic,
  title,
  procedureRef,
  facts,
  diagnosis,
  sections,
  body,
  declaration,
  accept,
  minor = false,
  signer,
  professional,
  signatureWords,
  signatureNote,
  large = false,
  titleRef,
  className,
}: ConsentSheetProps): React.JSX.Element {
  const ids = useId()
  const titleId = `${ids}-title`
  const declarationId = `${ids}-declaration`
  const list = (items: string[] | undefined) =>
    items && items.length > 0 ? (
      <ul className="list-disc pl-6">
        {items.map((item, index) => (
          // Dos líneas iguales son posibles en un texto propio: la posición las distingue.
          // biome-ignore lint/suspicious/noArrayIndexKey: el orden de la lista no cambia en pantalla
          <li key={index}>{item}</li>
        ))}
      </ul>
    ) : null
  const section = (heading: string, content: ReactNode) =>
    content ? (
      <section className="flex flex-col gap-0.5">
        <h3 className="font-bold">{heading}</h3>
        {content}
      </section>
    ) : null
  return (
    <SheetPaper
      clinic={clinic}
      aria-labelledby={titleId}
      className={cn(large ? "text-lg leading-relaxed" : "text-base leading-normal", className)}
    >
      {clinic ? <SheetLetterhead clinic={clinic} /> : null}

      <p className="mt-5 text-sm font-semibold text-muted-foreground">Consentimiento informado</p>
      <h2
        id={titleId}
        ref={titleRef}
        tabIndex={-1}
        className="font-serif text-2xl leading-tight font-semibold break-words outline-none sm:text-3xl"
      >
        {title}
      </h2>
      {procedureRef ? <p className="mt-1 text-muted-foreground">{procedureRef}</p> : null}

      {facts.length > 0 ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-y py-3 sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 flex-col">
              <dt className="text-sm text-muted-foreground">{fact.label}</dt>
              <dd className={cn("break-words", fact.strong && "font-semibold")}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        {sections ? (
          <>
            {section(
              CONSENT_SECTION_LABELS.procedure,
              sections.procedure ? <p>{sections.procedure}</p> : null,
            )}
            {section(CONSENT_SECTION_LABELS.diagnosis, diagnosis ? <p>{diagnosis}</p> : null)}
            {section(CONSENT_SECTION_LABELS.benefits, list(sections.benefits))}
            {section(CONSENT_SECTION_LABELS.risks, list(sections.risks))}
            {section(CONSENT_SECTION_LABELS.alternatives, list(sections.alternatives))}
            {section(
              CONSENT_SECTION_LABELS.consequences,
              sections.consequences ? <p>{sections.consequences}</p> : null,
            )}
            {section(
              CONSENT_SECTION_LABELS.notes,
              sections.notes ? <p className="whitespace-pre-wrap">{sections.notes}</p> : null,
            )}
          </>
        ) : body ? (
          <p className="whitespace-pre-wrap">{body}</p>
        ) : null}
      </div>

      <section className="mt-6 flex flex-col gap-3 border border-foreground p-4 sm:p-5">
        <h3 className="font-bold">Declaración</h3>
        <p id={declarationId}>{declaration}</p>
        {accept ? accept(declarationId) : null}
      </section>

      {minor ? (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 text-base">
          <strong className="font-semibold">Menor de edad.</strong> Firma su representante legal.
        </p>
      ) : null}

      {signer || professional ? (
        <div className="mt-6 flex flex-col gap-6">
          {signer ? (
            <section className="flex flex-col gap-2">
              <h3 className="font-bold">{signer.heading}</h3>
              {signer.children}
              <div className="flex flex-col border-t border-foreground pt-1.5 text-base">
                <span className="font-semibold break-words">{signer.name}</span>
                {signer.detail ? (
                  <span className="text-muted-foreground">{signer.detail}</span>
                ) : null}
              </div>
            </section>
          ) : null}
          {professional ? (
            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Profesional que informa</h3>
              <div className="flex flex-col border-t border-foreground pt-1.5 text-base">
                {professional.name ? (
                  <span className="font-semibold break-words">{professional.name}</span>
                ) : null}
                {professional.detail ? (
                  <span className="text-muted-foreground">{professional.detail}</span>
                ) : null}
                <span className="text-muted-foreground">{professional.note}</span>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {signatureWords || signatureNote ? (
        <footer className="mt-6 border-t pt-3 text-sm text-muted-foreground">
          {signatureWords ? (
            <p className="font-semibold text-foreground">{signatureWords}</p>
          ) : null}
          {signatureNote ? <p>{signatureNote}</p> : null}
        </footer>
      ) : null}
    </SheetPaper>
  )
}
