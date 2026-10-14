import { canAccessAny, platformPathPermission, ROLE_LABELS } from "@odentia/auth/permissions"
import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog, EmptyState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError } from "../../lib/api"
import {
  archiveSpecialty,
  createSpecialty,
  fetchProfessionalSpecialties,
  fetchServiceSpecialties,
  fetchSpecialties,
  fetchSpecialtyProfessionals,
  type Specialty,
  saveProfessionalSpecialties,
  saveServiceSpecialties,
  updateSpecialty,
} from "../../lib/clinical-forms"
import { useMyRole, useOrgMembers, usePermission } from "../../lib/crm"
import { fetchServices } from "../../lib/services"

export const Route = createFileRoute("/_org/settings/specialties")({
  component: SpecialtiesPage,
})

const TITLE = "Especialidades"
const SUBTITLE = "Las especialidades que atiende tu clínica, con sus profesionales."
/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-3 rounded-xl border bg-card p-5"
const LINK = "font-semibold text-primary underline-offset-4 hover:underline"

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/** ¿Puede este rol abrir esa pantalla? Un enlace solo se ofrece a quien puede. */
function useCanOpen(path: string): boolean {
  const role = useMyRole()
  const permissions = platformPathPermission(path)
  return permissions === null || canAccessAny(role, permissions)
}

/**
 * Especialidades de la clínica: la lista, y de cada una sus datos, quiénes la
 * atienden y los servicios que tiene vinculados. Crear una aquí la deja
 * disponible para las plantillas de formularios y consentimientos.
 */
function SpecialtiesPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("settings.read")
  const canAdmin = usePermission("settings.write")
  // Al lado: una especialidad nueva o la que se edita.
  const sideForm = useSideForm<Specialty>()
  const openForm = sideForm.open
  const [archiving, setArchiving] = useState<Specialty | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["specialties"],
    queryFn: () => fetchSpecialties(),
    enabled: canRead,
    retry: 1,
  })
  const specialties = listQuery.data?.data ?? []
  const selected = specialties.find((item) => item.id === selectedId) ?? specialties[0] ?? null

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["specialties"] })

  const archiveMutation = useMutation({
    mutationFn: (specialty: Specialty) => archiveSpecialty(specialty.id),
    onSuccess: (_result, specialty) => {
      setArchiving(null)
      toast.success(`Especialidad «${specialty.name}» archivada`)
      void invalidate()
    },
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const neverLoaded = listQuery.isError && listQuery.data === undefined

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          canAdmin ? (
            <Button type="button" className="min-h-11" onClick={() => openForm(null)}>
              <Plus aria-hidden />
              Nueva especialidad
            </Button>
          ) : undefined
        }
      />

      {listQuery.isPending ? (
        <SpecialtiesSkeleton />
      ) : neverLoaded ? (
        <SettingsLoadError what="las especialidades" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="las especialidades" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {specialties.length === 0 ? (
            <EmptyState
              title="Aún no hay especialidades"
              description="Con ellas dices quién atiende qué y ordenas las plantillas de formularios y consentimientos."
              {...(canAdmin
                ? { actionLabel: "Agrega la primera especialidad", onAction: () => openForm(null) }
                : {})}
            />
          ) : (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <ul aria-label="Especialidades de la clínica" className="flex flex-col gap-1">
                {specialties.map((item) => (
                  <li key={item.id}>
                    <Button
                      type="button"
                      variant={selected?.id === item.id ? "secondary" : "ghost"}
                      aria-current={selected?.id === item.id ? "true" : undefined}
                      className="h-auto min-h-11 w-full justify-between gap-2 rounded-xl px-3 py-2 text-left whitespace-normal"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="min-w-0 font-medium">{item.name}</span>
                      {item.isActive ? null : <Badge variant="secondary">Archivada</Badge>}
                    </Button>
                  </li>
                ))}
              </ul>
              {selected ? (
                <SpecialtyDetail
                  key={selected.id}
                  specialty={selected}
                  canAdmin={canAdmin}
                  onEdit={() => openForm(selected)}
                  onArchive={() => {
                    archiveMutation.reset()
                    setArchiving(selected)
                  }}
                />
              ) : null}
            </div>
          )}
        </>
      )}

      {canAdmin && sideForm.form ? (
        <SpecialtyForm
          key={sideForm.form.opening}
          specialty={sideForm.form.target}
          onDirtyChange={sideForm.setDirty}
          onClose={sideForm.close}
          onSaved={(saved) => {
            sideForm.close()
            setSelectedId(saved.id)
            void invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={sideForm} what="otra especialidad" />

      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Archivar «${archiving?.name ?? ""}»`}
        description="Deja de ofrecerse al crear plantillas de formularios y consentimientos. Lo que ya se hizo con ella se conserva, y puedes reactivarla después."
        confirmLabel="Archivar"
        variant="default"
        pending={archiveMutation.isPending}
        onConfirm={() => archiving && archiveMutation.mutate(archiving)}
      >
        {archiveMutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(archiveMutation.error, "No pudimos archivar la especialidad. Vuelve a intentarlo.")}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/** El hueco de la pantalla mientras carga: la lista a la izquierda y el detalle al lado. */
function SpecialtiesSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <p role="status" className="sr-only">
        Cargando las especialidades…
      </p>
      <div className="flex flex-col gap-2" aria-hidden>
        {["w-40", "w-32", "w-44", "w-36"].map((width) => (
          <div key={width} className="flex min-h-11 items-center px-3">
            <Skeleton className={`h-4 ${width}`} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  )
}

/** Nombre y descripción, con su «Guardar». La clave interna la genera el servidor. */
function SpecialtyForm({
  specialty,
  onDirtyChange,
  onClose,
  onSaved,
}: {
  specialty: Specialty | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onSaved: (saved: Specialty) => void
}) {
  const ids = useId()
  const [name, setName] = useState(specialty?.name ?? "")
  const [description, setDescription] = useState(specialty?.description ?? "")
  const [nameError, setNameError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (values: { name: string; description: string | null }) =>
      (specialty ? updateSpecialty(specialty.id, values) : createSpecialty(values)).then((result) => result.data),
    onSuccess: (saved) => {
      toast.success(`Especialidad «${saved.name}» guardada`)
      onSaved(saved)
    },
  })

  const isDirty = name !== (specialty?.name ?? "") || description !== (specialty?.description ?? "")
  useReportDirty(isDirty, onDirtyChange)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={specialty ? "Editar especialidad" : "Nueva especialidad"}
      isDirty={isDirty}
      isSubmitting={save.isPending}
      error={save.isError ? errorText(save.error, "No pudimos guardar la especialidad. Vuelve a intentarlo.") : null}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const trimmed = name.trim()
        if (trimmed.length < 2) {
          setNameError("Escribe el nombre de la especialidad")
          return
        }
        setNameError(null)
        save.mutate({ name: trimmed, description: description.trim() ? description.trim() : null })
      }}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-nombre`}>Nombre</FieldLabel>
          <Input
            id={`${ids}-nombre`}
            value={name}
            placeholder="Endodoncia"
            maxLength={120}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <FieldError>{nameError}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-descripcion`}>Descripción (opcional)</FieldLabel>
          <Textarea
            id={`${ids}-descripcion`}
            value={description}
            rows={3}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
    </FormDrawer>
  )
}

function SpecialtyDetail({
  specialty,
  canAdmin,
  onEdit,
  onArchive,
}: {
  specialty: Specialty
  canAdmin: boolean
  onEdit: () => void
  onArchive: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{specialty.name}</h2>
            <Badge variant={specialty.isActive ? "success" : "secondary"}>
              {specialty.isActive ? "Activa" : "Archivada"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{specialty.description || "Sin descripción."}</p>
        </div>
        {canAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onEdit}>
              Editar
            </Button>
            {specialty.isActive ? (
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onArchive}>
                Archivar
              </Button>
            ) : (
              <ReactivateButton specialty={specialty} />
            )}
          </div>
        ) : null}
      </div>
      <ProfessionalAssignment specialty={specialty} canAdmin={canAdmin} />
      <ServiceAssignment specialty={specialty} canAdmin={canAdmin} />
    </div>
  )
}

function ReactivateButton({ specialty }: { specialty: Specialty }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => updateSpecialty(specialty.id, { isActive: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["specialties"] })
      toast.success(`Especialidad «${specialty.name}» reactivada`)
    },
    onError: (error) => toast.error(errorText(error, "No pudimos reactivar la especialidad. Vuelve a intentarlo.")),
  })
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 sm:min-h-8"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      Reactivar
    </Button>
  )
}

/** Quiénes atienden la especialidad. Cada interruptor guarda al momento y lo dice. */
function ProfessionalAssignment({ specialty, canAdmin }: { specialty: Specialty; canAdmin: boolean }) {
  const members = useOrgMembers()
  const canOpenTeam = useCanOpen("/settings/team")
  const queryClient = useQueryClient()
  const assignedQuery = useQuery({
    queryKey: ["specialty-professionals", specialty.id],
    queryFn: () => fetchSpecialtyProfessionals(specialty.id),
    retry: 1,
  })
  const assigned = new Set((assignedQuery.data?.data ?? []).map((row) => row.userId))
  const mutation = useMutation({
    mutationFn: async ({ userId, attends }: { userId: string; name: string; attends: boolean }) => {
      // Se guarda la lista completa de esa persona: se parte de la que tiene hoy.
      const current = await fetchProfessionalSpecialties(userId)
      const ids = new Set(current.data.map((item) => item.id))
      if (attends) ids.add(specialty.id)
      else ids.delete(specialty.id)
      return saveProfessionalSpecialties(userId, [...ids])
    },
    onSuccess: (_result, { name, attends }) => {
      toast.success(attends ? `${name} ahora atiende ${specialty.name}` : `${name} ya no atiende ${specialty.name}`)
      void queryClient.invalidateQueries({ queryKey: ["specialty-professionals", specialty.id] })
    },
    onError: (error) => toast.error(errorText(error, "No pudimos guardar el cambio. Vuelve a intentarlo.")),
  })
  const neverLoaded = assignedQuery.isError && assignedQuery.data === undefined

  return (
    <section className={CARD} aria-labelledby={`profesionales-${specialty.id}`}>
      <div className="flex flex-col gap-1">
        <h3 id={`profesionales-${specialty.id}`} className="text-sm font-semibold">
          Profesionales
        </h3>
        <p className="text-sm text-muted-foreground">Quiénes de tu equipo atienden esta especialidad.</p>
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aún no hay nadie en el equipo.{" "}
          {canOpenTeam ? (
            <Link to="/settings/team" className={LINK}>
              Invitar a alguien en Equipo
            </Link>
          ) : null}
        </p>
      ) : assignedQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="sr-only">
            Cargando quiénes atienden esta especialidad…
          </p>
          <Skeleton className="h-5 w-56" aria-hidden />
          <Skeleton className="h-5 w-48" aria-hidden />
        </div>
      ) : neverLoaded ? (
        <SettingsLoadError what="quiénes atienden esta especialidad" onRetry={() => void assignedQuery.refetch()} />
      ) : (
        <ul className="flex flex-col divide-y">
          {members.map((member) => {
            const id = `atiende-${specialty.id}-${member.userId}`
            const role = ROLE_LABELS[member.role as keyof typeof ROLE_LABELS]
            return (
              <li key={member.userId} className="flex min-h-11 items-center gap-3 py-2">
                <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{member.user.name}</span>
                  {role ? <span className="text-muted-foreground"> · {role}</span> : null}
                </label>
                <Switch
                  id={id}
                  checked={assigned.has(member.userId)}
                  disabled={!canAdmin || mutation.isPending}
                  onCheckedChange={(checked) =>
                    mutation.mutate({ userId: member.userId, name: member.user.name, attends: checked })
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Servicios vinculados a la especialidad. El vínculo se cambia servicio por
 * servicio, con su botón; nada más se toca del servicio.
 */
function ServiceAssignment({ specialty, canAdmin }: { specialty: Specialty; canAdmin: boolean }) {
  const [serviceId, setServiceId] = useState<string>("")
  const canOpenServices = useCanOpen("/services")
  const queryClient = useQueryClient()
  const servicesQuery = useQuery({
    queryKey: ["services-all"],
    queryFn: () => fetchServices({ limit: 100 }),
    retry: 1,
  })
  const services = servicesQuery.data?.data ?? []
  const linkedQuery = useQuery({
    queryKey: ["service-specialties", serviceId],
    queryFn: () => fetchServiceSpecialties(serviceId),
    enabled: serviceId !== "",
    retry: 1,
  })
  const linked = new Set((linkedQuery.data?.data ?? []).map((item) => item.id))
  const isLinked = linked.has(specialty.id)
  const serviceName = services.find((service) => service.id === serviceId)?.name ?? "El servicio"
  const mutation = useMutation({
    mutationFn: (link: boolean) => {
      const ids = new Set(linked)
      if (link) ids.add(specialty.id)
      else ids.delete(specialty.id)
      return saveServiceSpecialties(serviceId, [...ids])
    },
    onSuccess: (_result, link) => {
      toast.success(
        link
          ? `${serviceName} quedó vinculado a ${specialty.name}`
          : `${serviceName} ya no está vinculado a ${specialty.name}`,
      )
      void queryClient.invalidateQueries({ queryKey: ["service-specialties", serviceId] })
    },
    onError: (error) => toast.error(errorText(error, "No pudimos guardar el cambio. Vuelve a intentarlo.")),
  })
  const servicesNeverLoaded = servicesQuery.isError && servicesQuery.data === undefined

  return (
    <section className={CARD} aria-labelledby={`servicios-${specialty.id}`}>
      <div className="flex flex-col gap-1">
        <h3 id={`servicios-${specialty.id}`} className="text-sm font-semibold">
          Servicios de la clínica
        </h3>
        <p className="text-sm text-muted-foreground">
          Elige un servicio para vincularlo con esta especialidad o quitarle el vínculo.
        </p>
      </div>
      {servicesQuery.isPending ? (
        <div>
          <p role="status" className="sr-only">
            Cargando los servicios…
          </p>
          <Skeleton className="h-9 w-64 max-w-full" aria-hidden />
        </div>
      ) : servicesNeverLoaded ? (
        <SettingsLoadError what="los servicios" onRetry={() => void servicesQuery.refetch()} />
      ) : services.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aún no hay servicios.{" "}
          {canOpenServices ? (
            <Link to="/services" className={LINK}>
              Agregar el primero en Servicios
            </Link>
          ) : null}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={serviceId}
              items={Object.fromEntries(services.map((service) => [service.id, service.name]))}
              onValueChange={(value: string | null) => setServiceId(value ?? "")}
            >
              <SelectTrigger className="w-64 max-w-full" aria-label="Servicio">
                <SelectValue placeholder="Elige un servicio" />
              </SelectTrigger>
              <SelectContent>
                {services.map((service) => (
                  <SelectItem key={service.id} value={service.id}>
                    {service.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canAdmin ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
                disabled={!serviceId || !linkedQuery.data || mutation.isPending}
                onClick={() => mutation.mutate(!isLinked)}
              >
                {isLinked ? "Quitar el vínculo" : "Vincular"}
              </Button>
            ) : null}
          </div>
          {serviceId && linkedQuery.isError ? (
            <SettingsLoadError
              stale={linkedQuery.data !== undefined}
              what="el vínculo de ese servicio"
              onRetry={() => void linkedQuery.refetch()}
            />
          ) : serviceId && linkedQuery.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              {isLinked ? "Está vinculado a esta especialidad." : "No está vinculado a esta especialidad."}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
