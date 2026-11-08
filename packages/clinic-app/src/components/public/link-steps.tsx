import { Button, Checkbox } from "@odentia/ui"
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
import type { ReactElement } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { fetchLinkConsent, fetchLinkQuestionnaire, type LinkConsent, signLinkConsent, submitLinkQuestionnaire } from "../../lib/booking-link"
import { appWords } from "../../lib/product-words"
import { ConsentSheet } from "../patient/consent-sheet"
import { FirmaPad } from "../patient/firma-pad"
import { AnswerAppField, isFieldVisible, missingRequired } from "../patient/form-fields"
import { longDay, timeLabel } from "./week-slots"

function problemOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : `${fallback} Revisa tu conexión y vuelve a intentarlo.`
}

/**
 * Por qué no se firma desde el teléfono, dicho a quien abre y por su consecuencia
 * (entrega 2, acta 3): al tutor, «Este lo firmas tú en la cita de Mateo»; al propio
 * menor, que lo firma su madre, padre o tutor; a la persona, «Este lo firmas en tu cita».
 */
export function unsignableWords(consent: Pick<LinkConsent, "why" | "speaksTo" | "patientFirstName">): { notice: string; inPlace: string } {
  // Sin documento en su ficha: lo pone en «Tus datos» y después firma aquí (decidido el 8 nov).
  if (consent.why === "sin-documento") {
    return { notice: "Para firmar desde aquí, primero completa tus datos.", inPlace: "Firmas aquí cuando completes tus datos" }
  }
  if (consent.speaksTo === "representante") {
    const name = consent.patientFirstName || "tu familiar"
    return { notice: `Este lo firmas tú en la cita de ${name}, antes de empezar.`, inPlace: `Este lo firmas tú en la cita de ${name}` }
  }
  if (consent.why === "menor") {
    return { notice: "Este lo firma tu madre, padre o tutor en tu cita, antes de empezar.", inPlace: "Lo firma tu madre, padre o tutor en tu cita" }
  }
  return { notice: "Este lo firmas en tu cita, antes de empezar.", inPlace: "Lo firmas en tu cita" }
}

/**
 * «jueves, 13 de noviembre, 10:00 a. m.»: la cita para la que es, en la zona de su sede.
 * En minúscula: se lee seguido de «Para la cita del». El PDF no lleva esta línea.
 */
export function appointmentWords(appointment: { startsAt: string; timeZone: string } | null): string | null {
  return appointment ? `${longDay(appointment.startsAt, appointment.timeZone).toLowerCase()}, ${timeLabel(appointment.startsAt, appointment.timeZone)}` : null
}

/**
 * «Tu consentimiento» (tablero 2, «Antes de llegar»): lo lee, escribe su
 * documento, confirma que entendió y firma. Queda firmado por la persona y
 * pendiente de que el profesional lo confirme en la clínica: no se presenta
 * como firma certificada. Si no se puede firmar desde el teléfono (`signable`),
 * el aviso va arriba, antes de leer, la hoja se lee entera y donde iba la firma
 * dice «Lo firmas en tu cita»: es la misma hoja, nunca otra dibujada aparte.
 * Al firmar avisa a la página (`onSigned`), que dice «Listo» y lo que sigue.
 */
export function LinkConsentStep({
  slug,
  token,
  consentId,
  onSigned,
  completeData,
}: {
  slug: string
  token: string
  consentId: string
  onSigned: () => void
  /** El enlace a «Tus datos», para quien no puede firmar porque a su ficha le falta el documento. */
  completeData?: ReactElement
}) {
  const query = useQuery({ queryKey: ["link-consent", slug, token, consentId], queryFn: () => fetchLinkConsent(slug, token, consentId), retry: false })
  const sign = useMutation({
    retry: false,
    mutationFn: (input: { docNumber: string; comprehensionConfirmed: boolean; signatureData: { strokes: number[][][] } }) =>
      signLinkConsent(slug, token, consentId, input),
    onSuccess: () => onSigned(),
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
  if (query.isPending) return <LoadingState kind="indeterminate" message="Abriendo el consentimiento…" />
  if (query.isError) return <ErrorState title="No pudimos abrir el consentimiento" message={problemOf(query.error, "Vuelve a intentarlo.")} onRetry={() => void query.refetch()} />
  const consent = query.data.data
  const when = appointmentWords(consent.appointment)
  // U6: la hoja dice lo que se consiente (`procedureRef`) y para qué cita es.
  const facts = [
    { label: "Paciente", value: consent.patient.name, strong: true },
    { label: "Historia clínica", value: consent.patient.chartNumber },
    ...(when ? [{ label: "Para la cita del", value: when }] : []),
  ]
  const clinician = appWords().clinician.one
  if (!consent.signable) {
    const words = unsignableWords(consent)
    return (
      <div className="flex flex-col gap-4">
        {/* No es un error: se dice antes de leer, como texto, para que no lo descubra al final. */}
        <div className="flex flex-col gap-1 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
          <p className="font-semibold">{words.notice}</p>
          <p className="text-sm">
            {consent.why === "sin-documento"
              ? "Te pedimos tu documento una vez en «Tus datos»; al firmar lo vuelves a escribir para comprobar que eres tú."
              : `Puedes leerlo ahora con calma.${consent.why === "sin-fecha" ? " Los datos que nos faltan los completamos contigo en la clínica." : ""}`}
          </p>
          {consent.why === "sin-documento" && completeData ? (
            <Button className="mt-2 min-h-11 self-start" render={completeData}>
              Completar mis datos
            </Button>
          ) : null}
        </div>
        <ConsentSheet
          className="-mx-2 sm:mx-0"
          clinic={consent.clinic}
          title={consent.title}
          procedureRef={consent.procedureRef}
          facts={facts}
          diagnosis={consent.diagnosis}
          sections={consent.sections}
          body={consent.body}
          declaration={consent.declaration}
          minor={consent.minor}
          signer={{
            heading: consent.signer.asRepresentative ? "Representante legal" : "Paciente",
            name: consent.signer.name,
            // Donde iba la firma: la línea vacía y cuándo se firma. Sin documento ni botón.
            children: (
              <p className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-foreground/40 px-3 text-center text-base text-muted-foreground">
                {words.inPlace}
              </p>
            ),
          }}
          professional={{ note: `Lo revisa contigo tu ${clinician} en la cita.` }}
          signatureWords={consent.signatureWords}
          signatureNote={consent.signatureNote}
        />
      </div>
    )
  }
  return (
    // La hoja es la del papel que recibe: se lee entera en la página, sin otra barra que la de siempre.
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <ConsentSheet
        className="-mx-2 sm:mx-0"
        clinic={consent.clinic}
        title={consent.title}
        procedureRef={consent.procedureRef}
        facts={facts}
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
        professional={{ note: `Falta su confirmación: lo confirma tu ${clinician} en la clínica.` }}
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

/** «Antes de tu cita»: el cuestionario de la clínica, en una sola página. Al enviarlo avisa a la página (`onSent`). */
export function LinkQuestionnaireStep({ slug, token, onSent }: { slug: string; token: string; onSent: () => void }) {
  const query = useQuery({ queryKey: ["link-questionnaire", slug, token], queryFn: () => fetchLinkQuestionnaire(slug, token), retry: false })
  const send = useMutation({
    retry: false,
    mutationFn: (answers: Record<string, unknown>) => submitLinkQuestionnaire(slug, token, answers),
    onSuccess: () => onSent(),
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
