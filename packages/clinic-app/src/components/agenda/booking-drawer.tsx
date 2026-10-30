import { composeDisplayName, pendingRegistrationFields, type RegistrationConfig } from "@odentia/clinical"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldTitle,
  toast,
} from "@odentia/ui"
import {
  dayMinutesIn,
  FormDrawer,
  hourLabel,
  normalizeCountry,
  type ScheduleColumn,
  type SchedulePreview,
  type ScheduleRangeValue,
  type SubmitOptions,
  SubmitButton,
  submitErrorOf,
  submitForm,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { z } from "zod"
import type { AgendaAppointment } from "../../lib/agenda"
import type { PhoneWhatsApp } from "../../lib/people"
import { apiFetch } from "../../lib/api"
import { fetchTreatmentCoordination } from "../../lib/clinical-journey"
import { useCan, usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { fetchService } from "../../lib/services"
import { PersonPicker } from "../person-picker"
import { ServiceSelect } from "../service-select"
import { whenSaid } from "./shared"
import { EMPTY_WHEN, useWhen, WHEN_FIELD_MAP, WhenFields, type WhenValues } from "./when"
import { appWords } from "../../lib/product-words"

/** Con qué se abre «Nueva cita»: nada, un hueco tocado en la rejilla o un paciente. */
export interface BookingSeed {
  patient?: { id: string; name: string }
  /**
   * Quien escribe y aún no es paciente («Reservar cita» desde «Contexto»): se
   * registra aquí con lo mínimo y su ficha queda unida a esa misma persona.
   */
  person?: { contactId: string; name: string; phone: string | null }
  /** El paciente viene de un caso o de su ficha: no se cambia aquí. */
  lockedPatient?: boolean
  conversationId?: string
  professionalUserId?: string | null
  /** Instante del hueco ya elegido. */
  startsAt?: string
  /** Día en que se abre el selector. */
  date?: string
  /** «Agendar» desde el Plan: el servicio de lo aceptado, ya elegido. */
  serviceId?: string
  /**
   * Tratamientos aceptados que esta cita viene a hacer (`appointment_plan_item`):
   * la atención de la cita los trae a «Hecho hoy».
   */
  planItemIds?: string[]
}

/**
 * Nueva cita: a quién y cuándo. El «cuándo» es el mismo de reprogramar
 * (`useWhen`): lo blanco está libre, y el bloque se arrastra y se estira. El
 * unidad dental la pone la agenda. Quien aún no es paciente se registra aquí mismo
 * con lo mínimo.
 */
/** A quién le llega el recordatorio de la cita y por dónde (decisión 23). */
interface ReminderReach {
  name: string
  whatsapp: PhoneWhatsApp
  hasEmail: boolean
}

/** «Carmen no recibirá el recordatorio: aún no tiene WhatsApp»; nada si le llega por WhatsApp. */
function reminderWords(reach: ReminderReach | null | undefined): string | null {
  if (!reach || reach.whatsapp.state === "es_su_whatsapp") return null
  const why = reach.whatsapp.state === "no_tiene" ? "su número no tiene WhatsApp" : "aún no tiene WhatsApp"
  return reach.hasEmail
    ? `${reach.name} recibirá el recordatorio por correo: ${why}.`
    : `${reach.name} no recibirá el recordatorio: ${why}.`
}


/** Lo que se escribe en «Nueva cita»; el «cuándo» va en `when` (ver `WhenFields`). */
interface BookingValues {
  patientId: string
  givenNames: string
  surname: string
  phone: string | null
  generalConsent: boolean | null
  serviceId: string
  reason: string
  when: WhenValues
}

/**
 * Dónde cae cada rechazo del servidor: los del registro (`answers.demographics.*`)
 * en Nombres, Apellidos y Teléfono; los de la cita en su campo o en el «cuándo».
 */
const BOOKING_FIELD_MAP: Record<string, string> = {
  ...WHEN_FIELD_MAP,
  "answers.demographics.givenNames": "givenNames",
  "answers.demographics.familyName": "surname",
  "answers.demographics.displayName": "givenNames",
  "answers.demographics.phone": "phone",
}

export function BookingDrawer({
  seed,
  branchId,
  timeZone,
  today,
  now,
  defaultMinutes,
  toneOf,
  onPreview,
  onClose,
  onSaved,
}: {
  seed: BookingSeed
  branchId: string
  timeZone: string
  today: string
  now: string
  /** Lo que dura una cita regular en la sede (sin servicio). */
  defaultMinutes: number
  toneOf: (id: string) => ScheduleColumn["tone"]
  /** La rejilla de la agenda deja ver lo elegido antes de reservar. */
  onPreview: (preview: SchedulePreview | null) => void
  onClose: () => void
  onSaved: (appointment: AgendaAppointment) => Promise<void>
}) {
  // ----- A quién -----
  const [registering, setRegistering] = React.useState(Boolean(seed.person))
  const [created, setCreated] = React.useState<{ id: string; name: string } | null>(null)
  const submissionId = React.useRef(crypto.randomUUID())
  const queryClient = useQueryClient()
  // Registrar a alguien pide su propio permiso: sin él solo se elige entre quienes ya existen.
  const canRegister = usePermission("patients.write")
  const can = useCan()
  const profile = useOrgProfile()
  // Lo que la clínica pide en su registro y aquí no se escribe: queda pendiente en su página.
  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>("/api/patient-registration/config"),
    enabled: registering && (can("crm.read") || can("settings.read")),
    retry: false,
  })

  // Los tratamientos que trae la cita: con su título, el que ve recepción (sin piezas ni precios).
  const planItemIds = seed.planItemIds ?? []
  const coordinationQuery = useQuery({
    queryKey: ["treatment-coordination", seed.patient?.id],
    queryFn: () => fetchTreatmentCoordination(seed.patient?.id ?? ""),
    enabled: planItemIds.length > 0 && Boolean(seed.patient?.id),
    retry: false,
  })
  const planItemTitles = planItemIds.map(
    (id) => coordinationQuery.data?.data.treatments.find((row) => row.id === id)?.title ?? null,
  )

  // Lo que se avisa después de reservar y no debe perderse con el toast.
  const consentNote = React.useRef<string | null>(null)
  const whatsappNote = React.useRef<string | null>(null)
  // El paso en curso: un rechazo del registro dice a quién no se pudo registrar.
  const phase = React.useRef<"registro" | "cita">("cita")
  // Lo que se eligió en el aviso de fuera de horario: otro hueco o reservar igual.
  const choice = React.useRef<{ range: ScheduleRangeValue; outsideSchedule?: boolean } | null>(null)
  const [urgent, setUrgent] = React.useState(false)
  const [urgentPick, setUrgentPick] = React.useState<"next" | "anyway" | null>(null)

  const save = useMutation({
    mutationFn: (input: { patientId: string; value: BookingValues; range: ScheduleRangeValue; outsideSchedule?: boolean }) =>
      apiFetch<{ data: AgendaAppointment & { reminderReach?: ReminderReach | null } }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId: input.patientId,
          professionalUserId: input.range.columnId,
          serviceId: input.value.serviceId || undefined,
          // Solo si la cita sigue siendo de quien vino del Plan.
          ...(planItemIds.length > 0 && input.patientId === seed.patient?.id ? { planItemIds } : {}),
          startsAt: input.range.start,
          endsAt: input.range.end,
          reason: input.value.reason.trim() || undefined,
          conversationId: seed.conversationId,
          source: seed.conversationId ? "conversacion" : "recepcion",
          outsideSchedule: input.outsideSchedule,
        }),
      }),
  })

  /** Registra a quien aún no es paciente, con lo mínimo; devuelve su ficha. */
  const register = async (value: BookingValues, name: string) => {
    // El mismo registro de pacientes de siempre, con lo mínimo: el resto de la ficha se completa después.
    const registered = await apiFetch<{
      data: { id: string; displayName: string; whatsapp?: "creado" | "en_uso" }
    }>("/api/patients", {
      method: "POST",
      body: JSON.stringify({
        submissionId: submissionId.current,
        registeredBranchId: branchId,
        answers: {
          demographics: {
            displayName: name,
            givenNames: value.givenNames.trim(),
            familyName: value.surname.trim(),
            ...(value.phone ? { phone: value.phone } : {}),
          },
          respondent: "staff",
          privacyAccepted: false,
        },
        // La ficha nace unida a la persona del caso: no se crea otra.
        ...(seed.person
          ? {
              contextContactId: seed.person.contactId,
              contacts: [{ contactId: seed.person.contactId, relationship: "self", isPreferred: true }],
            }
          : {}),
        // Al reservar basta lo mínimo, como en el enlace de reserva: desde su conversación
        // o, si es alguien nuevo, desde la Agenda. Lo que la clínica pide y falta queda
        // anotado y la identidad, por revisar.
        ...(seed.person && seed.conversationId
          ? { conversationId: seed.conversationId, scope: "essentials" }
          : !seed.person
            ? { scope: "essentials" }
            : {}),
      }),
    })
    consentNote.current = null
    // Su teléfono pasó a ser su WhatsApp (ADR 0027); si ya era de otra persona no se movió.
    whatsappNote.current =
      registered.data.whatsapp === "en_uso"
        ? "Su número de WhatsApp ya es de otra persona de la clínica: no se movió. Revísalo en su página antes de escribirle."
        : null
    if (value.generalConsent !== null) {
      const consent = value.generalConsent
      // Se anota en su persona, como en Datos › Mensajes, diciendo que lo dijo por teléfono.
      await (async () => {
        const personId =
          seed.person?.contactId ??
          (await apiFetch<{ data: { personId: string } }>(`/api/people/by-patient/${registered.data.id}`)).data.personId
        await apiFetch(`/api/agent/admin/people/${personId}/permissions`, {
          method: "POST",
          body: JSON.stringify({ tipo: "novedades", recibir: consent, source: "telefono" }),
        })
      })().catch(() => {
        consentNote.current = "No se pudo anotar si acepta novedades y promociones: anótalo en su página, en Datos."
      })
    }
    // Las búsquedas de pacientes ya hechas dejaron de valer.
    void queryClient.invalidateQueries({ queryKey: ["patients"] })
    return registered.data
  }

  // Quien registra escribe nombres y apellidos (y su teléfono si es alguien nuevo); quien elige, elige.
  const schema = z.object({
    patientId: registering ? z.string() : z.string().min(1, "Elige un paciente."),
    givenNames: registering
      ? z.string().trim().min(1, "Escribe los nombres.").max(100, "Escribe los nombres en 100 caracteres o menos.")
      : z.string(),
    surname: registering
      ? z.string().trim().min(1, "Escribe los apellidos.").max(200, "Escribe los apellidos en 200 caracteres o menos.")
      : z.string(),
    phone:
      registering && !seed.person
        ? z
            .string()
            .nullable()
            .refine((phone) => Boolean(phone), "Escribe su teléfono: por ahí le llegan los avisos de la cita.")
        : z.string().nullable(),
    // Opcional: si no se tocó, no se anota nada.
    generalConsent: z.boolean().nullable(),
    serviceId: z.string(),
    reason: z.string().max(500, "Escribe el motivo en 500 caracteres o menos."),
    // El «cuándo» lo valida `WhenFields` con lo que ve en las horas.
    when: z.object({ startsAt: z.string(), professionalUserId: z.string() }),
  })

  const form = useAppForm({
    defaultValues: (() => {
      // «Nombres» y «Apellidos»: lo que sigue a la primera palabra va entero a los apellidos.
      const [first = "", ...rest] = (seed.person?.name ?? "").trim().split(/\s+/)
      return {
        patientId: seed.patient?.id ?? "",
        givenNames: first,
        surname: rest.join(" "),
        phone: seed.person?.phone ?? null,
        generalConsent: null,
        serviceId: seed.serviceId ?? "",
        reason: "",
        when: EMPTY_WHEN,
      } as BookingValues
    })(),
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const picked = choice.current
      choice.current = null
      const range = picked?.range ?? when.shown
      // El «cuándo» ya validó que hay un hueco elegido.
      if (!range) return
      // Fuera del horario no se reserva sin más: se pregunta si es una urgencia.
      if (!picked && when.state === "outside") {
        setUrgent(true)
        return
      }
      try {
        let patientId = value.patientId
        if (registering) {
          phase.current = "registro"
          const registered = await register(value, newName)
          patientId = registered.id
          // Si la reserva fallara después, la persona ya está registrada: no se crea dos veces.
          setCreated({ id: patientId, name: registered.displayName })
          form.setFieldValue("patientId", patientId)
          setRegistering(false)
        }
        phase.current = "cita"
        const result = await save.mutateAsync({ patientId, value, range, outsideSchedule: picked?.outsideSchedule })
        // Si «Recordar la cita» está prendida, el agente le avisa solo: recepción no escribe nada.
        toast.success(`Cita reservada ${whenSaid(result.data.startsAt, timeZone, today)}`, {
          description:
            [
              result.data.notice?.queued
                ? `El agente le avisa a ${result.data.patientName.split(/\s+/)[0]} por su conversación.`
                : null,
              reminderWords(result.data.reminderReach),
            ]
              .filter(Boolean)
              .join(" ") || undefined,
        })
        // Lo que hay que revisar después queda a la vista hasta cerrarlo: el cajón se cierra al reservar.
        for (const note of [whatsappNote.current, consentNote.current]) {
          if (note) toast.warning(note, { duration: Number.POSITIVE_INFINITY, closeButton: true })
        }
        await onSaved(result.data)
      } catch (cause) {
        setUrgent(false)
        // Si alguien tomó el hueco, lo libre se vuelve a pedir.
        when.refetch()
        throw cause
      }
    },
  })

  const values = useStore(form.store, (state) => state.values)
  const newName = composeDisplayName({
    givenNames: values.givenNames.trim(),
    familyName: values.surname.trim(),
  })
  const submitOptions: SubmitOptions = {
    fieldMap: BOOKING_FIELD_MAP,
    // Lo que el registro rechaza sin campo dice a quién no se pudo registrar.
    formMessage: (cause) =>
      phase.current === "registro" ? `No se pudo registrar a ${newName}: ${submitErrorOf(cause).form ?? ""}`.trim() : null,
  }
  const surface = useFormSurface(form, submitOptions)

  // Quien abrió el formulario, se eligió o se acaba de registrar: su nombre se conserva.
  const patientName = registering
    ? newName || undefined
    : [created, seed.patient].find((known) => known && known.id === values.patientId)?.name

  // Antes de registrar a alguien, se mira si ya existe con ese nombre o teléfono.
  const duplicatesQuery = useQuery({
    queryKey: ["patients", "duplicates", newName, values.phone],
    // Con la persona del caso no se busca otra: su ficha se une a ella.
    enabled: registering && !seed.person && newName.length >= 3,
    queryFn: () => {
      const params = new URLSearchParams({ displayName: newName })
      if (values.phone) params.set("phone", values.phone)
      return apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients/duplicates?${params}`,
      )
    },
  })
  const duplicates = registering ? (duplicatesQuery.data?.data ?? []) : []

  // ----- Qué -----
  // El servicio elegido, también el que llega del Plan aunque no esté en la primera página del tarifario.
  const serviceId = values.serviceId
  const serviceQuery = useQuery({
    queryKey: ["services", "one", serviceId],
    queryFn: () => fetchService(serviceId),
    enabled: Boolean(serviceId),
    staleTime: 60_000,
  })
  const service = serviceId ? serviceQuery.data?.data : undefined
  const duration = service?.durationMin ?? defaultMinutes

  // ----- Cuándo -----
  const when = useWhen({
    branchId,
    timeZone,
    today,
    now,
    toneOf,
    duration,
    date: seed.date,
    professionalUserId: seed.professionalUserId,
    startsAt: seed.startsAt,
    // Con servicio, la agenda ofrece solo a quien lo atiende (ADR 0039).
    serviceId: serviceId || undefined,
  })
  const { shown, professional, chosenMinutes, nextFree, hoursThatDay, free } = when

  React.useEffect(() => {
    onPreview(
      shown
        ? {
            columnId: shown.columnId,
            start: shown.start,
            end: shown.end,
            title: patientName ?? "Nueva cita",
          }
        : null,
    )
  }, [shown, patientName, onPreview])
  React.useEffect(() => () => onPreview(null), [onPreview])

  // «Lo que la clínica pide (fecha de nacimiento y documento) queda pendiente en su página.»
  const pendingWords = (() => {
    const config = configQuery.data?.data
    if (!config) return "Lo que la clínica pide en su registro queda pendiente en su página."
    const words = [
      ...new Set(
        pendingRegistrationFields(config, {
          demographics: {
            displayName: newName || "Paciente",
            givenNames: values.givenNames.trim() || "Paciente",
            familyName: values.surname.trim() || "Paciente",
            ...(values.phone ? { phone: values.phone } : {}),
          },
          respondent: "staff",
          privacyAccepted: false,
        })
          // El teléfono se pide aquí mismo: nunca queda pendiente.
          .filter((field) => field.key !== "phone")
          .map((field) =>
            field.key === "docType" || field.key === "docNumber" ? "documento" : field.label.toLowerCase(),
          ),
      ),
    ]
    if (words.length === 0) return ""
    const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} y ${words.at(-1)}`
    return `Lo que la clínica pide (${list}) queda pendiente en su página.`
  })()

  const startRegistering = (typed = "") => {
    // Lo que ya se tecleó al buscar sirve de punto de partida.
    const [first = "", ...rest] = typed.trim().split(/\s+/)
    form.setFieldValue("givenNames", first)
    form.setFieldValue("surname", rest.join(" "))
    setRegistering(true)
  }
  const pickPatient = (patient: { id: string; name: string }) => {
    setCreated(patient)
    form.setFieldValue("patientId", patient.id)
    setRegistering(false)
  }
  /** Desde el aviso de fuera de horario: se reserva lo elegido allí. */
  const bookFromNotice = async (pick: "next" | "anyway", range: ScheduleRangeValue) => {
    choice.current = { range, outsideSchedule: pick === "anyway" || undefined }
    setUrgentPick(pick)
    const ok = await submitForm(form, submitOptions)
    setUrgentPick(null)
    // Lo que falló se dice en el formulario: el aviso no lo tapa.
    if (!ok) setUrgent(false)
  }
  const submitLabel = !shown
    ? "Reservar cita"
    : registering
      ? // El día ya se lee justo encima: el botón tiene que caber junto a «Cancelar».
        `Registrar y reservar a las ${hourLabel(dayMinutesIn(shown.start, timeZone))}`
      : `Reservar ${whenSaid(shown.start, timeZone, today)}`

  return (
    <>
      <FormDrawer
        {...surface}
        open
        title="Nueva cita"
        description={`Elige a quién y cuándo. La ${appWords().room.one} se asigna con el hueco.`}
        onClose={onClose}
        submitLabel={submitLabel}
      >
        <div className="grid gap-4">
          {seed.lockedPatient && seed.patient ? (
            <div className="grid gap-1">
              <FieldTitle>{planItemIds.length > 0 ? "Paciente" : "Paciente del caso"}</FieldTitle>
              <p className="text-sm font-medium">{seed.patient.name}</p>
              {planItemIds.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Para:{" "}
                  {planItemTitles.every((title) => title)
                    ? planItemTitles.join(", ")
                    : planItemIds.length === 1
                      ? "1 tratamiento aceptado"
                      : `${planItemIds.length} tratamientos aceptados`}
                  . La atención de esta cita los trae.
                </p>
              ) : null}
            </div>
          ) : registering ? (
            <div className="grid gap-3 rounded-2xl border bg-muted/40 p-3.5">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm font-bold">
                  {seed.person ? `${seed.person.name} todavía no es paciente` : "Paciente nuevo"}
                </span>
                {seed.person ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setRegistering(false)}>
                    Buscar uno que ya existe
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <form.AppField name="givenNames">
                  {(field) => (
                    <field.TextField id="cita-nuevo-nombres" label="Nombres" maxLength={100} className="col-span-2" />
                  )}
                </form.AppField>
                <form.AppField name="surname">
                  {(field) => (
                    <field.TextField id="cita-nuevo-apellidos" label="Apellidos" maxLength={200} className="col-span-2" />
                  )}
                </form.AppField>
              </div>
              <form.AppField name="phone">
                {(field) => (
                  <field.PhoneField
                    id="cita-nuevo-telefono"
                    label="Teléfono"
                    defaultCountry={normalizeCountry(profile.data?.countryCode)}
                  />
                )}
              </form.AppField>
              {duplicates.length > 0 ? (
                <div
                  role="status"
                  className="grid gap-1.5 rounded-xl bg-warning-soft p-2.5 text-sm"
                >
                  <span className="font-semibold text-warning">
                    Puede que ya esté registrada:
                  </span>
                  {duplicates.slice(0, 3).map((match) => (
                    <Button
                      key={match.id}
                      variant="outline"
                      size="sm"
                      className="justify-start bg-card"
                      onClick={() => pickPatient({ id: match.id, name: match.displayName })}
                    >
                      Usar a {match.displayName}
                    </Button>
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {seed.person
                  ? `Se crea su ficha con nombre y teléfono, unida a esta persona. ${pendingWords}`.trim()
                  : `Con esto basta para la cita. ${pendingWords}`.trim()}
              </p>
              {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040). */}
              <p className="text-xs text-muted-foreground">Díselo: «Te avisaremos por WhatsApp sobre tus citas.»</p>
              <form.AppField name="generalConsent">
                {(field) => (
                  <field.Group
                    legend="¿Acepta recibir novedades y promociones de la clínica?"
                    description="Opcional: si no se lo preguntaste, déjalo así."
                    className="gap-1.5"
                  >
                    {(control) => (
                      <div className="flex flex-wrap gap-2">
                        {[
                          { value: true, label: "Sí, aceptó por teléfono" },
                          { value: false, label: "No aceptó" },
                        ].map((option) => (
                          <Button
                            key={option.label}
                            type="button"
                            size="sm"
                            variant={field.state.value === option.value ? "default" : "outline"}
                            aria-pressed={field.state.value === option.value}
                            aria-describedby={control.describedBy}
                            onClick={() =>
                              field.handleChange(field.state.value === option.value ? null : option.value)
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </field.Group>
                )}
              </form.AppField>
            </div>
          ) : (
            <div className="grid gap-1.5">
              {/* El buscador de personas de toda la aplicación, solo con pacientes (ADR 0029). */}
              <form.AppField name="patientId">
                {(field) => (
                  <field.Control id="cita-paciente" label="Paciente">
                    {(control) => (
                      <PersonPicker
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        label="Paciente"
                        patientsOnly
                        value={
                          field.state.value
                            ? { id: `ficha:${field.state.value}`, name: patientName ?? "", patientId: field.state.value }
                            : null
                        }
                        onChange={(person) => {
                          if (person?.patientId) {
                            setCreated({ id: person.patientId, name: person.name })
                            field.handleChange(person.patientId)
                          } else field.handleChange("")
                        }}
                        onCreate={canRegister ? (typed) => startRegistering(typed) : undefined}
                        createLabel={(typed) => `Registrar a ${typed}`}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              {canRegister ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5 justify-self-start text-primary"
                  onClick={() => startRegistering()}
                >
                  Registrar paciente nuevo
                </Button>
              ) : null}
            </div>
          )}

          <form.AppField name="serviceId">
            {(field) => (
              <field.Control id="cita-servicio" label="Servicio (opcional)">
                {(control) => (
                  <ServiceSelect
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    placeholder="Buscar servicio (opcional)…"
                    value={field.state.value}
                    onChange={(next) => {
                      if (next) queryClient.setQueryData(["services", "one", next.id], { data: next })
                      field.handleChange(next?.id ?? "")
                      // Con servicio, el bloque toma lo que dura el servicio.
                      when.resize(next?.durationMin ?? defaultMinutes)
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          {when.attending ? (
            <p role="status" className="-mt-2 text-xs text-muted-foreground">
              {`Solo se ofrecen las horas de quien atiende ${when.attending.specialtyName}.`}
            </p>
          ) : null}

          <WhenFields form={form} fields="when" when={when} />

          <form.AppField name="reason">
            {(field) => <field.TextField id="cita-motivo" label="Motivo (opcional)" maxLength={500} />}
          </form.AppField>
        </div>
      </FormDrawer>

      <Dialog open={urgent} onOpenChange={(next) => (next ? undefined : setUrgent(false))}>
        <DialogContent showCloseButton={false} className="gap-3.5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{professional?.label} no atiende a esa hora</DialogTitle>
            <DialogDescription>
              {hoursThatDay.length > 0
                ? `Ese día atiende de ${hoursThatDay.join(" y de ")}`
                : "Ese día no atiende"}
              {shown
                ? ` y quieres reservar a las ${hourLabel(dayMinutesIn(shown.start, timeZone))}.`
                : "."}
              {nextFree
                ? ` Su próximo hueco es ${whenSaid(nextFree.startsAt, timeZone, today)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {nextFree && shown ? (
              <SubmitButton
                className="h-11"
                disabled={surface.isSubmitting}
                pending={surface.isSubmitting && urgentPick === "next"}
                onClick={() =>
                  void bookFromNotice("next", {
                    columnId: shown.columnId,
                    start: nextFree.startsAt,
                    end: new Date(
                      Math.min(
                        Date.parse(nextFree.startsAt) + chosenMinutes * 60000,
                        Date.parse(
                          free.find(
                            (item) =>
                              item.columnId === shown.columnId &&
                              item.start === nextFree.startsAt,
                          )?.end ?? nextFree.endsAt,
                        ),
                      ),
                    ).toISOString(),
                  })
                }
              >
                Reservar {whenSaid(nextFree.startsAt, timeZone, today)}
              </SubmitButton>
            ) : null}
            <Button variant="outline" className="h-11" onClick={() => setUrgent(false)}>
              Ver otros huecos
            </Button>
          </div>
          <div className="flex items-center gap-2 border-t pt-3">
            <span className="flex-1 text-sm text-muted-foreground">¿Es una urgencia?</span>
            <SubmitButton
              variant="ghost"
              className="text-warning"
              disabled={surface.isSubmitting}
              pending={surface.isSubmitting && urgentPick === "anyway"}
              onClick={() => shown && void bookFromNotice("anyway", shown)}
            >
              Reservar igual a las {shown ? hourLabel(dayMinutesIn(shown.start, timeZone)) : ""}
            </SubmitButton>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
