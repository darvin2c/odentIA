import {
  composeDisplayName,
  pendingRegistrationFields,
  type RegistrationConfig,
  sessionWords,
  showsSession,
} from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
  submitErrorOf,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { z } from "zod"
import type { AgendaAppointment } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { fetchTreatmentCoordination } from "../../lib/clinical-journey"
import { useCan, usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import type { PhoneWhatsApp } from "../../lib/people"
import { appWords } from "../../lib/product-words"
import { fetchService } from "../../lib/services"
import { PersonPicker } from "../person-picker"
import { ServiceSelect } from "../service-select"
import { whenSaid } from "./shared"
import { type AgendaException, EMPTY_WHEN, exceptionFlags, useWhen, WHEN_FIELD_MAP, WhenFields, type WhenValues } from "./when"

/** Con qué se abre «Nueva cita»: nada, un hueco tocado en la rejilla o un paciente. */
export interface BookingSeed {
  patient?: { id: string; name: string }
  /**
   * Quien escribe y aún no es paciente («Reservar cita» desde «Contexto»): se
   * registra aquí con lo mínimo y su ficha queda unida a esa misma persona.
   */
  person?: { contactId: string; name: string; phone: string | null; givenNames?: string | null; familyName?: string | null }
  /** El paciente viene de un caso o de su ficha: no se cambia aquí. */
  lockedPatient?: boolean
  conversationId?: string
  professionalUserId?: string | null
  /** Su nombre, por si no tiene horario en la sede (se sumó a la vista para una excepción). */
  professionalLabel?: string
  /** Instante del hueco ya elegido. */
  startsAt?: string
  /** Día en que se abre el selector. */
  date?: string
  /** «Agendar» desde el Plan: el servicio de lo aceptado, ya elegido. */
  serviceId?: string
  /**
   * Tratamientos aceptados que esta cita viene a hacer (`appointment_plan_item`):
   * la atención de la cita los trae a «Hecho hoy». Vienen marcados los del primer
   * servicio; lo demás aceptado sin cita se ve sin marcar.
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
  // Con más de una sede, se dice en cuál se reserva (la que se eligió en la Agenda).
  const branchList =
    useQuery({
      queryKey: ["branches"],
      queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    }).data?.data ?? []
  const bookingBranch = branchList.length > 1 ? (branchList.find((item) => item.id === branchId)?.name ?? null) : null
  // ----- A quién -----
  const [registering, setRegistering] = React.useState(Boolean(seed.person))
  const [created, setCreated] = React.useState<{ id: string; name: string } | null>(null)
  const submissionId = React.useRef(crypto.randomUUID())
  const queryClient = useQueryClient()
  // Registrar a alguien pide su propio permiso: sin él solo se elige entre quienes ya existen.
  const canRegister = usePermission("patients.write")
  const can = useCan()
  const profile = useOrgProfile()
  const tradeName = profile.data?.tradeName?.trim() || null
  // Lo que la clínica pide en su registro y aquí no se escribe: queda pendiente en su página.
  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>("/api/patient-registration/config"),
    enabled: registering && (can("crm.read") || can("settings.read")),
    retry: false,
  })
  // Solo se le dice «te escribiremos por WhatsApp» si de verdad saldrán los recordatorios (B2).
  const remindersQuery = useQuery({
    queryKey: ["appointments", "reminders-via"],
    queryFn: () => apiFetch<{ data: { via: "whatsapp" | null } }>("/api/appointments/reminders-via"),
    enabled: registering,
    retry: false,
  })
  const remindersByWhatsApp = remindersQuery.data?.data.via === "whatsapp"

  // Lo que se avisa después de reservar y no debe perderse con el toast.
  const consentNote = React.useRef<string | null>(null)
  const whatsappNote = React.useRef<string | null>(null)
  // El paso en curso: un rechazo del registro dice a quién no se pudo registrar.
  const phase = React.useRef<"registro" | "cita">("cita")

  const save = useMutation({
    mutationFn: (input: { patientId: string; value: BookingValues; range: ScheduleRangeValue; exception: AgendaException | null; planItemIds?: string[] }) =>
      apiFetch<{ data: AgendaAppointment & { reminderReach?: ReminderReach | null } }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId: input.patientId,
          professionalUserId: input.range.columnId,
          serviceId: input.value.serviceId || undefined,
          // La lista que se ve, aunque quede vacía: sin decir nada, el servidor une lo aceptado del servicio.
          ...(input.planItemIds ? { planItemIds: input.planItemIds } : {}),
          startsAt: input.range.start,
          endsAt: input.range.end,
          reason: input.value.reason.trim() || undefined,
          conversationId: seed.conversationId,
          source: seed.conversationId ? "conversacion" : "recepcion",
          // Lo que se avisó al elegir la hora: una excepción que decide una persona del equipo.
          ...exceptionFlags(input.exception),
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
    // Se anota en su persona, como en Datos › Mensajes, diciendo que lo dijo por teléfono: los mensajes
    // de su cita solo si se le dijo que le escribirán por WhatsApp (B2, como `saveLinkConsents` en su
    // enlace) y su respuesta a novedades y promociones.
    await (async () => {
      const personId =
        seed.person?.contactId ??
        (await apiFetch<{ data: { personId: string } }>(`/api/people/by-patient/${registered.data.id}`)).data.personId
      const permission = (tipo: "recordatorio" | "novedades", recibir: boolean) =>
        apiFetch(`/api/agent/admin/people/${personId}/permissions`, {
          method: "POST",
          body: JSON.stringify({ tipo, recibir, source: "telefono" }),
        })
      if (remindersByWhatsApp) await permission("recordatorio", true)
      if (value.generalConsent !== null) await permission("novedades", value.generalConsent)
    })().catch(() => {
      consentNote.current = "No se pudo anotar lo que dijo de sus mensajes: anótalo en su página, en Datos › Mensajes."
    })
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
    // A quien se registra se le pregunta por novedades: sin su respuesta no se guarda.
    generalConsent: registering
      ? z
          .boolean()
          .nullable()
          .refine((consent) => consent !== null, "Pregúntale y elige una opción.")
      : z.boolean().nullable(),
    serviceId: z.string(),
    reason: z.string().max(500, "Escribe el motivo en 500 caracteres o menos."),
    // El «cuándo» lo valida `WhenFields` con lo que ve en las horas.
    when: z.object({ startsAt: z.string(), professionalUserId: z.string() }),
  })

  const form = useAppForm({
    defaultValues: (() => {
      // «Nombres» y «Apellidos»: lo guardado va donde se guardó. Sin nada guardado, el nombre de su
      // perfil: lo que sigue a la primera palabra va entero a los apellidos.
      const given = seed.person?.givenNames
      const family = seed.person?.familyName
      const [first = "", ...rest] = given || family ? [] : (seed.person?.name ?? "").trim().split(/\s+/)
      return {
        patientId: seed.patient?.id ?? "",
        givenNames: given ?? first,
        surname: family ?? rest.join(" "),
        phone: seed.person?.phone ?? null,
        generalConsent: null,
        serviceId: seed.serviceId ?? "",
        reason: "",
        when: EMPTY_WHEN,
      } as BookingValues
    })(),
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const range = when.shown
      // El «cuándo» ya validó que hay un hueco elegido.
      if (!range) return
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
        const result = await save.mutateAsync({
          patientId,
          value,
          range,
          exception: when.exception,
          planItemIds: chosenItemsFor(patientId),
        })
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

  // ----- Para qué -----
  // Lo aceptado sin cita de esta persona, o con sesiones por reservar (la segunda de una
  // endodoncia en dos), con su título: el que ve recepción (sin piezas ni precios).
  const coordinationQuery = useQuery({
    queryKey: ["treatment-coordination", values.patientId],
    queryFn: () => fetchTreatmentCoordination(values.patientId),
    enabled: Boolean(values.patientId) && !registering,
    retry: false,
  })
  // También lo que pidió el Plan aunque ya tenga otra cita: lo pidió para esta y se ve.
  const seededItems = values.patientId === seed.patient?.id ? seed.planItemIds : undefined
  const toSchedule = React.useMemo(
    () =>
      coordinationQuery.data?.data.treatments.filter(
        (row) => row.toSchedule || row.sessionsLeft > 0 || seededItems?.includes(row.id),
      ) ?? [],
    [coordinationQuery.data, seededItems],
  )
  // Dos iguales son una casilla: recepción no ve las piezas y elegir entre ellos sería a ciegas.
  // Uno solo de varias sesiones dice cuál sería esta cita: «Endodoncia · sesión 2 de 2».
  const toScheduleRows = React.useMemo(() => {
    const rows = new Map<string, { key: string; title: string; ids: string[]; session: string | null }>()
    for (const item of toSchedule) {
      const key = `${item.serviceId ?? ""}|${item.title}`
      const row = rows.get(key) ?? { key, title: item.title, ids: [], session: null }
      row.ids.push(item.id)
      const next = item.nextSession
      row.session = row.ids.length === 1 && next && showsSession(next.n, next.m) ? sessionWords(next.n, next.m) : null
      rows.set(key, row)
    }
    return [...rows.values()]
  }, [toSchedule])
  const [marked, setMarked] = React.useState<{ patientId: string; ids: string[] } | null>(null)
  const markedIds = marked?.patientId === values.patientId ? marked.ids : []
  const itemsOfService = (id: string, items = toSchedule) =>
    items.filter((row) => (row.serviceId ?? "") === id).map((row) => row.id)
  /** El servicio que se puso solo: si cambia de persona, era de la anterior. */
  const autoService = React.useRef<string | null>(null)
  // Al conocer lo aceptado de la persona, vienen marcados los del primer servicio: varios
  // servicios en una cita corta no caben, y lo demás queda a la vista para marcarlo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: corre al llegar la lista de cada persona.
  React.useEffect(() => {
    if (!coordinationQuery.data || marked?.patientId === values.patientId) return
    const chosen = values.serviceId === autoService.current ? "" : values.serviceId
    const fromSeed = toSchedule.find((row) => seed.planItemIds?.includes(row.id))
    const first = chosen || (fromSeed ?? toSchedule[0])?.serviceId || ""
    setMarked({ patientId: values.patientId, ids: itemsOfService(first) })
    // Con un hueco o un profesional ya elegidos no se cambia el servicio: podría no atenderlo.
    if (!seed.startsAt && !seed.professionalUserId && !when.professionalFilter && first !== values.serviceId) {
      autoService.current = first || null
      // No lo eligió la persona: cerrar sin tocar nada no pregunta si descarta.
      form.setFieldValue("serviceId", first, { dontUpdateMeta: true })
    }
  }, [coordinationQuery.data, values.patientId])
  /** Lo que la cita trae; sin la lista (rol sin acceso o paciente recién registrado), lo que pidió el Plan o la regla del servidor. */
  const chosenItemsFor = (patientId: string): string[] | undefined => {
    // Solo lo que se ve: lo que otra persona reservó entre tanto ya no está en la lista.
    if (coordinationQuery.data && patientId === values.patientId)
      return markedIds.filter((id) => toSchedule.some((row) => row.id === id))
    return seed.planItemIds?.length && patientId === seed.patient?.id ? seed.planItemIds : undefined
  }
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
    professionalLabel: seed.professionalLabel,
    startsAt: seed.startsAt,
    // Con servicio, la agenda ofrece solo a quien lo atiende (ADR 0039).
    serviceId: serviceId || undefined,
  })
  const { shown } = when

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
    // Se registra a otra persona: lo de la que estaba elegida (sus tratamientos y el
    // servicio que se puso solo) era suyo.
    form.setFieldValue("patientId", "")
    if (autoService.current && values.serviceId === autoService.current)
      form.setFieldValue("serviceId", "", { dontUpdateMeta: true })
    autoService.current = null
    setMarked(null)
    setRegistering(true)
  }
  const pickPatient = (patient: { id: string; name: string }) => {
    setCreated(patient)
    form.setFieldValue("patientId", patient.id)
    setRegistering(false)
  }
  const submitLabel = !shown
    ? "Reservar cita"
    : when.state === "outside"
      ? "Reservar fuera de horario"
      : when.state === "taken"
        ? "Reservar igual"
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
        description={`${bookingBranch ? `En ${bookingBranch}. ` : ""}Elige a quién y cuándo. La ${appWords().room.one} se asigna con el hueco.`}
        onClose={onClose}

        submitLabel={submitLabel}
      >
        <div className="grid gap-4">
          {seed.lockedPatient && seed.patient ? (
            <div className="grid gap-1">
              <FieldTitle>Paciente</FieldTitle>
              <p className="text-sm font-medium">{seed.patient.name}</p>
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
              {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040): queda guardado. Solo si saldrán. */}
              {remindersByWhatsApp ? (
                <p className="text-xs text-muted-foreground">
                  Díselo: «Te escribiremos por WhatsApp sobre tu cita: la confirmación, los recordatorios y los cambios.»
                </p>
              ) : remindersQuery.isSuccess ? (
                <p className="text-xs text-muted-foreground">
                  Esta clínica no envía hoy los recordatorios por WhatsApp: no se lo prometas.
                </p>
              ) : null}
              <form.AppField name="generalConsent">
                {(field) => (
                  <field.Group
                    legend={`¿Acepta recibir novedades y promociones${tradeName ? ` de ${tradeName}` : ""} por WhatsApp?`}
                    className="gap-1.5"
                  >
                    {(control) => (
                      <div className="flex flex-wrap gap-2">
                        {[
                          { value: true, id: "cita-nuevo-permiso-si", label: "Sí, aceptó por teléfono" },
                          { value: false, id: "cita-nuevo-permiso-no", label: "No aceptó" },
                        ].map((option) => (
                          <Button
                            key={option.label}
                            id={option.id}
                            type="button"
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            variant={field.state.value === option.value ? "default" : "outline"}
                            aria-pressed={field.state.value === option.value}
                            aria-describedby={control.describedBy}
                            onClick={() => field.handleChange(option.value)}
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

          {toScheduleRows.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label" className="mb-0">
                Para esta cita
              </FieldLegend>
              <FieldGroup className="gap-2">
                {toScheduleRows.map((row, index) => (
                  <Field key={row.key} orientation="horizontal">
                    <Checkbox
                      id={`cita-tratamiento-${index}`}
                      checked={row.ids.every((id) => markedIds.includes(id))}
                      onCheckedChange={(checked) =>
                        setMarked({
                          patientId: values.patientId,
                          ids: checked
                            ? [...markedIds.filter((id) => !row.ids.includes(id)), ...row.ids]
                            : markedIds.filter((id) => !row.ids.includes(id)),
                        })
                      }
                    />
                    <FieldLabel htmlFor={`cita-tratamiento-${index}`} className="font-normal">
                      {row.title}
                      {row.ids.length > 1 ? ` × ${row.ids.length}` : ""}
                      {row.session ? ` · ${row.session}` : ""}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
              <FieldDescription>
                Tratamientos aceptados con sesiones por reservar. Los que marques quedan listos en su atención.
              </FieldDescription>
            </FieldSet>
          ) : null}

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
                      autoService.current = null
                      // Otro servicio marca lo suyo; lo demás sigue a la vista.
                      if (coordinationQuery.data) setMarked({ patientId: values.patientId, ids: itemsOfService(next?.id ?? "") })
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
    </>
  )
}
