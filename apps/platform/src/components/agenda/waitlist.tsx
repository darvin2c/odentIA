import { Button, FieldLabel, Input, toast } from "@odentia/ui"
import { DetailDrawer, FormDrawer, ResourceSelect } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import * as React from "react"
import type {
  AgendaResources,
  AgendaServiceOption,
  AvailableSlot,
  WaitlistEntry,
  WaitlistPriority,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { AgendaSlotPicker } from "../agenda-slot-picker"
import { errorMessage } from "./shared"

const PRIORITY_OPTIONS: WaitlistPriority[] = ["alta", "normal", "baja"]

/** Personas que esperan hueco en la sede; la cuenta va en el botón que abre la lista. */
export function useWaitlist(branchId: string | undefined) {
  return useQuery({
    queryKey: ["agenda-waitlist", branchId],
    enabled: branchId != null,
    queryFn: () =>
      apiFetch<{ data: WaitlistEntry[] }>(
        `/api/agenda/waitlist?branchId=${branchId ?? ""}&status=en_espera,ofrecida`,
      ),
  })
}

/** Lista de espera de la sede: registro, ofrecimiento de huecos y reserva. */
export function WaitlistDrawer({
  branchId,
  timeZone,
  resources,
  day,
  canOperate,
  onClose,
  onChanged,
}: {
  branchId: string
  timeZone: string
  resources: AgendaResources
  day: string
  canOperate: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [offerFor, setOfferFor] = React.useState<WaitlistEntry | null>(null)
  const [formOpen, setFormOpen] = React.useState(false)
  const waitlistQuery = useWaitlist(branchId)
  const entries = waitlistQuery.data?.data ?? []
  return (
    <>
      <DetailDrawer
        open
        title="Lista de espera"
        description={
          entries.length === 0
            ? "Nadie espera hueco en esta sede."
            : `${entries.length} ${entries.length === 1 ? "persona espera" : "personas esperan"} hueco en esta sede.`
        }
        onClose={onClose}
        isLoading={waitlistQuery.isLoading}
        error={waitlistQuery.isError ? "No se pudo cargar la lista de espera." : null}
        actions={
          canOperate ? <Button onClick={() => setFormOpen(true)}>Añadir a la lista</Button> : undefined
        }
      >
        <ul className="grid gap-2">
          {entries.map((entry) => (
            <WaitlistRow
              key={entry.id}
              entry={entry}
              timeZone={timeZone}
              canOperate={canOperate}
              onOffer={() => setOfferFor(entry)}
              onChanged={async () => {
                await waitlistQuery.refetch()
                await onChanged()
              }}
            />
          ))}
        </ul>
      </DetailDrawer>
      {formOpen && (
        <WaitlistForm
          branchId={branchId}
          resources={resources}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false)
            await waitlistQuery.refetch()
          }}
        />
      )}
      {offerFor && (
        <SlotOfferPicker
          entry={offerFor}
          branchId={branchId}
          timeZone={timeZone}
          day={day}
          professionals={resources.professionals}
          onClose={() => setOfferFor(null)}
          onSaved={async () => {
            setOfferFor(null)
            await waitlistQuery.refetch()
            await onChanged()
          }}
        />
      )}
    </>
  )
}

function WaitlistRow({
  entry,
  timeZone,
  canOperate,
  onOffer,
  onChanged,
}: {
  entry: WaitlistEntry
  timeZone: string
  canOperate: boolean
  onOffer: () => void
  onChanged: () => Promise<void>
}) {
  const [error, setError] = React.useState("")
  const run = useMutation({
    mutationFn: (action: "book" | "cancel") =>
      apiFetch(`/api/agenda/waitlist/${entry.id}/${action}`, { method: "POST", body: "{}" }),
    onSuccess: async (_data, action) => {
      toast.success(action === "book" ? "Cita confirmada." : "Espera cancelada.")
      await onChanged()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  const subject = entry.patientName ?? entry.contactName ?? "Sin nombre"
  return (
    <li className="grid gap-1 rounded-lg border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{subject}</span>
        <span className="text-xs text-muted-foreground">Prioridad {entry.priority}</span>
        <span className="text-xs text-muted-foreground">
          {entry.status === "ofrecida" ? "Hueco ofrecido" : "En espera"}
        </span>
        {entry.serviceName && <span className="text-xs">{entry.serviceName}</span>}
        {entry.dentistName && (
          <span className="text-xs text-muted-foreground">{entry.dentistName}</span>
        )}
      </div>
      {entry.notes && <p className="text-xs text-muted-foreground">{entry.notes}</p>}
      {entry.offeredStartsAt && entry.offeredEndsAt && (
        <p className="text-xs">
          Ofrecido: {new Date(entry.offeredStartsAt).toLocaleString("es-PE", { timeZone })} →{" "}
          {new Date(entry.offeredEndsAt).toLocaleTimeString("es-PE", { timeZone })}
        </p>
      )}
      {canOperate && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOffer}>
            Ofrecer hueco
          </Button>
          {entry.status === "ofrecida" && (
            <Button variant="outline" size="sm" onClick={() => run.mutate("book")}>
              Confirmar reserva
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => run.mutate("cancel")}>
            Cancelar espera
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </li>
  )
}

function WaitlistForm({
  branchId,
  resources,
  onClose,
  onSaved,
}: {
  branchId: string
  resources: AgendaResources
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [patientId, setPatientId] = React.useState("")
  const [patientQuery, setPatientQuery] = React.useState("")
  const [dentistUserId, setDentistUserId] = React.useState("")
  const [serviceId, setServiceId] = React.useState("")
  const [priority, setPriority] = React.useState<WaitlistPriority>("normal")
  const [notes, setNotes] = React.useState("")
  const [error, setError] = React.useState("")
  const patientsQuery = useQuery({
    queryKey: ["patients", "waitlist-picker", patientQuery],
    queryFn: () =>
      apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients?q=${encodeURIComponent(patientQuery)}&limit=20`,
      ),
    placeholderData: (previous) => previous,
  })
  const servicesQuery = useQuery({
    queryKey: ["services", "waitlist-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const save = useMutation({
    mutationFn: async () => {
      if (!patientId) throw new Error("Elige un paciente.")
      await apiFetch("/api/agenda/waitlist", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId,
          dentistUserId: dentistUserId || null,
          serviceId: serviceId || null,
          priority,
          notes: notes.trim() || undefined,
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Espera registrada.")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title="Añadir a lista de espera"
      description="Registra un paciente pendiente de hueco en esta sede."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty
      error={error || null}
      submitLabel="Registrar espera"
    >
      <div className="grid gap-4">
        <ResourceSelect
          id="espera-paciente"
          label="Paciente"
          options={(patientsQuery.data?.data ?? []).map((patient) => ({
            id: patient.id,
            label: patient.displayName,
          }))}
          value={patientId}
          onChange={setPatientId}
          onQueryChange={setPatientQuery}
        />
        <ResourceSelect
          id="espera-profesional"
          label="Profesional preferido (opcional)"
          options={[{ id: "", label: "Sin preferencia" }].concat(
            resources.professionals.map((item) => ({ id: item.id, label: item.label })),
          )}
          value={dentistUserId}
          onChange={setDentistUserId}
        />
        <ResourceSelect
          id="espera-servicio"
          label="Servicio (opcional)"
          options={[{ id: "", label: "Sin servicio" }].concat(
            (servicesQuery.data?.data ?? []).map((service) => ({
              id: service.id,
              label: service.name,
            })),
          )}
          value={serviceId}
          onChange={setServiceId}
        />
        <div className="grid gap-2">
          <FieldLabel htmlFor="espera-prioridad">Prioridad</FieldLabel>
          <select
            id="espera-prioridad"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={priority}
            onChange={(event) => setPriority(event.target.value as WaitlistPriority)}
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "alta" ? "Alta" : option === "baja" ? "Baja" : "Normal"}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <FieldLabel htmlFor="espera-notas">Notas (opcional)</FieldLabel>
          <Input
            id="espera-notas"
            value={notes}
            maxLength={500}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>
    </FormDrawer>
  )
}

/** Busca huecos reales y ofrece uno a la espera con el mismo servicio. */
function SlotOfferPicker({
  entry,
  branchId,
  timeZone,
  day,
  professionals,
  onClose,
  onSaved,
}: {
  entry: WaitlistEntry
  branchId: string
  timeZone: string
  day: string
  professionals: { id: string; label: string }[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [error, setError] = React.useState("")
  const offer = useMutation({
    mutationFn: (slot: AvailableSlot) =>
      apiFetch(`/api/agenda/waitlist/${entry.id}/offer`, {
        method: "POST",
        body: JSON.stringify({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          dentistUserId: slot.dentistUserId,
          chairId: slot.chairId,
        }),
      }),
    onSuccess: async () => {
      toast.success("Hueco ofrecido.")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title="Ofrecer hueco"
      description={`Huecos reales para ${entry.patientName ?? entry.contactName ?? "la espera"}${entry.serviceName ? ` · ${entry.serviceName}` : ""}.`}
      onClose={onClose}
      onSubmit={(event) => event.preventDefault()}
      isSubmitting={offer.isPending}
      isDirty={false}
      error={error || null}
      submitLabel="Cerrar"
    >
      <AgendaSlotPicker
        branchId={branchId}
        timeZone={timeZone}
        day={day}
        professionals={professionals}
        serviceId={entry.serviceId}
        initialProfessionalId={entry.dentistUserId}
        disabled={offer.isPending}
        actionLabel="Ofrecer"
        onSelect={(slot) => {
          setError("")
          offer.mutate(slot)
        }}
      />
    </FormDrawer>
  )
}
