import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import {
  dayMinutesIn,
  FormDrawer,
  hourLabel,
  normalizeCountry,
  PhoneInput,
  ResourceSelect,
  type ScheduleColumn,
  type SchedulePreview,
  type ScheduleRangeValue,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import * as React from "react"
import type { AgendaAppointment, AgendaServiceOption } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { PersonPicker } from "../person-picker"
import { errorMessage, whenSaid } from "./shared"
import { useWhen, WhenFields } from "./when"

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
  dentistUserId?: string | null
  /** Instante del hueco ya elegido. */
  startsAt?: string
  /** Día en que se abre el selector. */
  date?: string
}

/**
 * Nueva cita: a quién y cuándo. El «cuándo» es el mismo de reprogramar
 * (`useWhen`): lo blanco está libre, y el bloque se arrastra y se estira. El
 * sillón lo pone la agenda. Quien aún no es paciente se registra aquí mismo
 * con lo mínimo.
 */
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
  const [patientId, setPatientId] = React.useState(seed.patient?.id ?? "")
  const [registering, setRegistering] = React.useState(Boolean(seed.person))
  const [newPatient, setNewPatient] = React.useState(() => {
    const [first = "", ...rest] = (seed.person?.name ?? "").trim().split(/\s+/)
    return { givenNames: first, surname: rest.join(" ") }
  })
  const [newPhone, setNewPhone] = React.useState<string | null>(seed.person?.phone ?? null)
  const [created, setCreated] = React.useState<{ id: string; name: string } | null>(null)
  const submissionId = React.useRef(crypto.randomUUID())
  const queryClient = useQueryClient()
  // Registrar a alguien pide su propio permiso: sin él solo se elige entre quienes ya existen.
  const canRegister = usePermission("patients.write")
  const [registerFailed, setRegisterFailed] = React.useState(false)
  const profile = useOrgProfile()

  const newName = `${newPatient.givenNames.trim()} ${newPatient.surname.trim()}`.trim()
  // Quien abrió el formulario, se eligió o se acaba de registrar: su nombre se conserva.
  const patientName = registering
    ? newName || undefined
    : [created, seed.patient].find((known) => known && known.id === patientId)?.name

  // Antes de registrar a alguien, se mira si ya existe con ese nombre o teléfono.
  const duplicatesQuery = useQuery({
    queryKey: ["patients", "duplicates", newName, newPhone],
    // Con la persona del caso no se busca otra: su ficha se une a ella.
    enabled: registering && !seed.person && newName.length >= 3,
    queryFn: () => {
      const params = new URLSearchParams({ displayName: newName })
      if (newPhone) params.set("phone", newPhone)
      return apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients/duplicates?${params}`,
      )
    },
  })
  const duplicates = registering ? (duplicatesQuery.data?.data ?? []) : []

  // ----- Qué -----
  const [serviceId, setServiceId] = React.useState("")
  const [reason, setReason] = React.useState("")
  const servicesQuery = useQuery({
    queryKey: ["services", "agenda-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const service = (servicesQuery.data?.data ?? []).find((item) => item.id === serviceId)
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
    dentistUserId: seed.dentistUserId,
    startsAt: seed.startsAt,
  })
  const { shown, state, professional, chosenMinutes, nextFree, hoursThatDay, free } = when

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

  // ----- Reservar -----
  const [error, setError] = React.useState("")
  const [urgent, setUrgent] = React.useState(false)
  const save = useMutation({
    mutationFn: async (input: { range: ScheduleRangeValue; outsideSchedule?: boolean }) => {
      let id = patientId
      if (registering) {
        if (!newPatient.givenNames.trim() || !newPatient.surname.trim()) {
          throw new Error("Escribe los nombres y los apellidos.")
        }
        // El mismo registro de pacientes de siempre, con lo mínimo: el resto de la ficha se completa después.
        const registered = await apiFetch<{ data: { id: string; displayName: string } }>(
          "/api/patients",
          {
            method: "POST",
            body: JSON.stringify({
              submissionId: submissionId.current,
              registeredBranchId: branchId,
              answers: {
                demographics: {
                  displayName: newName,
                  givenNames: newPatient.givenNames.trim(),
                  paternalSurname: newPatient.surname.trim(),
                  ...(newPhone ? { phone: newPhone } : {}),
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
              // Desde su conversación basta lo mínimo, como en el enlace de reserva: lo que la
              // clínica pide y falta queda anotado en el caso y la identidad, por revisar.
              ...(seed.person && seed.conversationId
                ? { conversationId: seed.conversationId, scope: "essentials" }
                : {}),
            }),
          },
        ).catch((cause) => {
          // La clínica puede exigir más datos de los que caben aquí: se dice y se ofrece el registro completo.
          setRegisterFailed(true)
          throw new Error(`No se pudo registrar a ${newName}: ${errorMessage(cause)}`)
        })
        id = registered.data.id
        // Las búsquedas de pacientes ya hechas dejaron de valer.
        void queryClient.invalidateQueries({ queryKey: ["patients"] })
        // Si la reserva fallara después, la persona ya está registrada: no se crea dos veces.
        setCreated({ id, name: registered.data.displayName })
        setPatientId(id)
        setRegistering(false)
      }
      if (!id) throw new Error("Elige un paciente.")
      return apiFetch<{ data: AgendaAppointment }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId: id,
          dentistUserId: input.range.columnId,
          serviceId: serviceId || undefined,
          startsAt: input.range.start,
          endsAt: input.range.end,
          reason: reason.trim() || undefined,
          conversationId: seed.conversationId,
          source: seed.conversationId ? "conversacion" : "recepcion",
          outsideSchedule: input.outsideSchedule,
        }),
      })
    },
    onSuccess: async (result) => {
      // Si «Recordar la cita» está prendida, el agente le avisa solo: recepción no escribe nada.
      toast.success(`Cita reservada ${whenSaid(result.data.startsAt, timeZone, today)}`, {
        description: result.data.notice?.queued
          ? `El agente le avisa a ${result.data.patientName.split(/\s+/)[0]} por su conversación.`
          : undefined,
      })
      await onSaved(result.data)
    },
    onError: (cause) => {
      setUrgent(false)
      setError(errorMessage(cause))
      // Si alguien tomó el hueco, lo libre se vuelve a pedir.
      when.refetch()
    },
  })

  const startRegistering = (typed = "") => {
    // Lo que ya se tecleó al buscar sirve de punto de partida.
    const [first = "", ...rest] = typed.trim().split(/\s+/)
    setNewPatient({ givenNames: first, surname: rest.join(" ") })
    setRegistering(true)
  }
  const hasPatient = registering
    ? Boolean(newPatient.givenNames.trim() && newPatient.surname.trim())
    : Boolean(patientId)
  const submitLabel = !shown
    ? "Reservar cita"
    : registering
      ? // El día ya se lee justo encima: el botón tiene que caber junto a «Cancelar».
        `Registrar y reservar a las ${hourLabel(dayMinutesIn(shown.start, timeZone))}`
      : `Reservar ${whenSaid(shown.start, timeZone, today)}`

  return (
    <>
      <FormDrawer
        open
        title="Nueva cita"
        description="Elige a quién y cuándo. El sillón se asigna con el hueco."
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault()
          setError("")
          if (!shown) return
          // Fuera del horario no se reserva sin más: se pregunta si es una urgencia.
          if (state === "outside") setUrgent(true)
          else save.mutate({ range: shown })
        }}
        isSubmitting={save.isPending}
        isDirty={Boolean((hasPatient && !seed.lockedPatient) || reason)}
        error={error || null}
        submitDisabled={!hasPatient || !shown || state === "taken"}
        submitLabel={submitLabel}
      >
        <div className="grid gap-4">
          {seed.lockedPatient && seed.patient ? (
            <div>
              <FieldLabel>Paciente del caso</FieldLabel>
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
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="cita-nuevo-nombres">Nombres</FieldLabel>
                  <Input
                    id="cita-nuevo-nombres"
                    maxLength={100}
                    value={newPatient.givenNames}
                    onChange={(event) =>
                      setNewPatient((current) => ({ ...current, givenNames: event.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="cita-nuevo-apellidos">Apellidos</FieldLabel>
                  <Input
                    id="cita-nuevo-apellidos"
                    maxLength={100}
                    value={newPatient.surname}
                    onChange={(event) =>
                      setNewPatient((current) => ({ ...current, surname: event.target.value }))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="cita-nuevo-telefono">Teléfono</FieldLabel>
                <PhoneInput
                  id="cita-nuevo-telefono"
                  value={newPhone}
                  defaultCountry={normalizeCountry(profile.data?.countryCode)}
                  onChange={(next) => setNewPhone(next)}
                />
              </div>
              {duplicates.length > 0 ? (
                <div
                  role="status"
                  className="grid gap-1.5 rounded-xl bg-warning-soft p-2.5 text-sm"
                >
                  <span className="font-semibold text-warning-foreground">
                    Puede que ya esté registrada:
                  </span>
                  {duplicates.slice(0, 3).map((match) => (
                    <Button
                      key={match.id}
                      variant="outline"
                      size="sm"
                      className="justify-start bg-card"
                      onClick={() => {
                        setCreated({ id: match.id, name: match.displayName })
                        setPatientId(match.id)
                        setRegistering(false)
                      }}
                    >
                      Usar a {match.displayName}
                    </Button>
                  ))}
                </div>
              ) : null}
              {registerFailed ? (
                <p className="text-sm">
                  Si la clínica pide más datos para registrar,{" "}
                  <Link
                    to="/people"
                    target="_blank"
                    className="font-semibold text-primary underline"
                  >
                    regístrala en Pacientes
                  </Link>{" "}
                  y vuelve para elegirla aquí.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {seed.person
                    ? "Se crea su ficha con nombre y teléfono, unida a esta persona. El resto lo completa con el enlace de registro o cuando venga."
                    : "Con esto basta para la cita. El documento y el resto de la ficha se completan cuando venga."}
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-1.5">
              {/* El buscador de personas de toda la aplicación, solo con pacientes (ADR 0029). */}
              <PersonPicker
                label="Paciente"
                patientsOnly
                value={patientId ? { id: `ficha:${patientId}`, name: patientName ?? "", patientId } : null}
                onChange={(person) => {
                  if (person?.patientId) {
                    setCreated({ id: person.patientId, name: person.name })
                    setPatientId(person.patientId)
                  } else setPatientId("")
                }}
                onCreate={canRegister ? (typed) => startRegistering(typed) : undefined}
                createLabel={(typed) => `Registrar a ${typed}`}
              />
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

          <ResourceSelect
            id="cita-servicio"
            label="Servicio (opcional)"
            options={(servicesQuery.data?.data ?? []).map((item) => ({
              id: item.id,
              label: item.name,
              detail: item.durationMin ? `${item.durationMin} min` : undefined,
            }))}
            value={serviceId}
            onChange={(next) => {
              setServiceId(next)
              // Con servicio, el bloque toma lo que dura el servicio.
              const minutes =
                (servicesQuery.data?.data ?? []).find((item) => item.id === next)?.durationMin ??
                defaultMinutes
              when.resize(minutes)
            }}
          />

          <WhenFields when={when} />

          <div className="grid gap-2">
            <FieldLabel htmlFor="cita-motivo">Motivo (opcional)</FieldLabel>
            <Input
              id="cita-motivo"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
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
                disabled={save.isPending}
                pending={save.isPending && !save.variables?.outsideSchedule}
                onClick={() =>
                  save.mutate({
                    range: {
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
                    },
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
              className="text-warning-foreground"
              disabled={save.isPending}
              pending={save.isPending && save.variables?.outsideSchedule === true}
              onClick={() => shown && save.mutate({ range: shown, outsideSchedule: true })}
            >
              Reservar igual a las {shown ? hourLabel(dayMinutesIn(shown.start, timeZone)) : ""}
            </SubmitButton>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
