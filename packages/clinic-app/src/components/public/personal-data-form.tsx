import { declaredHealthAnswered, isChildAge, type RegistrationAnswers } from "@odentia/clinical"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { publicAddressSource } from "../../lib/address-suggestions"
import { ApiError } from "../../lib/api"
import { fetchPersonalDataForm, type PersonalDataForm as PersonalDataFormView, type PersonalDataInput, submitPersonalData } from "../../lib/booking-link"
import { RegistrationQuestionnaire } from "../patient/registration-questionnaire"

/** Lo que «Tus datos» puede completar (las mismas claves que acepta el servidor). */
const DATA_KEYS = [
  "givenNames",
  "familyName",
  "birthDate",
  "docType",
  "docNumber",
  "docCountry",
  "sex",
  "nationality",
  "birthPlace",
  "phone",
  "email",
  "address",
  "addressCity",
  "addressReference",
  "emergencyContactName",
  "emergencyContactPhone",
  "emergencyContactRelationship",
  "insuranceType",
  "insuranceScheme",
  "insurerName",
  "affiliationNumber",
] as const


/** Las respuestas del cuestionario, como las guarda «Tus datos», con lo que aún no aceptó o respondió. */
function toInput(answers: RegistrationAnswers, pending: PersonalDataFormView["pending"]): PersonalDataInput {
  const demographics = answers.demographics as Record<string, unknown>
  const data: Partial<Record<string, string>> = {}
  for (const key of DATA_KEYS) {
    const value = demographics[key]
    if (typeof value === "string" && value.trim()) data[key] = value.trim()
  }
  const rep = answers.representative
  return {
    data,
    representative: rep
      ? {
          displayName: rep.displayName,
          ...(rep.docType ? { docType: rep.docType } : {}),
          ...(rep.docNumber ? { docNumber: rep.docNumber } : {}),
          ...(rep.phone ? { phone: rep.phone } : {}),
          ...(rep.relationshipDetail ? { relationshipDetail: rep.relationshipDetail } : {}),
        }
      : null,
    health: declaredHealthAnswered(answers.health) ? (answers.health ?? null) : null,
    ...(pending.privacy ? { privacyAccepted: answers.privacyAccepted } : {}),
    ...(pending.promotions && answers.acceptsMessages !== undefined ? { acceptsPromotions: answers.acceptsMessages } : {}),
    ...(answers.acceptsReminders && data.phone ? { acceptsReminders: true } : {}),
  }
}

/** Si hay algo que enviar: un dato, su salud o lo que acepta. Solo su salud y nada respondido no se envía. */
function sendsSomething(input: PersonalDataInput): boolean {
  return Object.keys(input.data).length > 0 || !!input.health || input.privacyAccepted !== undefined || input.acceptsPromotions !== undefined
}

/**
 * Lo que dice la página al terminar. Del enlace de un niño (menor de 12) se le
 * habla a quien lo cuida, con el nombre del niño: «Listo, Carla», «ya tiene lo
 * que nos contaste de la salud de Thiago» (mesa del 13 nov, entrega 7).
 */
export function personalDataSentWords(
  form: Pick<PersonalDataFormView, "firstName" | "age" | "respondentFirstName" | "missing">,
  clinicName: string,
  outcome: "nada" | "con-salud" | "sin-salud" | "ya-enviado",
): { title: string; text: string } {
  const child = isChildAge(form.age) && !!form.firstName
  const greeted = child ? form.respondentFirstName : form.firstName
  const listo = greeted ? `Listo, ${greeted}` : "Listo"
  const health = child ? `la salud de ${form.firstName}` : "tu salud"
  const data = child ? `los datos de ${form.firstName}` : "tus datos"
  if (outcome === "nada")
    return { title: "Gracias", text: `No nos contaste nada de ${health}. Si quieres, cuéntanoslo antes de venir o en la cita.` }
  if (outcome === "ya-enviado") return { title: listo, text: `${clinicName} ya tiene ${data}.` }
  const withHealth = outcome === "con-salud"
  return {
    title: listo,
    text:
      form.missing.length === 0
        ? `${clinicName} ya tiene ${withHealth ? `lo que nos contaste de ${health}` : "tus respuestas"}.`
        : `${clinicName} ya tiene ${data}${withHealth ? ` y ${child ? "su salud" : "tu salud"}` : ""}.`,
  }
}

/**
 * «Tus datos» de «Su enlace»: el mismo cuestionario por temas del registro,
 * solo con lo que falta y, si nadie la registró aún, su salud (opcional; sin
 * nada que falte, la pantalla es solo «Tu salud»). Al final, si aún no lo
 * aceptó o respondió, el aviso de privacidad y las novedades. Nunca muestra lo
 * guardado. Las reglas (qué se acepta, el documento repetido, el menor sin
 * representante) son del servidor.
 */
export function PersonalDataForm({
  slug,
  token,
  clinicName,
  onSent,
}: {
  slug: string
  token: string
  clinicName: string
  /** Lo envió (o no había nada que enviar): la página dice «Listo» con estas palabras y lo que sigue. */
  onSent: (words: { title: string; text: string }) => void
}) {
  // La dirección se sugiere por la página de la clínica, sin el token (issue 36).
  const addressSource = useMemo(() => publicAddressSource(slug), [slug])
  const formQuery = useQuery({
    queryKey: ["personal-link-data", slug, token],
    queryFn: () => fetchPersonalDataForm(slug, token),
    retry: false,
  })
  const send = useMutation({
    retry: false,
    mutationFn: (input: PersonalDataInput) => submitPersonalData(slug, token, input),
  })
  if (formQuery.isPending) return <LoadingState kind="indeterminate" message="Cargando…" />
  if (formQuery.isError) {
    if (formQuery.error instanceof ApiError && formQuery.error.shape.code === "BOOKING_LINK_EXPIRED") {
      return <ErrorState title="Tus datos ya están en la clínica" message="Este paso ya no está pendiente." />
    }
    return <ErrorState title="No pudimos abrir tus datos" message="Vuelve a intentarlo en un momento." onRetry={() => void formQuery.refetch()} />
  }
  const form = formQuery.data.data
  return (
    <div className="rounded-3xl border bg-card p-5 sm:p-6">
      <RegistrationQuestionnaire
        config={form.registration}
        today={form.today}
        countryCode={form.countryCode}
        fill={{
          missing: new Set(form.missing.map((item) => item.key)),
          health: form.asksHealth,
          // De su salud, solo lo que falta: lo que ya se sabe no se le muestra.
          healthKeys: new Set(form.healthQuestions ?? []),
          hasRepresentative: form.hasRepresentative,
          firstName: form.firstName,
          age: form.age ?? null,
          respondentFirstName: form.respondentFirstName ?? null,
          privacy: form.pending.privacy,
          promotions: form.pending.promotions,
          clinicName,
        }}
        submitLabel="Enviar"
        shortcuts={false}
        addressSource={addressSource}
        onSubmit={async (answers) => {
          const input = toInput(answers, form.pending)
          if (!sendsSomething(input)) {
            // Queda dicho que ya respondió, para no volver a pedírselo; si falla, no pasa nada.
            if (form.missing.length === 0) void submitPersonalData(slug, token, input).catch(() => undefined)
            // Solo su salud y no contó nada: no hay nada que enviar; la tarjeta sigue ahí, opcional.
            onSent(personalDataSentWords(form, clinicName, "nada"))
            return
          }
          const withHealth = form.asksHealth && !!input.health
          try {
            await send.mutateAsync(input)
            onSent(personalDataSentWords(form, clinicName, withHealth ? "con-salud" : "sin-salud"))
          } catch (error) {
            if (error instanceof ApiError && error.shape.code === "DATA_ALREADY_SENT") {
              onSent(personalDataSentWords(form, clinicName, "ya-enviado"))
              return
            }
            // Lo que es de un dato, el cuestionario lo dice en su campo.
            if (error instanceof ApiError && Object.keys(error.shape.fields ?? {}).length > 0) throw error
            throw new Error(
              error instanceof ApiError
                ? (error.shape.message ?? "No pudimos guardar tus datos.")
                : "No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo.",
            )
          }
        }}
      />
    </div>
  )
}
