import { canAccessAny, canAttend, platformPathPermission } from "@odentia/auth/permissions"
import { Badge, Button, Checkbox, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  FormDrawer,
  PageHeader,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError } from "../../lib/api"
import {
  archiveSpecialty,
  createSpecialty,
  fetchSpecialtiesOverview,
  type Specialty,
  type SpecialtyOverview,
  saveSpecialtyProfessionals,
  updateSpecialty,
} from "../../lib/clinical-forms"
import { useCan, useMyRole, useOrgMembers, usePermission } from "../../lib/crm"
import { settingsPrimary } from "../../lib/screen-rules"
import { appRoleLabel, appWords } from "../../lib/product-words"
import { SpecialtiesPageSkeleton, SpecialtiesSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/specialties")({
  pendingComponent: SpecialtiesPageSkeleton,
  component: SpecialtiesPage,
})

const TITLE = "Especialidades"
const SUBTITLE = "Las especialidades de tu clínica y quién atiende cada una. La agenda ofrece cada servicio a quien atiende su especialidad."
const LINK = "font-semibold text-primary underline-offset-4 hover:underline"

const NAME_CHARS = 120
const DESCRIPTION_CHARS = 2000

/** Los límites de la ruta y la regla de la clave: del nombre deben salir al menos dos letras o números. */
const specialtySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre de la especialidad")
    .max(NAME_CHARS, `El nombre de la especialidad admite hasta ${NAME_CHARS} caracteres`)
    .refine((name) => (name.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2, "El nombre necesita al menos dos letras o números"),
  description: z.string().max(DESCRIPTION_CHARS, `La descripción admite hasta ${DESCRIPTION_CHARS} caracteres`),
  who: z.array(z.string()).max(100, "Marca como mucho 100 personas"),
})

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
  const can = useCan()
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
        primary={settingsPrimary("specialties", can, () => openForm(null))}
      />

      {listQuery.isPending ? (
        <SkeletonRegion message="Cargando las especialidades…">
          <SpecialtiesSkeleton />
        </SkeletonRegion>
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
            {submitErrorMessage(archiveMutation.error)}
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
  const specialty = target?.specialty ?? null
  // Solo quien puede atender se adscribe a una especialidad (ADR 0125).
  const members = useOrgMembers().filter((member) => canAttend(member.role))
  const canOpenTeam = useCanOpen("/settings/team")
  const queryClient = useQueryClient()
  const initialWho = (specialty?.professionals ?? []).map((item) => item.userId)
  const whoRef = useRef<HTMLDivElement>(null)
  // La especialidad nueva ya creada: si falla «Quién atiende», el reintento no la vuelve a crear.
  const created = useRef<Specialty | null>(null)

  useEffect(() => {
    if (target?.chooseWho) whoRef.current?.querySelector<HTMLElement>("button, input")?.focus()
  }, [target?.chooseWho])

  const form = useAppForm({
    defaultValues: {
      name: specialty?.name ?? "",
      description: specialty?.description ?? "",
      who: initialWho,
    },
    validators: { onSubmit: specialtySchema },
    onSubmit: async ({ value }) => {
      const values = { name: value.name.trim(), description: value.description.trim() || null }
      const existing = specialty ?? created.current
      let saved: Specialty
      if (existing) {
        const last = created.current
        const unchanged = last !== null && values.name === last.name && values.description === last.description
        saved = unchanged ? last : (await updateSpecialty(existing.id, values)).data
        if (created.current) created.current = saved
      } else {
        saved = (await createSpecialty(values)).data
        created.current = saved
        void queryClient.invalidateQueries({ queryKey: ["specialties"] })
      }
      const changedWho = value.who.length !== initialWho.length || initialWho.some((userId) => !value.who.includes(userId))
      if (changedWho) {
        try {
          await saveSpecialtyProfessionals(saved.id, value.who)
        } catch (error) {
          // El primer paso ya quedó guardado: lo que falló es «Quién atiende», y se dice ahí.
          const message = submitErrorMessage(error)
          throw new ApiError(400, { code: "PROFESSIONALS", message, fields: { who: message } })
        }
      }
      toast.success(`Especialidad «${saved.name}» guardada`)
      onSaved()
    },
  })
  const surface = useFormSurface(form)
  useReportDirty(surface.isDirty, onDirtyChange)

  const reactivate = useMutation({
    mutationFn: () => updateSpecialty(specialty!.id, { isActive: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["specialties"] })
      toast.success(`Especialidad «${specialty?.name ?? ""}» reactivada`)
      onClose()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={specialty ? `Editar «${specialty.name}»` : "Nueva especialidad"}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField label="Nombre" placeholder={appWords().examples.specialty} maxLength={NAME_CHARS} />
          )}
        </form.AppField>
        <form.AppField name="description">
          {(field) => <field.TextareaField label="Descripción (opcional)" rows={3} maxLength={DESCRIPTION_CHARS} />}
        </form.AppField>
        <div ref={whoRef}>
          <form.AppField name="who">
            {(field) => (
              <field.Group
                legend="Quién atiende"
                description="La agenda ofrece los servicios de esta especialidad solo a quienes marques, si tienen horario en esa sede. Sin nadie marcado, los ofrece a cualquiera."
              >
                {(control) =>
                  members.length === 0 ? (
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
                        const id = `${control.id}-${member.userId}`
                        const role = appRoleLabel(member.role, "")
                        return (
                          <li key={member.userId} className="flex min-h-11 items-center gap-3 py-2">
                            <Checkbox
                              id={id}
                              checked={field.state.value.includes(member.userId)}
                              aria-invalid={control.invalid || undefined}
                              aria-describedby={control.describedBy}
                              onBlur={control.onBlur}
                              onCheckedChange={(checked) =>
                                field.handleChange((current) =>
                                  checked === true
                                    ? [...current.filter((userId) => userId !== member.userId), member.userId]
                                    : current.filter((userId) => userId !== member.userId),
                                )
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
                  )
                }
              </field.Group>
            )}
          </form.AppField>
        </div>
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
