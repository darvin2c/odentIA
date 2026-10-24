import { canAccessAny, platformPathPermission } from "@odentia/auth/permissions"
import {
  Badge,
  Button,
  cn,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataRefreshMarker,
  dayMinutesIn,
  EmptyState,
  ErrorState,
  formatDateLong,
  formatSpan,
  hourLabel,
  PageHeader,
  RowActions,
  ScheduleResourceChips,
  SubmitButton,
  scheduleToneAt,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Building2, Plus } from "lucide-react"
import * as React from "react"
import { AbsenceForm, type AbsenceScope } from "../../components/agenda/absence-form"
import { RoomForm } from "../../components/agenda/room-form"
import { useWeeklySchedule, WeeklyScheduleFields } from "../../components/agenda/schedule-editor"
import { errorMessage, shortName } from "../../components/agenda/shared"
import { BranchSwitcher } from "../../components/branch-switcher"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { useActiveBranch } from "../../lib/active-branch"
import type {
  AgendaAppointment,
  AgendaResources,
  RoomSetting,
  ScheduleBlock,
} from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"
import { useMyRole, usePermission } from "../../lib/crm"
import { usePageDraftGuard } from "../../lib/page-draft-guard"
import { appWords, upperFirst } from "../../lib/product-words"

export const Route = createFileRoute("/_org/settings/availability")({
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    ...search,
    branch: typeof search.branch === "string" ? search.branch : undefined,
  }),
  component: AvailabilityPage,
})

/** Duraciones que se ofrecen para una cita regular (las mismas que valida el servicio). */
const REGULAR_MINUTES = [15, 30, 45, 60, 90, 120]

/** Hasta cuándo se listan ausencias, feriados y cierres. */
const AHEAD_DAYS = 60

const CARD = "grid content-start gap-3 rounded-xl border bg-background p-3 sm:p-4"

/** Sin sede elegida todavía: lo que hacen la página y sus formularios. */
const SUBTITLE = "El horario y las ausencias de cada profesional, y lo que vale para toda la sede."

function GroupTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mt-2 grid gap-0.5">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}

function CardHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2">
      <h3 className="min-w-0 flex-1 font-semibold">{title}</h3>
      {action}
    </div>
  )
}

/** Una lista de la tarjeta que no cargó: lo dice y deja reintentar, sin retirar el resto. */
function CardError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-destructive"
    >
      No pudimos cargar {what}.
      <Button variant="outline" size="sm" onClick={onRetry}>
        Reintentar
      </Button>
    </p>
  )
}

/** Lo que se va a quitar, con lo que pasa al quitarlo. */
interface Removal {
  block: ScheduleBlock
  title: string
  description: string
}

/**
 * Horarios y ausencias de una sede, en dos grupos: lo de cada profesional (su
 * horario de la semana y los días que no viene) y lo de la sede (unidades dentales,
 * duración de una cita regular, feriados y cierres).
 */
function AvailabilityPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const role = useMyRole()
  const canRead = usePermission("settings.read")
  const canConfigure = usePermission("settings.write")
  // Un enlace a otra pantalla solo se ofrece a quien puede abrirla.
  const canOpen = (path: string) => {
    const permissions = platformPathPermission(path)
    return permissions === null || canAccessAny(role, permissions)
  }
  // La misma sede que la Agenda: la del enlace o la última elegida.
  const sede = useActiveBranch()
  const resourcesQuery = useQuery({
    queryKey: ["agenda-resources", sede.branchId ?? null],
    enabled: canRead && sede.ready,
    queryFn: () =>
      apiFetch<{ data: AgendaResources }>(
        `/api/agenda/resources${sede.branchId ? `?branchId=${encodeURIComponent(sede.branchId)}` : ""}`,
      ),
  })
  const resources = resourcesQuery.data?.data
  const professionals = React.useMemo(
    () =>
      (resources?.professionals ?? []).map((item, index) => ({
        id: item.id,
        label: item.label,
        tone: scheduleToneAt(index),
      })),
    [resources],
  )
  const [pickedProfessionalId, setPickedProfessionalId] = React.useState("")
  const professional = professionals.find((item) => item.id === pickedProfessionalId) ?? professionals[0]
  const professionalId = professional?.id ?? ""

  const schedule = useWeeklySchedule({
    branchId: resources?.branchId,
    professionalUserId: professionalId,
  })
  const draftGuard = usePageDraftGuard(schedule.dirty)

  const range = React.useMemo(
    () => ({
      from: new Date().toISOString(),
      to: new Date(Date.now() + AHEAD_DAYS * 86_400_000).toISOString(),
    }),
    [],
  )
  const blocksQuery = useQuery({
    queryKey: ["schedule-blocks", resources?.branchId],
    enabled: Boolean(resources?.branchId),
    queryFn: () =>
      apiFetch<{ data: ScheduleBlock[] }>(
        `/api/agenda/blocks?branchId=${resources?.branchId}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  })
  const blocks = blocksQuery.data?.data ?? []
  const absences = blocks.filter((block) => block.professionalUserId === professionalId)
  const closures = blocks.filter((block) => block.professionalUserId === null)
  // Las unidades dentales de la sede para administrarlas: también las desactivadas.
  const roomsQuery = useQuery({
    queryKey: ["agenda-rooms", resources?.branchId],
    enabled: Boolean(resources?.branchId),
    queryFn: () =>
      apiFetch<{ data: RoomSetting[] }>(`/api/agenda/rooms?branchId=${resources?.branchId}`),
  })
  const rooms = roomsQuery.data?.data
  // Citas en pie del profesional: las que caen en una ausencia hay que moverlas.
  const standingQuery = useQuery({
    queryKey: ["agenda", "ausencias", resources?.branchId, professionalId, range.from],
    enabled: Boolean(resources?.branchId && professionalId && absences.length > 0),
    queryFn: () => {
      const params = new URLSearchParams({
        branchId: resources?.branchId ?? "",
        from: range.from,
        to: range.to,
        status: "programada,confirmada",
        professionals: professionalId,
      })
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const insideOf = (block: ScheduleBlock) =>
    (standingQuery.data?.data ?? []).filter(
      (item) =>
        Date.parse(item.endsAt) > Date.parse(block.startsAt) &&
        Date.parse(item.startsAt) < Date.parse(block.endsAt),
    )

  const [absenceForm, setAbsenceForm] = React.useState<AbsenceScope | null>(null)
  /** `"new"` añade una unidad dental; una unidad dental, la renombra. El formulario es el mismo. */
  const [roomForm, setRoomForm] = React.useState<"new" | RoomSetting | null>(null)
  const [deactivatingRoom, setDeactivatingRoom] = React.useState<RoomSetting | null>(null)
  const [removal, setRemoval] = React.useState<Removal | null>(null)
  const invalidateBlocks = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["schedule-blocks"] }),
      queryClient.invalidateQueries({ queryKey: ["agenda-availability"] }),
    ])
  }
  const invalidateRooms = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agenda-rooms"] }),
      queryClient.invalidateQueries({ queryKey: ["agenda-resources"] }),
      queryClient.invalidateQueries({ queryKey: ["agenda-availability"] }),
    ])
  }

  const durationMutation = useMutation({
    mutationFn: (minutes: number) =>
      apiFetch("/api/agenda/settings", {
        method: "PUT",
        body: JSON.stringify({ branchId: resources?.branchId, defaultDurationMin: minutes }),
      }),
    onSuccess: async (_result, minutes) => {
      toast.success(`Una cita regular dura ${formatSpan(minutes)}`)
      await queryClient.invalidateQueries({ queryKey: ["agenda-resources"] })
      await queryClient.invalidateQueries({ queryKey: ["agenda-availability"] })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  // Mientras se guarda se muestra lo elegido; si falla, vuelve lo que hay en el servidor.
  const regularMinutes =
    durationMutation.isPending && durationMutation.variables !== undefined
      ? durationMutation.variables
      : (resources?.defaultDurationMin ?? 60)

  const removeMutation = useMutation({
    mutationFn: (block: ScheduleBlock) =>
      apiFetch(`/api/agenda/blocks/${block.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRemoval(null)
      toast.success("Quitado: ese tramo vuelve a ofrecerse")
      await invalidateBlocks()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const roomActiveMutation = useMutation({
    mutationFn: ({ room, isActive }: { room: RoomSetting; isActive: boolean }) =>
      apiFetch(`/api/agenda/rooms/${room.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: async (_result, { room, isActive }) => {
      setDeactivatingRoom(null)
      toast.success(
        isActive ? `${room.name} vuelve a estar activa` : `${room.name} quedó desactivada`,
      )
      await invalidateRooms()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  if (!canRead) {
    return (
      <div className="grid gap-4">
        <PageHeader title="Horarios y ausencias" subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  // La clínica no tiene ninguna sede activa: no es un fallo, falta un paso.
  const noBranch =
    resources === undefined &&
    resourcesQuery.error instanceof ApiError &&
    resourcesQuery.error.status === 404
  const activeRooms = (rooms ?? []).filter((room) => room.isActive)
  /** A qué alcanza un cierre: toda la sede o una unidad dental, aunque hoy esté desactivada. */
  const closureScope = (block: ScheduleBlock) =>
    block.roomId === null
      ? "toda la sede"
      : (rooms?.find((room) => room.id === block.roomId)?.name ??
        resources?.rooms.find((room) => room.id === block.roomId)?.label ??
        `una ${appWords().room.one}`)
  const reasonOf = (block: ScheduleBlock) =>
    block.reason ?? (block.kind === "ausencia" ? "Ausencia" : "Cierre")

  return (
    <div className="grid gap-4">
      {draftGuard.dialog}
      <PageHeader
        title="Horarios y ausencias"
        subtitle={
          resources ? (
            <>
              <BranchSwitcher
                branches={sede.branches}
                value={resources.branchId}
                fallbackName={resources.branchName}
                onChange={(id) =>
                  draftGuard.requestLeave(() => {
                    sede.choose(id)
                    setPickedProfessionalId("")
                  })
                }
              />
              <span className="truncate">, zona {resources.timeZone}</span>
            </>
          ) : (
            SUBTITLE
          )
        }
      />
      {resources ? (
        <>
          <GroupTitle
            title="De cada profesional"
            hint="Su horario de la semana y los días que no viene."
          />
          {professional ? (
            <>
              <ScheduleResourceChips
                wrap
                label="Profesional"
                resources={professionals}
                formatLabel={(item) => shortName(item.label)}
                value={professionalId}
                onChange={(next) => {
                  if (!next || next === professionalId) return
                  draftGuard.requestLeave(() => setPickedProfessionalId(next))
                }}
              />

              <section className={CARD}>
                <CardHead title={`Horario semanal de ${professional.label}`} />
                <WeeklyScheduleFields schedule={schedule} canEdit={canConfigure} />
                {schedule.validFrom ? (
                  <p className="text-sm text-muted-foreground">
                    Vigente desde el {formatDateLong(schedule.validFrom).replace(/^\S+ /, "")}. Un cambio vale desde hoy: el horario anterior se guarda, para que
                    Reportes calcule cada día con el horario que tenía.
                  </p>
                ) : null}
                {schedule.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {schedule.error}
                  </p>
                ) : null}
                {canConfigure ? (
                  <div>
                    <SubmitButton
                      disabled={!schedule.dirty}
                      pending={schedule.saving}
                      onClick={() => schedule.save()}
                    >
                      Guardar horario
                    </SubmitButton>
                  </div>
                ) : null}
              </section>

              <section className={CARD}>
                <CardHead
                  title={`Ausencias de ${professional.label}`}
                  action={
                    canConfigure ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setAbsenceForm({
                            kind: "person",
                            professionalUserId: professional.id,
                            name: professional.label,
                          })
                        }
                      >
                        <Plus aria-hidden />
                        Nueva ausencia
                      </Button>
                    ) : null
                  }
                />
                {blocksQuery.isError && blocksQuery.data === undefined ? (
                  <CardError what="las ausencias" onRetry={() => void blocksQuery.refetch()} />
                ) : blocksQuery.isPending ? (
                  <Skeleton className="h-9 w-full" />
                ) : absences.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Sin vacaciones ni permisos en los próximos {AHEAD_DAYS} días.
                  </p>
                ) : (
                  <ul className="grid">
                    {absences.map((block) => {
                      const inside = insideOf(block)
                      const first = inside[0]
                      const when = blockWhen(block, resources.timeZone)
                      return (
                        <BlockRow
                          key={block.id}
                          reason={reasonOf(block)}
                          when={when}
                          onRemove={
                            canConfigure
                              ? () =>
                                  setRemoval({
                                    block,
                                    title: `Quitar la ausencia de ${professional.label}`,
                                    description: `${reasonOf(block)}: ${when}. Al quitarla, ${professional.label} vuelve a ofrecerse para reservar en ese tramo.`,
                                  })
                              : undefined
                          }
                          note={
                            first ? (
                              <Link
                                to="/agenda"
                                search={{
                                  view: "lista",
                                  date: zonedDateOf(first.startsAt, resources.timeZone),
                                  who: professional.id,
                                  branch: resources.branchId,
                                }}
                                className="text-sm font-bold text-warning underline-offset-4 hover:underline"
                              >
                                {inside.length === 1
                                  ? "1 cita por mover"
                                  : `${inside.length} citas por mover`}
                              </Link>
                            ) : null
                          }
                        />
                      )
                    })}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Esta sede aún no tiene profesionales.{" "}
              {canOpen("/settings/team") ? (
                <Link
                  to="/settings/team"
                  className="font-bold text-primary underline-offset-4 hover:underline"
                >
                  Invita a alguien en Equipo
                </Link>
              ) : (
                "Pídele a quien administra la clínica que los invite."
              )}
            </p>
          )}

          <GroupTitle
            title="De la sede"
            hint={`Vale para todos los profesionales de ${resources.branchName}.`}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <section className={CARD}>
              <CardHead
                title={upperFirst(appWords().room.many)}
                action={
                  canConfigure ? (
                    <Button variant="outline" size="sm" onClick={() => setRoomForm("new")}>
                      <Plus aria-hidden />
                      Añadir {appWords().room.one}
                    </Button>
                  ) : null
                }
              />
              {roomsQuery.isError && rooms === undefined ? (
                <CardError what={`las ${appWords().room.many}`} onRetry={() => void roomsQuery.refetch()} />
              ) : rooms === undefined ? (
                <Skeleton className="h-9 w-full" />
              ) : rooms.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Esta sede aún no tiene {appWords().room.many}: sin al menos una no se puede reservar.
                </p>
              ) : (
                <>
                  <ul className="grid">
                    {rooms.map((room) => (
                      <li
                        key={room.id}
                        className="flex min-h-11 items-center gap-2 border-b text-sm last:border-b-0"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate font-medium",
                            !room.isActive && "text-muted-foreground",
                          )}
                        >
                          {room.name}
                        </span>
                        {room.isActive ? null : <Badge variant="secondary">Desactivada</Badge>}
                        {canConfigure ? (
                          <RowActions
                            label={`Acciones de ${room.name}`}
                            items={[
                              {
                                key: "rename",
                                label: "Renombrar",
                                onSelect: () => setRoomForm(room),
                              },
                              room.isActive
                                ? {
                                    key: "deactivate",
                                    label: "Desactivar",
                                    tone: "danger" as const,
                                    onSelect: () => setDeactivatingRoom(room),
                                  }
                                : {
                                    key: "reactivate",
                                    label: "Reactivar",
                                    disabled: roomActiveMutation.isPending,
                                    onSelect: () =>
                                      roomActiveMutation.mutate({ room, isActive: true }),
                                  },
                            ]}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {activeRooms.length === 0 ? (
                    <p className="text-sm font-medium text-warning">
                      Ninguna {appWords().room.one} está activa: sin al menos una no se puede reservar.
                    </p>
                  ) : null}
                </>
              )}
            </section>

            <section className={CARD}>
              <div className="flex min-h-9 flex-wrap items-center gap-x-3">
                <h3 id="duracion-regular" className="min-w-0 flex-1 font-semibold">
                  Duración de una cita regular
                </h3>
                {durationMutation.isPending ? <DataRefreshMarker message="Guardando…" /> : null}
              </div>
              <RadioGroup
                aria-labelledby="duracion-regular"
                className="flex flex-wrap gap-2"
                disabled={!canConfigure || durationMutation.isPending}
                value={String(regularMinutes)}
                onValueChange={(next) => durationMutation.mutate(Number(next))}
              >
                {REGULAR_MINUTES.map((minutes) => (
                  <FieldLabel
                    key={minutes}
                    className={cn(
                      "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
                      regularMinutes === minutes && "border-primary bg-primary-soft",
                    )}
                  >
                    <RadioGroupItem value={String(minutes)} />
                    {formatSpan(minutes)}
                  </FieldLabel>
                ))}
              </RadioGroup>
              <p className="text-sm text-muted-foreground">
                Lo que dura una cita sin servicio. Con servicio manda su duración, y al reservar se
                puede cambiar estirando el bloque. Se guarda al elegirla.
              </p>
            </section>
          </div>

          <section className={CARD}>
            <CardHead
              title="Feriados y cierres"
              action={
                canConfigure ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAbsenceForm({ kind: "branch", name: resources.branchName })}
                  >
                    <Plus aria-hidden />
                    Nuevo feriado o cierre
                  </Button>
                ) : null
              }
            />
            {blocksQuery.isError && blocksQuery.data === undefined ? (
              <CardError what="los feriados y cierres" onRetry={() => void blocksQuery.refetch()} />
            ) : blocksQuery.isPending ? (
              <Skeleton className="h-9 w-full" />
            ) : closures.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin feriados ni cierres en los próximos {AHEAD_DAYS} días.
              </p>
            ) : (
              <ul className="grid">
                {closures.map((block) => {
                  const when = blockWhen(block, resources.timeZone)
                  const scope = closureScope(block)
                  return (
                    <BlockRow
                      key={block.id}
                      reason={reasonOf(block)}
                      when={when}
                      scope={scope}
                      onRemove={
                        canConfigure
                          ? () =>
                              setRemoval({
                                block,
                                title: "Quitar el feriado o cierre",
                                description: `${reasonOf(block)}: ${when}, ${scope}. Al quitarlo, ese tramo vuelve a ofrecerse para reservar.`,
                              })
                          : undefined
                      }
                    />
                  )
                })}
              </ul>
            )}
          </section>
        </>
      ) : noBranch ? (
        <EmptyState
          icon={Building2}
          title="No hay ninguna sede activa"
          description="Los horarios y las ausencias son de una sede. Reactiva una o crea la primera en Sedes."
          actionLabel={canOpen("/settings/branches") ? "Ir a Sedes" : undefined}
          onAction={
            canOpen("/settings/branches")
              ? () => void navigate({ to: "/settings/branches" })
              : undefined
          }
        />
      ) : resourcesQuery.isError ? (
        <ErrorState
          title="No pudimos cargar los horarios y ausencias"
          message="Comprueba tu conexión y vuelve a intentarlo."
          onRetry={() => void resourcesQuery.refetch()}
        />
      ) : (
        <AvailabilitySkeleton />
      )}
      {roomForm && resources ? (
        <RoomForm
          key={roomForm === "new" ? "new" : roomForm.id}
          branchId={resources.branchId}
          branchName={resources.branchName}
          suggestedName={`${upperFirst(appWords().room.one)} ${(rooms?.length ?? resources.rooms.length) + 1}`}
          room={roomForm === "new" ? undefined : { id: roomForm.id, name: roomForm.name }}
          onClose={() => setRoomForm(null)}
          onSaved={async () => {
            setRoomForm(null)
            await invalidateRooms()
          }}
        />
      ) : null}
      {absenceForm && resources ? (
        <AbsenceForm
          branchId={resources.branchId}
          timeZone={resources.timeZone}
          today={zonedDateOf(new Date().toISOString(), resources.timeZone)}
          scope={absenceForm}
          rooms={resources.rooms}
          onClose={() => setAbsenceForm(null)}
          onSaved={async () => {
            setAbsenceForm(null)
            await invalidateBlocks()
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removal !== null}
        onClose={() => setRemoval(null)}
        onConfirm={() => removal && removeMutation.mutate(removal.block)}
        title={removal?.title ?? ""}
        description={removal?.description ?? ""}
        confirmLabel="Quitar"
        variant="destructive"
        pending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={deactivatingRoom !== null}
        onClose={() => setDeactivatingRoom(null)}
        onConfirm={() =>
          deactivatingRoom &&
          roomActiveMutation.mutate({ room: deactivatingRoom, isActive: false })
        }
        title={`Desactivar ${deactivatingRoom?.name ?? ""}`}
        description={
          deactivatingRoom ? roomConsequence(deactivatingRoom, activeRooms.length) : ""
        }
        confirmLabel="Desactivar"
        variant="destructive"
        pending={roomActiveMutation.isPending}
      />
    </div>
  )
}

/** Lo que pasa al desactivar una unidad dental, con sus citas por delante y si es la última activa. */
function roomConsequence(room: RoomSetting, activeCount: number): string {
  const word = appWords().room.one
  const parts = ["No se podrán reservar citas nuevas en ella. Puedes reactivarla cuando quieras."]
  if (room.upcomingAppointments === 1) {
    parts.push(`Tiene 1 cita por venir: sigue en esta ${word} y no se mueve sola.`)
  } else if (room.upcomingAppointments > 1) {
    parts.push(
      `Tiene ${room.upcomingAppointments} citas por venir: siguen en esta ${word} y no se mueven solas.`,
    )
  }
  if (activeCount <= 1)
    parts.push(`Es la única ${word} activa de la sede: sin una no se puede reservar.`)
  return parts.join(" ")
}

/** Una fila por día del horario semanal, para reservar su hueco. */
const WEEK_SLOTS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"]

/** El hueco de la pantalla mientras llega la sede: sus dos grupos y sus tarjetas. */
function AvailabilitySkeleton() {
  return (
    <div role="status" aria-busy aria-label="Cargando horarios y ausencias…" className="grid gap-4">
      <div aria-hidden className="grid gap-4">
        <div className="mt-2 grid gap-1.5">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-64 max-w-full rounded-full" />
        <div className={CARD}>
          <Skeleton className="h-5 w-60 max-w-full" />
          {WEEK_SLOTS.map((day) => (
            <Skeleton key={day} className="h-10 w-full" />
          ))}
        </div>
        <div className={CARD}>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="mt-2 grid gap-1.5">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={CARD}>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className={CARD}>
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** «Del lunes 12 de octubre al viernes 16 de octubre» o «Lunes 12 de octubre, de 12:00 a 14:00». */
function blockWhen(block: ScheduleBlock, timeZone: string): string {
  const first = zonedDateOf(block.startsAt, timeZone)
  const last = zonedDateOf(new Date(Date.parse(block.endsAt) - 1).toISOString(), timeZone)
  const startMinutes = dayMinutesIn(block.startsAt, timeZone)
  const endMinutes = dayMinutesIn(block.endsAt, timeZone)
  const wholeDays = startMinutes === 0 && endMinutes === 0
  if (first === last) {
    return wholeDays
      ? `${formatDateLong(first)}, todo el día`
      : `${formatDateLong(first)}, de ${hourLabel(startMinutes)} a ${hourLabel(endMinutes)}`
  }
  const lower = (text: string) => text.toLocaleLowerCase("es")
  return wholeDays
    ? `Del ${lower(formatDateLong(first))} al ${lower(formatDateLong(last))}`
    : `Del ${lower(formatDateLong(first))} ${hourLabel(startMinutes)} al ${lower(formatDateLong(last))} ${hourLabel(endMinutes)}`
}

function BlockRow({
  reason,
  when,
  onRemove,
  scope,
  note,
}: {
  /** Por qué no se atiende: «Vacaciones», «Feriado»… */
  reason: string
  when: string
  /** Quitarlo pregunta antes; sin esto, la fila solo se lee. */
  onRemove?: () => void
  /** A qué alcanza un cierre: toda la sede o una unidad dental. */
  scope?: string
  /** Aviso de la fila: citas que quedaron dentro. */
  note?: React.ReactNode
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-sm last:border-b-0">
      <Badge variant="soft">{reason}</Badge>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{when}</span>
        {scope ? <span className="text-muted-foreground"> · {scope}</span> : null}
      </span>
      {note}
      {onRemove ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onRemove}>
          Quitar
          <span className="sr-only">
            {reason}: {when}
          </span>
        </Button>
      ) : null}
    </li>
  )
}
