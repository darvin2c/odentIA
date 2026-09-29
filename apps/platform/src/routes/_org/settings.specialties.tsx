import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  PageHeader,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  archiveSpecialty,
  createSpecialty,
  fetchProfessionalSpecialties,
  fetchServiceSpecialties,
  fetchSpecialties,
  fetchSpecialtyProfessionals,
  saveProfessionalSpecialties,
  saveServiceSpecialties,
  updateSpecialty,
  type Specialty,
} from "../../lib/clinical-forms"
import { fetchServices } from "../../lib/services"
import { useOrgMembers, usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/specialties")({
  component: SpecialtiesPage,
})

/**
 * Especialidades de la organización: CRUD propio (sin catálogo fijo) y
 * asignación de profesionales y prestaciones del tarifario. Crear una
 * especialidad aquí la deja disponible en formularios, consentimientos,
 * órdenes y captura clínica sin despliegue ni ficha paralela.
 */
function SpecialtiesPage() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("settings.write")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Specialty | null>(null)
  const [archiving, setArchiving] = useState<Specialty | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<() => void>(() => {})

  const listQuery = useQuery({
    queryKey: ["specialties"],
    queryFn: () => fetchSpecialties(),
  })
  const specialties = listQuery.data?.data ?? []
  const selected = specialties.find((s) => s.id === selectedId) ?? specialties[0] ?? null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["specialties"] })
  }
  const fail = (e: unknown) =>
    setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")

  const saveMutation = useMutation({
    mutationFn: (values: { key?: string; name: string; description?: string | null; isActive?: boolean }) =>
      editing
        ? updateSpecialty(editing.id, values).then((r) => r.data)
        : createSpecialty(values).then((r) => r.data),
    onSuccess: (row) => {
      setDrawerOpen(false)
      setEditing(null)
      setError(null)
      setSelectedId(row.id)
      invalidate()
      toast.success(editing ? "Especialidad actualizada" : "Especialidad creada")
    },
    onError: fail,
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveSpecialty(id),
    onSuccess: () => {
      setArchiving(null)
      invalidate()
      toast.success("Especialidad archivada")
    },
    onError: fail,
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Especialidades"
        subtitle="Cada organización define las suyas: formularios, consentimientos, órdenes y profesionales cuelgan de aquí."
        actions={
          canAdmin ? (
            <Button
              type="button"
              onClick={() => {
                setEditing(null)
                setDrawerOpen(true)
              }}
            >
              Nueva especialidad
            </Button>
          ) : undefined
        }
      />
      {error ? <ErrorState message={error} onRetry={() => setError(null)} /> : null}
      {listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : listQuery.isError ? (
        <ErrorState
          message="No se pudieron cargar las especialidades"
          onRetry={() => void listQuery.refetch()}
        />
      ) : specialties.length === 0 ? (
        <EmptyState
          title="Sin especialidades"
          description="Crea la primera (p. ej. Endodoncia) para habilitar formularios y órdenes por especialidad."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <ul className="flex flex-col gap-2">
            {specialties.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                    selected?.id === item.id ? "border-primary bg-accent" : ""
                  }`}
                >
                  <span className="font-medium">{item.name}</span>
                  <Badge variant={item.isActive ? "default" : "secondary"}>
                    {item.isActive ? "Activa" : "Inactiva"}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <SpecialtyDetail
              specialty={selected}
              canAdmin={canAdmin}
              onEdit={() => {
                setEditing(selected)
                setDrawerOpen(true)
              }}
              onArchive={() => setArchiving(selected)}
            />
          ) : null}
        </div>
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? "Editar especialidad" : "Nueva especialidad"}
        onSubmit={() => submitRef.current()}
        isSubmitting={saveMutation.isPending}
        submitLabel={editing ? "Guardar cambios" : "Crear especialidad"}
      >
        <SpecialtyForm
          key={editing?.id ?? "nueva"}
          initial={editing}
          registerSubmit={(fn) => {
            submitRef.current = fn
          }}
          onSubmit={(values) => saveMutation.mutate(values)}
        />
      </FormDrawer>
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title="Archivar especialidad"
        description={`«${archiving?.name}» dejará de estar disponible para plantillas nuevas. El historial se conserva.`}
        confirmLabel="Archivar"
        variant="default"
        pending={archiveMutation.isPending}
        onConfirm={() => {
          if (archiving) archiveMutation.mutate(archiving.id)
        }}
      />
    </div>
  )
}

function SpecialtyForm({
  initial,
  registerSubmit,
  onSubmit,
}: {
  initial: Specialty | null
  registerSubmit: (fn: () => void) => void
  onSubmit: (values: { key?: string; name: string; description?: string | null }) => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [key, setKey] = useState(initial?.key ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [errors, setErrors] = useState<{ name?: string; key?: string }>({})

  useEffect(() => {
    registerSubmit(() => {
      const next: { name?: string; key?: string } = {}
      if (!name.trim()) next.name = "Ingresa el nombre"
      if (key.trim() && !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(key.trim().toLowerCase())) {
        next.key = "Clave de 2–40 caracteres (letras, números y guiones)"
      }
      setErrors(next)
      if (next.name || next.key) return
      onSubmit({
        name: name.trim(),
        ...(key.trim() ? { key: key.trim().toLowerCase() } : {}),
        description: description.trim() ? description.trim() : null,
      })
    })
  })

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="specialty-name">Nombre</FieldLabel>
        <Input
          id="specialty-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Endodoncia"
          maxLength={120}
        />
        {errors.name ? <FieldError>{errors.name}</FieldError> : null}
      </Field>
      {!initial ? (
        <Field>
          <FieldLabel htmlFor="specialty-key">Clave (opcional, se genera del nombre)</FieldLabel>
          <Input
            id="specialty-key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="endodoncia"
            maxLength={40}
          />
          {errors.key ? <FieldError>{errors.key}</FieldError> : null}
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="specialty-description">Descripción</FieldLabel>
        <Textarea
          id="specialty-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          maxLength={2000}
        />
      </Field>
    </div>
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{specialty.name}</h2>
          <p className="text-sm text-muted-foreground">
            Clave «{specialty.key}» · {specialty.description || "Sin descripción"}
          </p>
        </div>
        {canAdmin ? (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              Editar
            </Button>
            {specialty.isActive ? (
              <Button type="button" variant="outline" size="sm" onClick={onArchive}>
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
      toast.success("Especialidad reactivada")
    },
  })
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      Reactivar
    </Button>
  )
}

function ProfessionalAssignment({ specialty, canAdmin }: { specialty: Specialty; canAdmin: boolean }) {
  const members = useOrgMembers()
  const queryClient = useQueryClient()
  const assignedQuery = useQuery({
    queryKey: ["specialty-professionals", specialty.id],
    queryFn: () => fetchSpecialtyProfessionals(specialty.id),
  })
  const assigned = new Set((assignedQuery.data?.data ?? []).map((r) => r.userId))
  const mutation = useMutation({
    mutationFn: (userId: string) =>
      fetchProfessionalSpecialties(userId).then(async (current) => {
        const ids = new Set(current.data.map((s) => s.id))
        if (assigned.has(userId)) {
          // Este profesional ya figura: se quita esta especialidad de las suyas.
          ids.delete(specialty.id)
        } else {
          ids.add(specialty.id)
        }
        return saveProfessionalSpecialties(userId, [...ids])
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["specialty-professionals", specialty.id] })
    },
  })

  return (
    <section className="rounded-md border p-4">
      <h3 className="text-sm font-semibold">Profesionales</h3>
      <p className="text-sm text-muted-foreground">
        Quiénes atienden esta especialidad (miembros de la organización).
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={assigned.has(member.userId)}
              disabled={!canAdmin || mutation.isPending}
              onCheckedChange={() => mutation.mutate(member.userId)}
              aria-label={`Asignar a ${member.user.name}`}
            />
            <span>
              {member.user.name} <span className="text-muted-foreground">· {member.role}</span>
            </span>
          </li>
        ))}
        {members.length === 0 ? (
          <li className="text-sm text-muted-foreground">Sin miembros para asignar.</li>
        ) : null}
      </ul>
    </section>
  )
}

function ServiceAssignment({ specialty, canAdmin }: { specialty: Specialty; canAdmin: boolean }) {
  const [serviceId, setServiceId] = useState<string>("")
  const queryClient = useQueryClient()
  const servicesQuery = useQuery({
    queryKey: ["services-all"],
    queryFn: () => fetchServices({ limit: 100 }),
  })
  const services = servicesQuery.data?.data ?? []
  const linkedQuery = useQuery({
    queryKey: ["service-specialties", serviceId],
    queryFn: () => fetchServiceSpecialties(serviceId),
    enabled: serviceId !== "",
  })
  const linked = new Set((linkedQuery.data?.data ?? []).map((s) => s.id))
  const mutation = useMutation({
    mutationFn: () => {
      const ids = new Set(linked)
      if (ids.has(specialty.id)) ids.delete(specialty.id)
      else ids.add(specialty.id)
      return saveServiceSpecialties(serviceId, [...ids])
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["service-specialties", serviceId] })
      toast.success("Prestación actualizada")
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  return (
    <section className="rounded-md border p-4">
      <h3 className="text-sm font-semibold">Prestaciones del tarifario</h3>
      <p className="text-sm text-muted-foreground">
        Vincula prestaciones a esta especialidad (la especialidad de biblioteca sigue intacta).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select value={serviceId} onValueChange={(v: string | null) => setServiceId(v ?? "")}>
          <SelectTrigger className="w-64" aria-label="Prestación">
            <SelectValue placeholder="Elige una prestación" />
          </SelectTrigger>
          <SelectContent>
            {services.map((service) => (
              <SelectItem key={service.id} value={service.id}>
                {service.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAdmin || !serviceId || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {linked.has(specialty.id) ? "Desvincular" : "Vincular"}
        </Button>
      </div>
      {serviceId && linkedQuery.data ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {linked.has(specialty.id) ? "Vinculada a esta especialidad." : "No vinculada a esta especialidad."}
        </p>
      ) : null}
    </section>
  )
}
