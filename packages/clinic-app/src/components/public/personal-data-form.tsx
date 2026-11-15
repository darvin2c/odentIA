import { ageInYears, declaredHealthAnswered, isChildAge, type RegistrationAnswers, type VisitAnswerInput } from "@odentia/clinical"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { publicAddressSource } from "../../lib/address-suggestions"
import { ApiError } from "../../lib/api"
import { fetchPersonalDataForm, type PersonalDataForm as PersonalDataFormView, type PersonalDataInput, submitPersonalData } from "../../lib/booking-link"
import { clearDeviceDraft } from "../../lib/device-draft"
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


/** Las respuestas del cuestionario, como las guarda «Tus datos», con lo que aún no aceptó o respondió y su visita. */
function toInput(answers: RegistrationAnswers, pending: PersonalDataFormView["pending"], visit: VisitAnswerInput | null): PersonalDataInput {
  const demographics = answers.demographics as Record<string, unknown>
  const data: Partial<Record<string, string>> = {}
  for (const key of DATA_KEYS) {
    const value = demographics[key]
    if (typeof value === "string" && value.trim()) data[key] = value.trim()
  }
  const rep = answers.representative
  return {
    data,
    // «Respondo por ella» (K1): el servidor lo acepta solo donde lo preguntó.
    ...(answers.respondent === "representative" ? { respondent: "representative" as const } : {}),
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
    // «Tu visita» va siempre que se le preguntó: aunque no cuente nada, queda respondida para esa cita.
    ...(visit ? { visit } : {}),
  }
}

/** Si hay algo que enviar: un dato, su salud, lo que acepta o su visita. Solo su salud y nada respondido no se envía. */
function sendsSomething(input: PersonalDataInput): boolean {
  return (
    Object.keys(input.data).length > 0 ||
    !!input.health ||
    input.privacyAccepted !== undefined ||
    input.acceptsPromotions !== undefined ||
    !!input.visit
  )
}

/** «a», «a y b», «a, b y c». */
function listed(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}` : (parts[0] ?? "")
}

type LinkPerson = Pick<PersonalDataFormView, "firstName" | "age" | "respondentFirstName" | "missing">
/** A quién se le habla al terminar: lo de su ficha y lo que escribió en este envío. */
type SentFor = LinkPerson & {
  /** Dijo «Respondo por ella»: se le habla a quien respondió, sea niña o adulta. */
  forOther?: boolean
}

/** Se le habla a quien responde por la persona (un niño, o dijo «Respondo por ella»), con su nombre. */
const toRespondent = (form: Pick<SentFor, "firstName" | "age" | "forOther">): boolean =>
  (isChildAge(form.age) || form.forOther === true) && !!form.firstName

/**
 * Quién respondió y por quién, con lo que escribió en el mismo envío (K1): sus años, de la fecha que
 * escribió si su ficha no la tenía, y si dijo «Respondo por ella», el nombre de quien respondió.
 */
export function answeredFor(
  form: LinkPerson,
  answers: Pick<RegistrationAnswers, "demographics" | "respondent" | "representative">,
  today: string,
): SentFor {
  const forOther = answers.respondent === "representative"
  const written = answers.demographics.birthDate ? ageInYears(answers.demographics.birthDate, today) : null
  return {
    ...form,
    age: form.age ?? written,
    respondentFirstName: forOther
      ? answers.representative?.displayName.trim().split(/\s+/)[0] || form.respondentFirstName
      : form.respondentFirstName,
    forOther,
  }
}

/**
 * Lo que dice la página al terminar. Del enlace de un niño (menor de 12), o si
 * dijo «Respondo por ella», se le habla a quien respondió, con el nombre de la
 * persona: «Listo, Carla», «ya tiene lo que nos contaste de la salud de Thiago»
 * (mesa del 13 nov, entrega 7). Con «Tu visita» (entrega 8) dice todo lo que
 * llegó en ese envío y quién lo lee antes de atenderla: «Listo, Marta. Dental
 * Smile ya tiene tus datos, tu salud y a qué vienes. Lo lee el Dr. Luis Prado
 * antes de atenderte.»
 */
export function personalDataSentWords(
  form: SentFor,
  clinicName: string,
  outcome: "nada" | "con-salud" | "sin-salud" | "ya-enviado",
  visit?: { reader: string | null; askedReason: boolean } | null,
): { title: string; text: string } {
  const child = toRespondent(form)
  const greeted = child ? form.respondentFirstName : form.firstName
  const listo = greeted ? `Listo, ${greeted}` : "Listo"
  const health = child ? `la salud de ${form.firstName}` : "tu salud"
  const data = child ? `los datos de ${form.firstName}` : "tus datos"
  if (visit && outcome !== "ya-enviado") {
    const parts = [
      form.missing.length > 0 ? data : null,
      outcome === "con-salud" ? health : null,
      visit.askedReason
        ? child
          ? `a qué viene ${form.firstName}`
          : "a qué vienes"
        : child
          ? `lo de la visita de ${form.firstName}`
          : "lo de tu visita",
    ].filter((part): part is string => !!part)
    const reads = visit.reader
      ? ` Lo lee ${visit.reader} ${child ? `antes de atender a ${form.firstName}` : "antes de atenderte"}.`
      : ""
    return { title: listo, text: `${clinicName} ya tiene ${listed(parts)}.${reads}` }
  }
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

/** Lo que dice la página al responder «¿Cambió algo?» o al corregir su salud. */
export function healthAnswerWords(
  form: Pick<SentFor, "firstName" | "age" | "respondentFirstName" | "forOther">,
  clinicName: string,
  outcome: "sin_cambios" | "correccion",
): { title: string; text: string } {
  const child = toRespondent(form) && !!form.respondentFirstName
  const greeted = child ? form.respondentFirstName : form.firstName
  const listo = greeted ? `Listo, ${greeted}` : "Listo"
  if (outcome === "sin_cambios")
    return {
      title: listo,
      text: `${clinicName} ya sabe que nada cambió en ${child ? `la salud de ${form.firstName}` : "tu salud"} ni en ${child ? "sus" : "tus"} medicinas.`,
    }
  return {
    title: listo,
    text: `${clinicName} recibió tu corrección. Lo revisa quien ${child ? `atiende a ${form.firstName}` : "te atiende"}; lo de antes no se borra.`,
  }
}

/**
 * «Antes de tu cita» de «Su enlace» (mesa del 13 nov, entrega 8): un solo
 * recorrido y un solo envío con lo que falta de sus datos, su salud si nadie la
 * registró (opcional) y, con una cita por venir, «Tu visita» al final (a qué
 * viene y si le duele, opcional). Sin cita es «Tus datos», como antes. Al final,
 * si aún no lo aceptó o respondió, el aviso de privacidad y las novedades. Nunca
 * muestra lo guardado. Las reglas (qué se acepta, el documento repetido, el
 * menor sin representante, una respuesta por cita) son del servidor.
 */
export function PersonalDataForm({
  slug,
  token,
  clinicName,
  reader,
  mode,
  draftKey,
  resume = false,
  onSent,
}: {
  slug: string
  token: string
  clinicName: string
  /** Dónde queda lo escrito en este celular hasta enviarlo, por un día (entrega 9). */
  draftKey?: string
  /** Llegó por «Seguir donde ibas»: sigue con lo escrito y su paso. */
  resume?: boolean
  /** Quien lo lee antes de atenderla: «el Dr. Luis Prado»; nulo si la cita no lo dice. */
  reader?: string | null
  /** `corregir`: «Corregir mi salud o mis medicinas» (entrega 10): solo su salud, entera. */
  mode?: "corregir"
  /** Lo envió (o no había nada que enviar): la página dice «Listo» con estas palabras y lo que sigue. */
  onSent: (words: { title: string; text: string }) => void
}) {
  // La dirección se sugiere por la página de la clínica, sin el token (issue 36).
  const addressSource = useMemo(() => publicAddressSource(slug), [slug])
  const formQuery = useQuery({
    queryKey: ["personal-link-data", slug, token, mode ?? "pendiente"],
    queryFn: () => fetchPersonalDataForm(slug, token, mode),
    retry: false,
  })
  const send = useMutation({
    retry: false,
    mutationFn: (input: PersonalDataInput) => submitPersonalData(slug, token, input),
  })
  const alreadyThere = formQuery.error instanceof ApiError && formQuery.error.shape.code === "BOOKING_LINK_EXPIRED"
  // Ya no está pendiente: lo escrito a medias en este celular ya no sirve y se borra.
  useEffect(() => {
    if (alreadyThere && draftKey) clearDeviceDraft(draftKey)
  }, [alreadyThere, draftKey])
  if (formQuery.isPending) return <LoadingState kind="indeterminate" message="Cargando…" />
  if (formQuery.isError) {
    if (alreadyThere) {
      return <ErrorState title="Ya está en la clínica" message="Esto ya no está pendiente." />
    }
    return <ErrorState title="No pudimos abrirlo" message="Vuelve a intentarlo en un momento." onRetry={() => void formQuery.refetch()} />
  }
  const form = formQuery.data.data
  const correcting = form.correcting === true
  const visit = correcting ? null : (form.visit ?? null)
  const visitWords = visit ? { reader: reader ?? null, askedReason: visit.questions.reason } : null
  // «¿Cambió algo?» va dentro del recorrido, después de saber quién responde: lo que diga queda de
  // quien lo dijo. Con «No, sigue igual» y nada más por responder, ese toque envía.
  const healthCheck = correcting ? null : (form.healthCheck ?? null)
  return (
    <div className="rounded-3xl border bg-card p-5 sm:p-6">
      <RegistrationQuestionnaire
        config={form.registration}
        today={form.today}
        countryCode={form.countryCode}
        fill={{
          missing: new Set(form.missing.map((item) => item.key)),
          health: correcting || form.asksHealth,
          // De su salud, solo lo que falta (si lo corrige, todo): lo que ya se sabe no se le muestra. Si
          // dijo que cambió, el cuestionario suma lo de lo que eligió en «¿Qué cambió?».
          healthKeys: new Set(form.healthQuestions ?? []),
          healthCheck,
          medicineQuestions: correcting ? [] : (form.medicineQuestions ?? []),
          hasRepresentative: form.hasRepresentative,
          firstName: form.firstName,
          age: form.age ?? null,
          sex: form.sex ?? null,
          asksWho: form.asksWho ?? false,
          respondentFirstName: form.respondentFirstName ?? null,
          privacy: form.pending.privacy,
          promotions: form.pending.promotions,
          clinicName,
          visit: visit ? { ...visit, reader: reader ?? "quien te atiende" } : null,
        }}
        submitLabel="Enviar"
        shortcuts={false}
        addressSource={addressSource}
        draftKey={draftKey}
        resume={resume}
        onSubmit={async (answers, extra) => {
          // A quién se le habla al terminar: con la fecha que escribió y quién respondió (K1).
          const said = answeredFor(form, answers, form.today)
          const input: PersonalDataInput = {
            ...toInput(answers, form.pending, extra.visit),
            ...(healthCheck && extra.healthCheck ? { healthCheck: extra.healthCheck } : {}),
            ...(extra.medicinesChanged ? { medicinesChanged: true } : {}),
            ...(correcting ? { correctHealth: true } : {}),
          }
          if (correcting) {
            try {
              await send.mutateAsync(input)
              onSent(healthAnswerWords(said, clinicName, "correccion"))
            } catch (error) {
              if (error instanceof ApiError && Object.keys(error.shape.fields ?? {}).length > 0) throw error
              throw new Error(
                error instanceof ApiError
                  ? (error.shape.message ?? "No pudimos guardar tu corrección.")
                  : "No pudimos guardar tu corrección. Revisa tu conexión y vuelve a intentarlo.",
              )
            }
            return
          }
          if (input.healthCheck === "sin_cambios" && !sendsSomething(input)) {
            // Solo «No, sigue igual», con quién lo dijo si respondió por ella.
            try {
              await send.mutateAsync(input)
            } catch (error) {
              if (!(error instanceof ApiError && error.shape.code === "DATA_ALREADY_SENT"))
                throw new Error(
                  error instanceof ApiError
                    ? (error.shape.message ?? "No pudimos enviarlo.")
                    : "No pudimos enviarlo. Revisa tu conexión y vuelve a intentarlo.",
                )
            }
            onSent(healthAnswerWords(said, clinicName, "sin_cambios"))
            return
          }
          if (!sendsSomething(input) && !input.healthCheck) {
            // Queda dicho que ya respondió, para no volver a pedírselo; si falla, no pasa nada.
            if (form.missing.length === 0) void submitPersonalData(slug, token, input).catch(() => undefined)
            // Solo su salud y no contó nada: no hay nada que enviar; la tarjeta sigue ahí, opcional.
            onSent(personalDataSentWords(said, clinicName, "nada"))
            return
          }
          const withHealth = (form.asksHealth || input.healthCheck === "cambio" || !!input.medicinesChanged) && !!input.health
          try {
            await send.mutateAsync(input)
            onSent(personalDataSentWords(said, clinicName, withHealth ? "con-salud" : "sin-salud", visitWords))
          } catch (error) {
            if (error instanceof ApiError && (error.shape.code === "DATA_ALREADY_SENT" || error.shape.code === "ALREADY_SUBMITTED")) {
              onSent(personalDataSentWords(said, clinicName, "ya-enviado"))
              return
            }
            // Lo que es de un dato, el cuestionario lo dice en su campo.
            if (error instanceof ApiError && Object.keys(error.shape.fields ?? {}).length > 0) throw error
            throw new Error(
              error instanceof ApiError
                ? (error.shape.message ?? "No pudimos guardar lo que enviaste.")
                : "No pudimos guardar lo que enviaste. Revisa tu conexión y vuelve a intentarlo.",
            )
          }
        }}
      />
    </div>
  )
}
