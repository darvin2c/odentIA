import { Checkbox, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleCheck } from "lucide-react"
import { useState } from "react"
import { ApiError } from "../../lib/api"
import { fetchLinkConsent, fetchLinkQuestionnaire, signLinkConsent, submitLinkQuestionnaire } from "../../lib/booking-link"
import { FirmaPad } from "../patient/firma-pad"
import { AnswerInput, isFieldVisible, missingRequired } from "../patient/form-fields"

function problemOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : `${fallback} Revisa tu conexión y vuelve a intentarlo.`
}

function Done({ title, text, onBack }: { title: string; text: string; onBack: () => void }) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center">
      <CircleCheck className="size-8 text-success" aria-hidden />
      <p className="text-lg font-semibold">{title}</p>
      <p className="text-sm">{text}</p>
      <SubmitButton type="button" variant="outline" className="mt-2 min-h-11" pending={false} onClick={onBack}>
        Volver a lo pendiente
      </SubmitButton>
    </div>
  )
}

/**
 * «Tu consentimiento» (tablero 2, «Antes de llegar»): lo lee, escribe su
 * documento, confirma que entendió y firma. Queda firmado por la persona y
 * pendiente de que el profesional lo confirme en la clínica: no se presenta
 * como firma certificada.
 */
export function LinkConsentStep({ slug, token, consentId, onBack }: { slug: string; token: string; consentId: string; onBack: () => void }) {
  const [docNumber, setDocNumber] = useState("")
  const [understood, setUnderstood] = useState(false)
  const [strokes, setStrokes] = useState<number[][][]>([])
  const query = useQuery({ queryKey: ["link-consent", slug, token, consentId], queryFn: () => fetchLinkConsent(slug, token, consentId), retry: false })
  const sign = useMutation({
    retry: false,
    mutationFn: () => signLinkConsent(slug, token, consentId, { docNumber: docNumber.trim(), comprehensionConfirmed: understood, signatureData: { strokes } }),
  })
  if (sign.isSuccess) return <Done title="Firmado, gracias" text="Tu odontólogo lo revisa contigo antes de empezar." onBack={onBack} />
  if (query.isPending) return <LoadingState kind="indeterminate" message="Abriendo el consentimiento…" />
  if (query.isError) return <ErrorState title="No pudimos abrir el consentimiento" message={problemOf(query.error, "Vuelve a intentarlo.")} onRetry={() => void query.refetch()} />
  const consent = query.data.data
  const sections = consent.sections
  const list = (title: string, items: string[] | undefined) =>
    items && items.length > 0 ? (
      <div>
        <p className="font-semibold">{title}</p>
        <ul className="list-disc pl-5">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null
  const docLabel = consent.signer.documentLabel ?? "documento"
  const ready = docNumber.trim().length > 0 && understood && strokes.length > 0
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{consent.title}</h2>
      <div className="flex max-h-[50svh] flex-col gap-3 overflow-y-auto rounded-2xl border bg-card p-4 text-sm">
        {sections?.procedure ? (
          <div>
            <p className="font-semibold">Qué te van a hacer</p>
            <p>{sections.procedure}</p>
          </div>
        ) : null}
        {list("Beneficios", sections?.benefits)}
        {list("Riesgos", sections?.risks)}
        {list("Otras opciones", sections?.alternatives)}
        {sections?.consequences ? (
          <div>
            <p className="font-semibold">Si no te lo haces</p>
            <p>{sections.consequences}</p>
          </div>
        ) : null}
        {consent.body ? <p className="whitespace-pre-wrap">{consent.body}</p> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Firma {consent.signer.name}
        {consent.signer.asRepresentative ? ", como su representante" : ""}.
      </p>
      <Field>
        <FieldLabel htmlFor="consent-doc">Escribe tu {docLabel}</FieldLabel>
        <Input id="consent-doc" className="min-h-11" autoComplete="off" maxLength={20} value={docNumber} onChange={(event) => setDocNumber(event.target.value)} />
        <FieldDescription>Lo comparamos con el de tu ficha; no lo mostramos.</FieldDescription>
      </Field>
      <label htmlFor="consent-understood" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <Checkbox id="consent-understood" checked={understood} onCheckedChange={(next) => setUnderstood(next === true)} />
        Entendí lo que me explicaron y acepto
      </label>
      <FirmaPad label="Tu firma" onChange={setStrokes} />
      {sign.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemOf(sign.error, "No pudimos guardar tu firma.")}
        </p>
      ) : null}
      <SubmitButton type="button" className="min-h-11 w-full" pending={sign.isPending} disabled={!ready} onClick={() => sign.mutate()}>
        Firmar
      </SubmitButton>
    </div>
  )
}

/** «Antes de tu cita»: el cuestionario de la clínica, en una sola página. */
export function LinkQuestionnaireStep({ slug, token, onBack }: { slug: string; token: string; onBack: () => void }) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const query = useQuery({ queryKey: ["link-questionnaire", slug, token], queryFn: () => fetchLinkQuestionnaire(slug, token), retry: false })
  const send = useMutation({
    retry: false,
    mutationFn: () => submitLinkQuestionnaire(slug, token, answers),
    onError: (error) => setProblem(problemOf(error, "No pudimos enviar tus respuestas.")),
  })
  if (send.isSuccess) return <Done title="Gracias, recibimos tus respuestas" text="Tu odontólogo las revisa contigo en la cita." onBack={onBack} />
  if (query.isPending) return <LoadingState kind="indeterminate" message="Abriendo el cuestionario…" />
  if (query.isError) return <ErrorState title="No pudimos abrir el cuestionario" message={problemOf(query.error, "Vuelve a intentarlo.")} onRetry={() => void query.refetch()} />
  const questionnaire = query.data.data
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{questionnaire.title}</h2>
      {questionnaire.schema.sections.map((section) => (
        <fieldset key={section.id} className="m-0 flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <legend className="px-1 text-sm font-semibold">{section.title}</legend>
          {section.fields
            .filter((field) => isFieldVisible(field, answers))
            .map((field) => (
              <AnswerInput
                key={field.id}
                field={field}
                value={answers[field.id]}
                onChange={(value) => {
                  setProblem(null)
                  setAnswers({ ...answers, [field.id]: value })
                }}
              />
            ))}
        </fieldset>
      ))}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <SubmitButton
        type="button"
        className="min-h-11 w-full"
        pending={send.isPending}
        onClick={() => {
          const pending = missingRequired(questionnaire.schema, answers)
          if (pending.length > 0) {
            setProblem(`Falta responder: ${pending.map((field) => field.label).join(", ")}`)
            return
          }
          send.mutate()
        }}
      >
        Enviar respuestas
      </SubmitButton>
    </div>
  )
}
