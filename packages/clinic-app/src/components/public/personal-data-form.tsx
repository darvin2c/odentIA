import type { RegistrationAnswers } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleCheck } from "lucide-react"
import { useMemo, useState } from "react"
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

/** Si respondió algo de su salud (saltarla no declara nada). */
function declaresHealth(health: RegistrationAnswers["health"]): boolean {
  if (!health) return false
  if (health.bloodGroup) return true
  if ([health.allergies, health.conditions, health.medications].some((group) => group && group.state !== "unanswered")) return true
  return [health.personal, health.dental].some((group) => Object.keys(group ?? {}).length > 0)
}

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
    health: declaresHealth(answers.health) ? (answers.health ?? null) : null,
    ...(pending.privacy ? { privacyAccepted: answers.privacyAccepted } : {}),
    ...(pending.promotions && answers.acceptsMessages !== undefined ? { acceptsPromotions: answers.acceptsMessages } : {}),
  }
}

/** Si hay algo que enviar: un dato, su salud o lo que acepta. Solo su salud y nada respondido no se envía. */
function sendsSomething(input: PersonalDataInput): boolean {
  return Object.keys(input.data).length > 0 || !!input.health || input.privacyAccepted !== undefined || input.acceptsPromotions !== undefined
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
  appointmentLine,
  backLabel,
  onDone,
}: {
  slug: string
  token: string
  clinicName: string
  /** «Te esperamos el jueves 23 a las 10:00.», si tiene cita. */
  appointmentLine?: string | null
  /** El nombre de volver, el mismo de toda la página: «Ver mi cita». */
  backLabel: string
  onDone: () => void
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
  // Solo su salud y no contó nada: no hay nada que enviar; la tarjeta sigue ahí, opcional.
  const [nothingToTell, setNothingToTell] = useState(false)
  const alreadySent = send.error instanceof ApiError && send.error.shape.code === "DATA_ALREADY_SENT"
  if (nothingToTell) {
    return (
      <div role="status" className="flex flex-col items-center gap-4 rounded-3xl border bg-card px-5 py-10 text-center">
        <p className="text-sm text-pretty text-muted-foreground">
          No nos contaste nada de tu salud. Si quieres, cuéntanoslo antes de venir o en la cita.
          {appointmentLine ? ` ${appointmentLine}` : ""}
        </p>
        <Button type="button" variant="link" className="min-h-11" onClick={onDone}>
          {backLabel}
        </Button>
      </div>
    )
  }
  if (send.isSuccess || alreadySent) {
    const form = formQuery.data?.data
    const withHealth = !!form?.asksHealth && !!send.variables?.health
    const onlyHealth = !!form && form.missing.length === 0
    return (
      <div role="status" className="flex flex-col items-center gap-4 rounded-3xl border bg-card px-5 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CircleCheck className="size-6" aria-hidden />
        </span>
        <div className="flex flex-col gap-1.5">
          <p className="text-xl font-semibold">{form?.firstName ? `Listo, ${form.firstName}` : "Listo"}</p>
          <p className="text-sm text-pretty text-muted-foreground">
            {alreadySent
              ? `${clinicName} ya tiene tus datos.`
              : onlyHealth
                ? `${clinicName} ya tiene ${withHealth ? "lo que nos contaste de tu salud" : "tus respuestas"}.`
                : `${clinicName} ya tiene tus datos${withHealth ? " y tu salud" : ""}.`}
            {appointmentLine ? ` ${appointmentLine}` : ""}
          </p>
        </div>
        <Button type="button" variant="link" className="min-h-11" onClick={onDone}>
          {backLabel}
        </Button>
      </div>
    )
  }
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
          hasRepresentative: form.hasRepresentative,
          firstName: form.firstName,
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
            setNothingToTell(true)
            return
          }
          try {
            await send.mutateAsync(input)
          } catch (error) {
            if (error instanceof ApiError && error.shape.code === "DATA_ALREADY_SENT") return
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
