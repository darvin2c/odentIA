import { declaredHealthAnswered, isChildAge, type RegistrationAnswers, type VisitAnswerInput } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
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

/**
 * Lo que dice la página al terminar. Del enlace de un niño (menor de 12) se le
 * habla a quien lo cuida, con el nombre del niño: «Listo, Carla», «ya tiene lo
 * que nos contaste de la salud de Thiago» (mesa del 13 nov, entrega 7). Con «Tu
 * visita» (entrega 8) dice todo lo que llegó en ese envío y quién lo lee antes de
 * atenderla: «Listo, Marta. Dental Smile ya tiene tus datos, tu salud y a qué
 * vienes. Lo lee el Dr. Luis Prado antes de atenderte.»
 */
export function personalDataSentWords(
  form: Pick<PersonalDataFormView, "firstName" | "age" | "respondentFirstName" | "missing">,
  clinicName: string,
  outcome: "nada" | "con-salud" | "sin-salud" | "ya-enviado",
  visit?: { reader: string | null; askedReason: boolean } | null,
): { title: string; text: string } {
  const child = isChildAge(form.age) && !!form.firstName
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

/** «13 nov»: el día de su última declaración, como lo dice la página. */
function shortSince(since: string): string {
  const date = new Date(since)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("es", { day: "numeric", month: "short" }).replace(/\./g, "")
}

/**
 * «¿Cambió algo en tu salud o en tus medicinas desde tu última visita (13 nov)?» (entrega 10). A
 * quien cuida a un niño se le pregunta por el niño. No lista lo que dijo entonces (decisión 9).
 */
export function healthCheckQuestion(
  form: Pick<PersonalDataFormView, "firstName" | "age" | "respondentFirstName">,
  since: string,
): string {
  const day = shortSince(since)
  const when = day ? ` (${day})` : ""
  return isChildAge(form.age) && form.firstName && form.respondentFirstName
    ? `¿Cambió algo en la salud o en las medicinas de ${form.firstName} desde su última visita${when}?`
    : `¿Cambió algo en tu salud o en tus medicinas desde tu última visita${when}?`
}

/** Lo que dice la página al responder «¿Cambió algo?» o al corregir su salud. */
export function healthAnswerWords(
  form: Pick<PersonalDataFormView, "firstName" | "age" | "respondentFirstName">,
  clinicName: string,
  outcome: "sin_cambios" | "correccion",
): { title: string; text: string } {
  const child = isChildAge(form.age) && !!form.firstName && !!form.respondentFirstName
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
  onSent,
}: {
  slug: string
  token: string
  clinicName: string
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
  // Su respuesta a «¿Cambió algo?»: hasta elegir, la tarjeta solo pregunta eso.
  const [check, setCheck] = useState<"sin_cambios" | "cambio" | null>(null)
  if (formQuery.isPending) return <LoadingState kind="indeterminate" message="Cargando…" />
  if (formQuery.isError) {
    if (formQuery.error instanceof ApiError && formQuery.error.shape.code === "BOOKING_LINK_EXPIRED") {
      return <ErrorState title="Ya está en la clínica" message="Esto ya no está pendiente." />
    }
    return <ErrorState title="No pudimos abrirlo" message="Vuelve a intentarlo en un momento." onRetry={() => void formQuery.refetch()} />
  }
  const form = formQuery.data.data
  const correcting = form.correcting === true
  const visit = correcting ? null : (form.visit ?? null)
  const visitWords = visit ? { reader: reader ?? null, askedReason: visit.questions.reason } : null
  const healthCheck = correcting ? null : (form.healthCheck ?? null)
  // Con «No, sigue igual» y nada más por responder, un toque: se envía ahí mismo.
  const onlyCheck = !!healthCheck && form.missing.length === 0 && !form.asksHealth && !visit
  const sendUnchanged = async () => {
    try {
      await send.mutateAsync({ data: {}, healthCheck: "sin_cambios" })
      onSent(healthAnswerWords(form, clinicName, "sin_cambios"))
    } catch (error) {
      if (error instanceof ApiError && error.shape.code === "DATA_ALREADY_SENT") {
        onSent(healthAnswerWords(form, clinicName, "sin_cambios"))
        return
      }
      setCheck(null)
    }
  }
  if (healthCheck && check === null)
    return (
      <HealthCheckCard
        question={healthCheckQuestion(form, healthCheck.since)}
        pending={send.isPending}
        failed={send.isError}
        onAnswer={(answer) => {
          setCheck(answer)
          if (answer === "sin_cambios" && onlyCheck) void sendUnchanged()
        }}
      />
    )
  if (healthCheck && check === "sin_cambios" && onlyCheck)
    return <LoadingState kind="indeterminate" message="Enviando…" />
  // «Sí, cambió» y «Corregir»: vuelve a responder todo lo de su salud que la clínica pregunta.
  const changed = check === "cambio" && !!healthCheck
  const healthKeys = correcting
    ? (form.healthQuestions ?? [])
    : changed
      ? healthCheck.questions
      : (form.healthQuestions ?? [])
  return (
    <div className="rounded-3xl border bg-card p-5 sm:p-6">
      <RegistrationQuestionnaire
        config={form.registration}
        today={form.today}
        countryCode={form.countryCode}
        fill={{
          missing: new Set(form.missing.map((item) => item.key)),
          health: correcting || changed || form.asksHealth,
          // De su salud, solo lo que falta: lo que ya se sabe no se le muestra. Si cambió o lo corrige, todo, sin lo de antes.
          healthKeys: new Set(healthKeys),
          hasRepresentative: form.hasRepresentative,
          firstName: form.firstName,
          age: form.age ?? null,
          respondentFirstName: form.respondentFirstName ?? null,
          privacy: form.pending.privacy,
          promotions: form.pending.promotions,
          clinicName,
          visit: visit ? { ...visit, reader: reader ?? "quien te atiende" } : null,
        }}
        submitLabel="Enviar"
        shortcuts={false}
        addressSource={addressSource}
        onSubmit={async (answers, extra) => {
          const input: PersonalDataInput = {
            ...toInput(answers, form.pending, extra.visit),
            ...(healthCheck && check ? { healthCheck: check } : {}),
            ...(correcting ? { correctHealth: true } : {}),
          }
          if (correcting) {
            try {
              await send.mutateAsync(input)
              onSent(healthAnswerWords(form, clinicName, "correccion"))
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
            await sendUnchanged()
            return
          }
          if (!sendsSomething(input) && !input.healthCheck) {
            // Queda dicho que ya respondió, para no volver a pedírselo; si falla, no pasa nada.
            if (form.missing.length === 0) void submitPersonalData(slug, token, input).catch(() => undefined)
            // Solo su salud y no contó nada: no hay nada que enviar; la tarjeta sigue ahí, opcional.
            onSent(personalDataSentWords(form, clinicName, "nada"))
            return
          }
          const withHealth = (form.asksHealth || changed) && !!input.health
          try {
            await send.mutateAsync(input)
            onSent(personalDataSentWords(form, clinicName, withHealth ? "con-salud" : "sin-salud", visitWords))
          } catch (error) {
            if (error instanceof ApiError && (error.shape.code === "DATA_ALREADY_SENT" || error.shape.code === "ALREADY_SUBMITTED")) {
              onSent(personalDataSentWords(form, clinicName, "ya-enviado"))
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

/**
 * La primera pregunta de la tarjeta (dibujo 15 del lienzo): dos botones grandes, «No, sigue igual»
 * y «Sí, cambió», y qué pasa con cada uno. Un grupo de radios no hace falta: tocar ya responde.
 */
function HealthCheckCard({
  question,
  pending,
  failed,
  onAnswer,
}: {
  question: string
  pending: boolean
  failed: boolean
  onAnswer: (answer: "sin_cambios" | "cambio") => void
}) {
  return (
    <section aria-labelledby="cambio-algo" className="flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6">
      <h2 id="cambio-algo" className="font-heading text-lg font-medium">
        {question}
      </h2>
      <div className="flex flex-col gap-2">
        <Button type="button" size="lg" variant="outline" disabled={pending} onClick={() => onAnswer("sin_cambios")}>
          No, sigue igual
        </Button>
        <Button type="button" size="lg" disabled={pending} onClick={() => onAnswer("cambio")}>
          Sí, cambió
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Si cambió, vuelves a responder las preguntas de tu salud y tus medicinas. Lo de antes no se borra.
      </p>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          No pudimos enviarlo. Revisa tu conexión y vuelve a intentarlo.
        </p>
      ) : null}
    </section>
  )
}
