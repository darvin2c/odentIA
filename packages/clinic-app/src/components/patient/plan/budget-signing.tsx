/**
 * La firma del presupuesto en la tablet: una pantalla completa para pasarle la
 * tablet a quien decide, con la hoja de «Su decisión» tal como sale en su PDF
 * (cada tratamiento con su importe y su respuesta, lo que acepta, la vigencia, la
 * declaración y el recuadro de firma), y el presupuesto completo a un toque. Al
 * terminar, la tablet vuelve al profesional, que guarda la respuesta con la
 * firma. Es opcional: volver deja el cajón como estaba para guardar sin firma.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@odentia/ui"
import { ConfirmDialog, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { apiFetch, apiFetchBytes } from "../../../lib/api"
import { budgetNumberLabel, budgetPdfUrl } from "../../../lib/budgets"
import type { ConsentLetterhead } from "../../../lib/clinical-forms"
import { SheetLetterhead, SheetPaper } from "../consent-sheet"
import { FirmaPad } from "../firma-pad"

/** Un tratamiento de la hoja: como la tabla de «Su decisión» del PDF. */
export interface BudgetSignRow {
  key: string
  title: string
  site: string | null
  amount: string
  answer: string
}

export interface BudgetSigner {
  name: string
  /** «Paciente» o «Representante legal», como lo dice su hoja. */
  role: string
}

interface BudgetSignFrame {
  clinic: ConsentLetterhead
  declaration: string
  signatureNote: string
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

export function BudgetSigningScreen({
  patientId,
  budgetId,
  budgetNumber,
  facts,
  rows,
  accepting,
  validUntil,
  signer,
  saving,
  onBack,
  onSave,
}: {
  patientId: string
  budgetId: string
  budgetNumber: number
  /** Paciente, documento e historia clínica, como el papel. */
  facts: { label: string; value: string }[]
  rows: BudgetSignRow[]
  /** «S/ 1,600.00»: lo que acepta, por moneda. */
  accepting: string
  validUntil: string | null
  signer: BudgetSigner
  saving: boolean
  /** Sin firma: vuelve al cajón tal como estaba. */
  onBack: () => void
  /** El profesional guarda la respuesta con la firma. */
  onSave: (strokes: number[][][]) => void
}): React.JSX.Element {
  const ids = useId()
  const frame = useQuery({
    queryKey: ["budget-sign-sheet", patientId, budgetId],
    queryFn: () => apiFetch<{ data: BudgetSignFrame }>(`/api/patients/${patientId}/budgets/${budgetId}/sign-sheet`),
    staleTime: 5 * 60_000,
  })
  const [step, setStep] = useState<"sign" | "confirm">("sign")
  const [strokes, setStrokes] = useState<number[][][]>([])
  const [missing, setMissing] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [showPdf, setShowPdf] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const padId = `${ids}-pad`

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [])

  const done = () => {
    if (strokes.length === 0) {
      setMissing(true)
      document.getElementById(padId)?.focus()
      return
    }
    setStep("confirm")
  }

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (value || saving) return
        if (strokes.length > 0) setLeaving(true)
        else onBack()
      }}
    >
      <DialogContent
        showCloseButton={!saving}
        aria-describedby={`${ids}-desc`}
        scrollable
        contentClassName="flex min-h-full flex-col gap-0 p-0"
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4 pr-16">
          <DialogTitle className="text-lg">
            {step === "sign" ? `Firma de ${firstName(signer.name)}` : "Guarda su respuesta"}
          </DialogTitle>
        </header>
        <DialogDescription id={`${ids}-desc`} className="sr-only">
          Pantalla completa para que quien decide lea su respuesta al presupuesto y firme con el dedo; al final guarda
          el profesional.
        </DialogDescription>

        <div className="flex w-full flex-1 flex-col bg-muted/40">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-3 py-6 text-lg sm:px-6">
            {frame.isPending ? (
              <LoadingState message="Preparando la hoja…" />
            ) : frame.isError ? (
              // Sin la hoja no se firma: la declaración es parte de lo que acepta.
              <ErrorState title="No se pudo preparar la hoja" onRetry={() => void frame.refetch()} />
            ) : step === "sign" ? (
              <SheetPaper clinic={frame.data?.data.clinic} aria-labelledby={`${ids}-title`}>
                {frame.data ? <SheetLetterhead clinic={frame.data.data.clinic} /> : null}
                <p className="mt-5 text-sm font-semibold text-muted-foreground">{budgetNumberLabel(budgetNumber)}</p>
                <h2
                  id={`${ids}-title`}
                  ref={titleRef}
                  tabIndex={-1}
                  className="font-serif text-2xl leading-tight font-semibold outline-none sm:text-3xl"
                >
                  Su decisión
                </h2>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-y py-3 sm:grid-cols-3">
                  {facts.map((fact) => (
                    <div key={fact.label} className="flex min-w-0 flex-col">
                      <dt className="text-sm text-muted-foreground">{fact.label}</dt>
                      <dd className="break-words">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
                <table className="mt-4 w-full text-base">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Tratamiento</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Importe</th>
                      <th className="py-1.5 text-right font-medium">Su respuesta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-b align-top">
                        <td className="py-2 pr-3">
                          <span className="block">{row.title}</span>
                          {row.site ? <span className="block text-sm text-muted-foreground">{row.site}</span> : null}
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">{row.amount}</td>
                        <td className="py-2 text-right font-semibold">{row.answer}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">Acepta</span>
                  <span className="text-xl font-semibold tabular-nums">{accepting}</span>
                </p>
                {validUntil ? <p className="text-base text-muted-foreground">Vale hasta el {validUntil}.</p> : null}
                <Button
                  type="button"
                  variant="link"
                  className="mt-2 h-auto self-start p-0 text-base"
                  aria-expanded={showPdf}
                  onClick={() => setShowPdf((value) => !value)}
                >
                  {showPdf ? "Ocultar el presupuesto completo" : "Ver el presupuesto completo"}
                </Button>
                {showPdf ? <BudgetPdfFrame patientId={patientId} budgetId={budgetId} /> : null}

                <section className="mt-6 flex flex-col gap-3 border border-foreground p-4 sm:p-5">
                  <h3 className="font-bold">Declaración</h3>
                  <p id={`${ids}-declaration`}>{frame.data?.data.declaration}</p>
                </section>

                <section className="mt-6 flex flex-col gap-2">
                  <h3 className="font-bold" id={`${ids}-pad-label`}>
                    Firma aquí con el dedo
                  </h3>
                  <FirmaPad
                    id={padId}
                    label={`Firma de ${signer.name}`}
                    invalid={missing}
                    describedBy={[`${ids}-declaration`, missing ? `${ids}-missing` : null].filter(Boolean).join(" ")}
                    onChange={(value) => {
                      setStrokes(value)
                      if (value.length > 0) setMissing(false)
                    }}
                  />
                  {missing ? (
                    <p id={`${ids}-missing`} role="alert" className="text-base text-destructive">
                      Falta la firma de {firstName(signer.name)}.
                    </p>
                  ) : null}
                  <div className="flex flex-col border-t border-foreground pt-1.5 text-base">
                    <span className="font-semibold break-words">{signer.name}</span>
                    <span className="text-muted-foreground">{signer.role}</span>
                  </div>
                </section>
                {frame.data?.data.signatureNote ? (
                  <footer className="mt-6 border-t pt-3 text-sm text-muted-foreground">
                    <p>{frame.data.data.signatureNote}</p>
                  </footer>
                ) : null}
              </SheetPaper>
            ) : (
              <div className="flex flex-col gap-3">
                <p>
                  <strong>Firmó {signer.name}.</strong>
                </p>
                <dl className="flex flex-col gap-1 rounded-lg border bg-card p-4 text-base">
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">Acepta</dt>
                    <dd className="font-semibold tabular-nums">{accepting}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">Decide</dt>
                    <dd>
                      {signer.name}, {signer.role.toLowerCase()}
                    </dd>
                  </div>
                </dl>
                <p className="text-base text-muted-foreground">
                  Falta guardar: con «Guardar con su firma» su respuesta queda anotada y su presupuesto muestra la
                  firma. Si la firma no quedó bien, «Volver a la firma».
                </p>
              </div>
            )}
          </div>
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-popover px-6 py-4">
          {step === "sign" ? (
            <Button type="button" size="lg" disabled={!frame.data} onClick={done}>
              Listo
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  // El recuadro vuelve en blanco: lo firmado antes no se guarda sin verse.
                  setStrokes([])
                  setStep("sign")
                }}
              >
                Volver a la firma
              </Button>
              <Button type="button" size="lg" disabled={saving} onClick={() => onSave(strokes)}>
                {saving ? "Guardando…" : "Guardar con su firma"}
              </Button>
            </>
          )}
        </footer>
        <ConfirmDialog
          open={leaving}
          variant="default"
          title="¿Salir sin la firma?"
          description="La firma no se guarda. La respuesta sigue en el cajón, sin guardar: puedes guardarla sin firma."
          confirmLabel="Salir sin la firma"
          cancelLabel={step === "confirm" ? "Volver" : "Seguir firmando"}
          onClose={() => setLeaving(false)}
          onConfirm={() => {
            setLeaving(false)
            onBack()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** El presupuesto completo, el mismo PDF que se le mostró. */
function BudgetPdfFrame({ patientId, budgetId }: { patientId: string; budgetId: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void apiFetchBytes(budgetPdfUrl(patientId, budgetId))
      .then((bytes) => {
        made = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
        if (alive) setUrl(made)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [patientId, budgetId])
  return (
    <div className="mt-3 h-[70dvh] overflow-hidden rounded-md border bg-muted/30">
      {url ? (
        <iframe title="Presupuesto completo" src={url} className="size-full" />
      ) : (
        <p className="p-4 text-base text-muted-foreground" role={failed ? "alert" : undefined}>
          {failed ? "No se pudo abrir el presupuesto. Cierra y vuelve a intentarlo." : "Preparando el presupuesto…"}
        </p>
      )}
    </div>
  )
}
