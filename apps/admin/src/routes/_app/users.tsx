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
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  EmptyState,
  ErrorState,
  FormDrawer,
  fieldErrorMessages,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ShieldAlert, UserSearch } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"

export const Route = createFileRoute("/_app/users")({
  component: UsersPage,
})

const sessionSchema = z.object({ actor: z.object({ userId: z.string(), role: z.string() }) })

const userItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  blocked: z.boolean(),
  providers: z.array(z.string()),
  organizationCount: z.number(),
})

const userListSchema = z.object({ items: z.array(userItemSchema), total: z.number() })

const userDetailSchema = userItemSchema.extend({
  memberships: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      slug: z.string(),
      role: z.string(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      role: z.string().nullable(),
      status: z.string(),
    }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      ipAddress: z.string().nullable(),
      userAgent: z.string().nullable(),
      updatedAt: z.string(),
      activeOrganizationId: z.string().nullable(),
    }),
  ),
  block: z.object({ reason: z.string(), blockedAt: z.string() }).nullable(),
  recoveryCases: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string() })),
})

type UserDetail = z.infer<typeof userDetailSchema>

const recoverySchema = z.object({
  email: z.string().trim().email("Correo inválido"),
  kind: z.enum(["acceso", "propiedad"]),
  description: z.string().trim().min(10, "Describe la evidencia"),
  verifiedBy: z.string().trim().min(1, "Quién la verificó"),
  verifiedAt: z.string().trim().min(1, "Cuándo se verificó"),
  method: z.string().trim().min(5, "Cómo se verificó (un adjunto solo no basta)"),
  organizationId: z.string(),
})

const STATUS_OPTIONS = [
  { value: "todos", label: "Todos" },
  { value: "activos", label: "Activos" },
  { value: "bloqueados", label: "Bloqueados" },
  { value: "sin_verificar", label: "Sin verificar" },
  { value: "sin_clinica", label: "Sin clínica" },
] as const

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? common.errors.generic
  return error instanceof Error ? error.message : common.errors.generic
}

function UsersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [activeSearch, setActiveSearch] = useState("")
  const [status, setStatus] = useState<string>("todos")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockReason, setBlockReason] = useState("")
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState("")
  const [recoveryOpen, setRecoveryOpen] = useState(false)

  const sessionQuery = useQuery({
    queryKey: ["admin-session"],
    queryFn: async () => sessionSchema.parse(await api<unknown>("/api/admin/access/session")),
  })
  const isAdmin = sessionQuery.data?.actor.role === "admin"

  const listQuery = useQuery({
    queryKey: ["admin-users", activeSearch, status],
    queryFn: async () => {
      const raw = await api<unknown>(
        `/api/admin/organizations/users?q=${encodeURIComponent(activeSearch)}&status=${status}&limit=30`,
      )
      return userListSchema.parse(raw)
    },
  })

  const detailQuery = useQuery({
    queryKey: ["admin-user", selectedId],
    enabled: selectedId !== null,
    queryFn: async () =>
      userDetailSchema.parse(await api<unknown>(`/api/admin/organizations/users/${selectedId}`)),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-users"] })
    void queryClient.invalidateQueries({ queryKey: ["admin-user"] })
  }

  const accessMutation = useMutation({
    mutationFn: (userId: string) =>
      api<unknown>(`/api/admin/organizations/users/${userId}/access-recovery`, { method: "POST" }),
    onSuccess: () => toast.success("Correo de recuperación enviado"),
    onError: (error) => toast.error(messageOf(error)),
  })

  const revokeMutation = useMutation({
    mutationFn: (userId: string) =>
      api<unknown>(`/api/admin/organizations/users/${userId}/sessions/revoke`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast.success("Sesiones revocadas")
      invalidate()
    },
    onError: (error) => toast.error(messageOf(error)),
  })

  const blockMutation = useMutation({
    mutationFn: (args: { userId: string; reason: string }) =>
      api<unknown>(`/api/admin/organizations/users/${args.userId}/block`, {
        method: "POST",
        body: JSON.stringify({ reason: args.reason }),
      }),
    onSuccess: () => {
      toast.success("Cuenta bloqueada y sesiones cortadas")
      setBlockOpen(false)
      setBlockReason("")
      invalidate()
    },
    onError: (error) => toast.error(messageOf(error)),
  })

  const unblockMutation = useMutation({
    mutationFn: (userId: string) =>
      api<unknown>(`/api/admin/organizations/users/${userId}/block`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Bloqueo retirado")
      invalidate()
    },
    onError: (error) => toast.error(messageOf(error)),
  })

  const closeMutation = useMutation({
    mutationFn: (args: { userId: string; reason: string }) =>
      api<unknown>(`/api/admin/organizations/users/${args.userId}/close`, {
        method: "POST",
        body: JSON.stringify({ reason: args.reason }),
      }),
    onSuccess: () => {
      toast.success("Cuenta cerrada (autoría conservada)")
      setCloseOpen(false)
      setCloseReason("")
      invalidate()
    },
    onError: (error) => toast.error(messageOf(error)),
  })

  interface RecoveryFormValues {
    email: string
    kind: "acceso" | "propiedad"
    description: string
    verifiedBy: string
    verifiedAt: string
    method: string
    organizationId: string
  }
  const recoveryDefaults: RecoveryFormValues = {
    email: "",
    kind: "acceso",
    description: "",
    verifiedBy: "",
    verifiedAt: "",
    method: "",
    organizationId: "",
  }
  const recoveryForm = useForm({
    defaultValues: recoveryDefaults,
    validators: { onSubmit: recoverySchema },
    onSubmit: async ({ value }) => {
      try {
        await api<unknown>("/api/admin/organizations/recovery-cases", {
          method: "POST",
          body: JSON.stringify({
            email: value.email,
            kind: value.kind,
            evidence: {
              description: value.description,
              verifiedBy: value.verifiedBy,
              verifiedAt: value.verifiedAt,
              method: value.method,
              ...(value.organizationId ? { organizationId: value.organizationId } : {}),
            },
          }),
        })
        toast.success("Caso de recuperación abierto")
        setRecoveryOpen(false)
        recoveryForm.reset()
        invalidate()
      } catch (error) {
        toast.error(messageOf(error))
      }
    },
  })

  const items = listQuery.data?.items ?? []
  const detail: UserDetail | undefined = detailQuery.data

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Usuarios"
        subtitle="Búsqueda, ayuda de acceso, sesiones, bloqueo global y recuperación con doble control."
        primary={{ label: "Abrir recuperación", icon: <ShieldAlert aria-hidden />, onClick: () => setRecoveryOpen(true) }}
      />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setActiveSearch(search.trim())
        }}
      >
        <Input
          aria-label="Buscar usuarios"
          placeholder="Buscar por correo o nombre"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Select<string> value={status} onValueChange={(next) => setStatus(next ?? "")}>
          <SelectTrigger aria-label="Estado" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      {listQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : listQuery.isError ? (
        <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={UserSearch}
          title="Sin usuarios"
          description="Nadie coincide con este criterio."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={selectedId === item.id}
                  className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm ${
                    selectedId === item.id ? "border-primary" : ""
                  }`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <span className="truncate">{item.email}</span>
                    {item.blocked ? <Badge variant="destructive">Bloqueado</Badge> : null}
                    {!item.emailVerified ? <Badge variant="outline">Sin verificar</Badge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.name} · {item.organizationCount} clínicas ·{" "}
                    {item.providers.join(", ") || "contraseña"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="Ficha del usuario" className="min-w-0">
            {!selectedId ? (
              <EmptyState
                icon={UserSearch}
                title="Elige un usuario"
                description="Selecciona un usuario para ver su ficha y ayudarle."
              />
            ) : detailQuery.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : detailQuery.isError ? (
              <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
            ) : detail ? (
              <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-heading text-base font-medium">{detail.email}</h2>
                  {detail.blocked ? <Badge variant="destructive">Bloqueado</Badge> : null}
                </div>
                {detail.block ? (
                  <p className="text-muted-foreground">Motivo del bloqueo: {detail.block.reason}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={accessMutation.isPending}
                    onClick={() => accessMutation.mutate(detail.id)}
                  >
                    Enviar recuperación de acceso
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(detail.id)}
                  >
                    Revocar sesiones ({detail.sessions.length})
                  </Button>
                  {isAdmin ? (
                    detail.blocked ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={unblockMutation.isPending}
                        onClick={() => unblockMutation.mutate(detail.id)}
                      >
                        Retirar bloqueo
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBlockOpen(true)}
                      >
                        Bloquear globalmente
                      </Button>
                    )
                  ) : null}
                  {isAdmin ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setCloseOpen(true)}
                    >
                      Cerrar cuenta
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  El personal no cambia roles ni quita membresías: solo la transferencia excepcional
                  de propiedad vía recuperación con doble control de admin. La última propietaria
                  siempre se protege.
                </p>
                <div>
                  <h3 className="font-medium">Clínicas</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                    {detail.memberships.map((m) => (
                      <li key={m.organizationId}>
                        {m.organizationName} · {m.role}
                      </li>
                    ))}
                    {detail.memberships.length === 0 ? <li>Sin clínicas.</li> : null}
                  </ul>
                </div>
                <div>
                  <h3 className="font-medium">Sesiones</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                    {detail.sessions.map((s) => (
                      <li key={s.id}>
                        {(s.userAgent ?? "Dispositivo desconocido").slice(0, 60)} ·{" "}
                        {s.ipAddress ?? "IP desconocida"}
                      </li>
                    ))}
                    {detail.sessions.length === 0 ? <li>Sin sesiones activas.</li> : null}
                  </ul>
                </div>
                {detail.recoveryCases.length > 0 ? (
                  <div>
                    <h3 className="font-medium">Casos de recuperación</h3>
                    <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                      {detail.recoveryCases.map((r) => (
                        <li key={r.id}>
                          {r.kind} · {r.status}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  El cambio de rol y la salida de una clínica los hace administración desde la ficha
                  de cada clínica; el último propietario siempre se protege.
                </p>
              </div>
            ) : null}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={blockOpen}
        title="Bloquear cuenta globalmente"
        description="Corta todas las sesiones de inmediato con el motivo indicado. Las membresías y la autoría se conservan. Solo administración."
        confirmLabel="Bloquear"
        variant="destructive"
        pending={blockMutation.isPending}
        confirmDisabled={blockReason.trim().length < 10}
        onConfirm={() => {
          if (selectedId) blockMutation.mutate({ userId: selectedId, reason: blockReason.trim() })
        }}
        onClose={() => setBlockOpen(false)}
      >
        <Field>
          <FieldLabel htmlFor="block-reason">Motivo (mínimo 10 caracteres)</FieldLabel>
          <Input
            id="block-reason"
            value={blockReason}
            onChange={(event) => setBlockReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={closeOpen}
        title="Cerrar cuenta"
        description="Revoca sesiones, retira membresías y bloquea el acceso con el motivo del cierre. La autoría se conserva. Solo administración."
        confirmLabel="Cerrar cuenta"
        variant="destructive"
        pending={closeMutation.isPending}
        confirmDisabled={closeReason.trim().length < 10}
        onConfirm={() => {
          if (selectedId) closeMutation.mutate({ userId: selectedId, reason: closeReason.trim() })
        }}
        onClose={() => setCloseOpen(false)}
      >
        <Field>
          <FieldLabel htmlFor="close-reason">Motivo (mínimo 10 caracteres)</FieldLabel>
          <Input
            id="close-reason"
            value={closeReason}
            onChange={(event) => setCloseReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      <FormDrawer
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        title="Abrir recuperación"
        description="Correo o propiedad con evidencia verificada explícita. Ejecutar exige dos aprobaciones (una de admin)."
        isSubmitting={recoveryForm.state.isSubmitting}
        submitLabel="Abrir caso"
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault()
          void recoveryForm.handleSubmit()
        }}
      >
        <div className="flex flex-col gap-4">
          <recoveryForm.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-email">Correo de la cuenta</FieldLabel>
                <Input
                  id="rec-email"
                  type="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </recoveryForm.Field>
          <recoveryForm.Field name="kind">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-kind">Tipo</FieldLabel>
                <Select<string>
                  value={field.state.value}
                  onValueChange={(next) => {
                    if (next === "propiedad") field.handleChange("propiedad")
                    else field.handleChange("acceso")
                  }}
                >
                  <SelectTrigger id="rec-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="acceso">Recuperar acceso</SelectItem>
                    <SelectItem value="propiedad">Disputa de propiedad</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </recoveryForm.Field>
          <recoveryForm.Field name="description">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-desc">Evidencia presentada</FieldLabel>
                <Input
                  id="rec-desc"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </recoveryForm.Field>
          <recoveryForm.Field name="method">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-method">Cómo se verificó la autoridad</FieldLabel>
                <Input
                  id="rec-method"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </recoveryForm.Field>
          <recoveryForm.Field name="verifiedBy">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-by">Quién la verificó</FieldLabel>
                <Input
                  id="rec-by"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </recoveryForm.Field>
          <recoveryForm.Field name="verifiedAt">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="rec-at">Cuándo se verificó</FieldLabel>
                <Input
                  id="rec-at"
                  placeholder="2026-10-14 10:30"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </recoveryForm.Field>
        </div>
      </FormDrawer>
    </PageShell>
  )
}
