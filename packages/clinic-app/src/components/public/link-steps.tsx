import { Checkbox } from "@odentia/ui"
import {
  ErrorState,
  FormChoiceField,
  LoadingState,
  SubmitButton,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleCheck } from "lucide-react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { fetchLinkConsent, fetchLinkQuestionnaire, signLinkConsent, submitLinkQuestionnaire } from "../../lib/booking-link"
import { ConsentSheet } from "../patient/consent-sheet"
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
        signatureData: z.array(z.array(z.array(z.number()))).min(1, "Firma con el dedo en el recuadro."),
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
    // La hoja es la del papel que recibe: se lee entera en la página, sin otra barra que la de siempre.
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <ConsentSheet
        className="-mx-2 sm:mx-0"
        clinic={consent.clinic}
        title={consent.title}
        procedureRef={consent.procedureRef}
        facts={[
          { label: "Paciente", value: consent.patient.name, strong: true },
          { label: "Historia clínica", value: consent.patient.chartNumber },
        ]}
        diagnosis={consent.diagnosis}
        sections={consent.sections}
        body={consent.body}
        declaration={consent.declaration}
        minor={consent.minor}
        accept={(declarationId) => (
          <form.AppField name="comprehensionConfirmed">
            {(field) => (
              <FormChoiceField
                id="consent-understood"
                label={<strong className="text-base">Entendí lo que me explicaron y acepto</strong>}
                className="min-h-11"
              >
                {(control) => (
                  <Checkbox
                    className="mt-0.5 size-6 border-foreground"
                    id={control.id}
                    name={control.name}
                    checked={field.state.value === true}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={[declarationId, control.describedBy].filter(Boolean).join(" ")}
                    onCheckedChange={(value) => {
                      field.handleChange(value === true)
                      field.handleBlur()
                    }}
                  />
                )}
              </FormChoiceField>
            )}
          </form.AppField>
        )}
        signer={{
          heading: consent.signer.asRepresentative ? "Representante legal" : "Paciente",
          name: consent.signer.name,
          children: (
            <>
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
              <form.AppField name="signatureData">
                {(field) => (
                  <field.Group legend="Firma aquí con el dedo">
                    {(control) => (
                      // En el teléfono el recuadro toma también el margen de la hoja: más alto para el dedo.
                      <div className="-mx-3 sm:mx-0">
                      <FirmaPad
                        label="Tu firma"
                        id={control.id}
                        invalid={control.invalid}
                        describedBy={control.describedBy}
                        onChange={(strokes) => field.handleChange(strokes)}
                      />
                      </div>
                    )}
                  </field.Group>
                )}
              </form.AppField>
            </>
          ),
        }}
        professional={{ note: `Falta su confirmación: lo confirma tu ${appWords().clinician.one} en la clínica.` }}
        signatureWords={consent.signatureWords}
        signatureNote={consent.signatureNote}
      />
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
