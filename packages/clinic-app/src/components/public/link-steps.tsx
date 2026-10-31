import type { ConsentSections } from "@odentia/clinical"
import { ScrollArea } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleCheck } from "lucide-react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { fetchLinkConsent, fetchLinkQuestionnaire, signLinkConsent, submitLinkQuestionnaire } from "../../lib/booking-link"
import { FirmaPad } from "../patient/firma-pad"
import { AnswerAppField, isFieldVisible, missingRequired } from "../patient/form-fields"
import { appWords } from "../../lib/product-words"

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

/** Lo que lee el paciente antes de firmar; la clínica lo ve igual en su vista previa. */
export function ConsentReading({
  sections,
  body,
}: {
  sections: Partial<ConsentSections> | null | undefined
  body: string | null | undefined
}) {
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
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
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
      {body ? <p className="whitespace-pre-wrap">{body}</p> : null}
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
  const query = useQuery({ queryKey: ["link-consent", slug, token, consentId], queryFn: () => fetchLinkConsent(slug, token, consentId), retry: false })
  const sign = useMutation({
    retry: false,
    mutationFn: (input: { docNumber: string; comprehensionConfirmed: boolean; signatureData: { strokes: number[][][] } }) =>
      signLinkConsent(slug, token, consentId, input),
  })
  const docLabel = query.data?.data.signer.documentLabel ?? "documento"
  const form = useAppForm({
    defaultValues: { docNumber: "", comprehensionConfirmed: false, signatureData: [] as number[][][] },
    // Cada cosa que falta se dice en su lugar, con los mismos límites que la API.
    validators: {
      onSubmit: z.object({
        docNumber: z.string().trim().min(1, `Escribe tu ${docLabel}.`).max(40, "Escribe como mucho 40 caracteres."),
        comprehensionConfirmed: z.boolean().refine((value) => value, "Marca que entendiste lo que te explicaron y aceptas."),
        signatureData: z.array(z.array(z.array(z.number()))).min(1, "Firma con el dedo o el mouse en el recuadro."),
      }),
    },
    onSubmit: async ({ value }) => {
      await sign.mutateAsync({
        docNumber: value.docNumber.trim(),
        comprehensionConfirmed: value.comprehensionConfirmed,
        signatureData: { strokes: value.signatureData },
      })
    },
  })
  const submit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  if (sign.isSuccess) return <Done title="Firmado, gracias" text={`Tu ${appWords().clinician.one} lo revisa contigo antes de empezar.`} onBack={onBack} />
  if (query.isPending) return <LoadingState kind="indeterminate" message="Abriendo el consentimiento…" />
  if (query.isError) return <ErrorState title="No pudimos abrir el consentimiento" message={problemOf(query.error, "Vuelve a intentarlo.")} onRetry={() => void query.refetch()} />
  const consent = query.data.data
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <h2 className="text-lg font-semibold">{consent.title}</h2>
      <ScrollArea className="flex max-h-[50svh] flex-col rounded-2xl border bg-card">
        <ConsentReading sections={consent.sections} body={consent.body} />
      </ScrollArea>
      <p className="text-sm text-muted-foreground">
        Firma {consent.signer.name}
        {consent.signer.asRepresentative ? ", como su representante" : ""}.
      </p>
      <form.AppField name="docNumber">
        {(field) => (
          <field.TextField
            label={`Escribe tu ${docLabel}`}
            id="consent-doc"
            description="Lo comparamos con el de tu ficha; no lo mostramos."
            inputClassName="min-h-11"
            autoComplete="off"
            maxLength={20}
          />
        )}
      </form.AppField>
      <form.AppField name="comprehensionConfirmed">
        {(field) => <field.CheckboxField label="Entendí lo que me explicaron y acepto" id="consent-understood" className="min-h-11" />}
      </form.AppField>
      <form.AppField name="signatureData">
        {(field) => (
          <field.Group legend="Tu firma">
            {(control) => (
              <FirmaPad
                label="Tu firma"
                id={control.id}
                invalid={control.invalid}
                describedBy={control.describedBy}
                onChange={(strokes) => field.handleChange(strokes)}
              />
            )}
          </field.Group>
        )}
      </form.AppField>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SubmitButton type="submit" className="min-h-11 w-full" pending={pending}>
        Firmar
      </SubmitButton>
    </form>
  )
}

/** «Antes de tu cita»: el cuestionario de la clínica, en una sola página. */
export function LinkQuestionnaireStep({ slug, token, onBack }: { slug: string; token: string; onBack: () => void }) {
  const query = useQuery({ queryKey: ["link-questionnaire", slug, token], queryFn: () => fetchLinkQuestionnaire(slug, token), retry: false })
  const send = useMutation({
    retry: false,
    mutationFn: (answers: Record<string, unknown>) => submitLinkQuestionnaire(slug, token, answers),
  })
  const schema = query.data?.data.schema ?? null
  const form = useAppForm({
    defaultValues: { answers: {} as Record<string, unknown> },
    validators: {
      // Lo obligatorio que falta se dice en su pregunta.
      onSubmit: ({ value }) => {
        const missing = schema ? missingRequired(schema, value.answers) : []
        if (missing.length === 0) return undefined
        return { fields: Object.fromEntries(missing.map((field) => [`answers.${field.id}`, "Responde esta pregunta."])) }
      },
    },
    onSubmit: async ({ value }) => {
      await send.mutateAsync(value.answers)
    },
  })
  const submit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const answers = useStore(form.store, (state) => state.values.answers)
  if (send.isSuccess) return <Done title="Gracias, recibimos tus respuestas" text={`Tu ${appWords().clinician.one} las revisa contigo en la cita.`} onBack={onBack} />
  if (query.isPending) return <LoadingState kind="indeterminate" message="Abriendo el cuestionario…" />
  if (query.isError) return <ErrorState title="No pudimos abrir el cuestionario" message={problemOf(query.error, "Vuelve a intentarlo.")} onRetry={() => void query.refetch()} />
  const questionnaire = query.data.data
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <h2 className="text-lg font-semibold">{questionnaire.title}</h2>
      {questionnaire.schema.sections.map((section) => (
        <fieldset key={section.id} className="m-0 flex flex-col gap-4 rounded-2xl border bg-card p-4">
          <legend className="px-1 text-sm font-semibold">{section.title}</legend>
          {section.fields
            .filter((field) => isFieldVisible(field, answers))
            .map((field) => (
              <form.AppField key={field.id} name={`answers.${field.id}`}>
                {() => <AnswerAppField field={field} />}
              </form.AppField>
            ))}
        </fieldset>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SubmitButton type="submit" className="min-h-11 w-full" pending={pending}>
        Enviar respuestas
      </SubmitButton>
    </form>
  )
}
