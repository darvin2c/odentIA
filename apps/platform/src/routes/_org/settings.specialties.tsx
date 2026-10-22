import { canAccessAny, platformPathPermission, ROLE_LABELS } from "@odentia/auth/permissions"
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, EmptyState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError } from "../../lib/api"
import {
  archiveSpecialty,
  createSpecialty,
  fetchSpecialtiesOverview,
  type SpecialtyOverview,
  saveSpecialtyProfessionals,
  updateSpecialty,
} from "../../lib/clinical-forms"
import { useMyRole, useOrgMembers, usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/specialties")({
  component: SpecialtiesPage,
})

const TITLE = "Especialidades"
const SUBTITLE = "Las especialidades de tu clínica y quién atiende cada una. La agenda ofrece cada servicio a quien atiende su especialidad."
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

/** «6 servicios», «1 servicio». */
function servicesWord(count: number): string {
  return count === 1 ? "1 servicio" : `${count} servicios`
}

/** Lo que se abre al lado: la especialidad (o una nueva) y, con «Elegir quién atiende», el foco en quién atiende. */
interface FormTarget {
  specialty: SpecialtyOverview
  chooseWho: boolean
}

/**
 * Configuración › Especialidades (fase 4, tablero 2): una sola lista, la de la
 * clínica, que nace con las de la biblioteca. Aquí solo se nombran y se dice
 * quién atiende cada una; la especialidad de un servicio se elige en su
 * formulario. Cada fila cuenta sus servicios y lleva a Servicios ya filtrado.
 * Si nadie atiende una especialidad con servicios, se avisa: la agenda los
 * ofrece a cualquiera (decisión 2).
 */
function SpecialtiesPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("settings.read")
  const canAdmin = usePermission("settings.write")
  const canOpenServices = useCanOpen("/services")
  const sideForm = useSideForm<FormTarget>()
  const openForm = sideForm.open
  const [archiving, setArchiving] = useState<SpecialtyOverview | null>(null)

  const listQuery = useQuery({
    queryKey: ["specialties", "overview"],
    queryFn: () => fetchSpecialtiesOverview(),
    enabled: canRead,
    retry: 1,
  })
  const specialties = listQuery.data?.data ?? []

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["specialties"] })

  const archiveMutation = useMutation({
    mutationFn: (specialty: SpecialtyOverview) => archiveSpecialty(specialty.id),
    onSuccess: (_result, specialty) => {
      setArchiving(null)
      sideForm.close()
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
        primary={
          canAdmin ? { label: "Agregar especialidad", icon: <Plus aria-hidden />, onClick: () => openForm(null) } : undefined
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
              description="Con ellas dices quién atiende qué: la agenda ofrece cada servicio a quien atiende su especialidad."
              {...(canAdmin
                ? { actionLabel: "Agrega la primera especialidad", onAction: () => openForm(null) }
                : {})}
            />
          ) : (
            <ul aria-label="Especialidades de la clínica" className="elevated flex flex-col divide-y rounded-xl border bg-card">
              {specialties.map((item) => (
                <SpecialtyRow
                  key={item.id}
                  specialty={item}
                  canAdmin={canAdmin}
                  canOpenServices={canOpenServices}
                  onEdit={(chooseWho) => openForm({ specialty: item, chooseWho })}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {canAdmin && sideForm.form ? (
        <SpecialtyForm
          key={sideForm.form.opening}
          target={sideForm.form.target}
          onDirtyChange={sideForm.setDirty}
          onClose={sideForm.close}
          onArchive={(specialty) => {
            archiveMutation.reset()
            setArchiving(specialty)
          }}
          onSaved={() => {
            sideForm.close()
            void invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={sideForm} what="otra especialidad" />

      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Archivar «${archiving?.name ?? ""}»`}
        description="Deja de ofrecerse al elegir la especialidad de un servicio y al crear plantillas. Sus servicios la conservan y la agenda deja de aplicarla: los ofrece a cualquiera. Puedes reactivarla después."
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

/**
 * Una especialidad en una línea: quién la atiende y cuántos servicios tiene.
 * Sin nadie y con servicios, el aviso y su acción.
 */
function SpecialtyRow({
  specialty,
  canAdmin,
  canOpenServices,
  onEdit,
}: {
  specialty: SpecialtyOverview
  canAdmin: boolean
  canOpenServices: boolean
  onEdit: (chooseWho: boolean) => void
}) {
  const nobody = specialty.professionals.length === 0
  const warns = nobody && specialty.isActive && specialty.serviceCount > 0
  const count =
    specialty.serviceCount > 0 && canOpenServices ? (
      <Link to="/services" search={{ especialidad: specialty.id }} className={LINK}>
        {servicesWord(specialty.serviceCount)}
      </Link>
    ) : (
      <span>{specialty.serviceCount > 0 ? servicesWord(specialty.serviceCount) : "Sin servicios"}</span>
    )
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      {warns ? <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-destructive" /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{specialty.name}</span>
          {specialty.isActive ? null : <Badge variant="secondary">Archivada</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {warns ? (
            <>
              {`Nadie atiende ${specialty.name}: la agenda ofrece a cualquiera para ${
                specialty.serviceCount === 1 ? "su servicio" : `sus ${specialty.serviceCount} servicios`
              }.`}{" "}
              {count}
            </>
          ) : (
            <>
              {nobody ? "Aún nadie la atiende" : `Atiende: ${specialty.professionals.map((item) => item.name).join(", ")}`}
              {" · "}
              {count}
            </>
          )}
        </p>
      </div>
      {canAdmin ? (
        warns ? (
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => onEdit(true)}>
            Elegir quién atiende
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => onEdit(false)}>
            Editar
          </Button>
        )
      ) : null}
    </li>
  )
}

/** El hueco de la pantalla mientras carga: una lista de filas. */
function SpecialtiesSkeleton() {
  return (
    <div className="elevated flex flex-col divide-y rounded-xl border bg-card">
      <p role="status" className="sr-only">
        Cargando las especialidades…
      </p>
      {["w-40", "w-32", "w-44", "w-36"].map((width) => (
        <div key={width} className="flex flex-col gap-2 px-4 py-3" aria-hidden>
          <Skeleton className={`h-4 ${width}`} />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * Nombre, descripción y quién atiende, con un solo «Guardar». La clave interna
 * la genera el servidor. «Elegir quién atiende» abre este mismo formulario con
 * el foco en la lista del equipo.
 */
function SpecialtyForm({
  target,
  onDirtyChange,
  onClose,
  onArchive,
  onSaved,
}: {
  target: FormTarget | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onArchive: (specialty: SpecialtyOverview) => void
  onSaved: () => void
}) {
  const ids = useId()
  const specialty = target?.specialty ?? null
  const members = useOrgMembers()
  const canOpenTeam = useCanOpen("/settings/team")
  const queryClient = useQueryClient()
  const initialWho = (specialty?.professionals ?? []).map((item) => item.userId)
  const [name, setName] = useState(specialty?.name ?? "")
  const [description, setDescription] = useState(specialty?.description ?? "")
  const [who, setWho] = useState<Set<string>>(() => new Set(initialWho))
  const [nameError, setNameError] = useState<string | null>(null)
  const whoRef = useRef<HTMLFieldSetElement>(null)

  useEffect(() => {
    if (target?.chooseWho) whoRef.current?.querySelector<HTMLElement>("button, input")?.focus()
  }, [target?.chooseWho])

  const save = useMutation({
    mutationFn: async (values: { name: string; description: string | null }) => {
      const saved = (specialty ? await updateSpecialty(specialty.id, values) : await createSpecialty(values)).data
      const changedWho = who.size !== initialWho.length || initialWho.some((userId) => !who.has(userId))
      if (changedWho) await saveSpecialtyProfessionals(saved.id, [...who])
      return saved
    },
    onSuccess: (saved) => {
      toast.success(`Especialidad «${saved.name}» guardada`)
      onSaved()
    },
  })

  const reactivate = useMutation({
    mutationFn: () => updateSpecialty(specialty!.id, { isActive: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["specialties"] })
      toast.success(`Especialidad «${specialty?.name ?? ""}» reactivada`)
      onClose()
    },
    onError: (error) => toast.error(errorText(error, "No pudimos reactivar la especialidad. Vuelve a intentarlo.")),
  })

  const isDirty =
    name !== (specialty?.name ?? "") ||
    description !== (specialty?.description ?? "") ||
    who.size !== initialWho.length ||
    initialWho.some((userId) => !who.has(userId))
  useReportDirty(isDirty, onDirtyChange)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={specialty ? `Editar «${specialty.name}»` : "Nueva especialidad"}
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
      <div className="flex flex-col gap-5">
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
        <fieldset ref={whoRef} className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Quién atiende</legend>
          <p className="text-sm text-muted-foreground">
            La agenda ofrece los servicios de esta especialidad solo a quienes marques, si tienen horario en esa sede. Sin
            nadie marcado, los ofrece a cualquiera.
          </p>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aún no hay nadie en el equipo.{" "}
              {canOpenTeam ? (
                <Link to="/settings/team" className={LINK}>
                  Invitar a alguien en Equipo
                </Link>
              ) : null}
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {members.map((member) => {
                const id = `${ids}-atiende-${member.userId}`
                const role = ROLE_LABELS[member.role as keyof typeof ROLE_LABELS]
                return (
                  <li key={member.userId} className="flex min-h-11 items-center gap-3 py-2">
                    <Checkbox
                      id={id}
                      checked={who.has(member.userId)}
                      onCheckedChange={(checked) =>
                        setWho((current) => {
                          const next = new Set(current)
                          if (checked === true) next.add(member.userId)
                          else next.delete(member.userId)
                          return next
                        })
                      }
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{member.user.name}</span>
                      {role ? <span className="text-muted-foreground"> · {role}</span> : null}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </fieldset>
        {specialty ? (
          <div className="flex flex-col gap-2 border-t pt-4">
            {specialty.isActive ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 self-start sm:min-h-8"
                onClick={() => onArchive(specialty)}
              >
                Archivar especialidad
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 self-start sm:min-h-8"
                disabled={reactivate.isPending}
                onClick={() => reactivate.mutate()}
              >
                Reactivar especialidad
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
