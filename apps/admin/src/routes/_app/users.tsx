import {
  Badge,
  Button,
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
  PageHeader,
  PageShell,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ShieldAlert, UserSearch } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"

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
  email: z.string().trim().email("Correo inválido").max(320, "Escribe como mucho 320 caracteres"),
  kind: z.enum(["acceso", "propiedad"]),
  description: z.string().trim().min(10, "Describe la evidencia").max(2000, "Escribe como mucho 2000 caracteres"),
  verifiedBy: z.string().trim().min(1, "Quién la verificó").max(200, "Escribe como mucho 200 caracteres"),
  verifiedAt: z.string().trim().min(1, "Cuándo se verificó").max(100, "Escribe como mucho 100 caracteres"),
  method: z
    .string()
    .trim()
    .min(5, "Cómo se verificó (un adjunto solo no basta)")
    .max(500, "Escribe como mucho 500 caracteres"),
})

/** El motivo de bloquear o cerrar una cuenta: los mismos límites que la ruta. */
const reasonSchema = z.object({
  reason: z.string().trim().min(10, "Escribe al menos 10 caracteres").max(500, "Escribe como mucho 500 caracteres"),
})

/** Cómo entra cada cuenta, en palabras: Better Auth llama «credential» a la contraseña. */
const PROVIDER_LABEL: Record<string, string> = { credential: "contraseña", google: "Google", microsoft: "Microsoft" }

const STATUS_OPTIONS = [
  { value: "todos", label: "Todos" },
  { value: "activos", label: "Activos" },
  { value: "bloqueados", label: "Bloqueados" },
  { value: "sin_verificar", label: "Sin verificar" },
  { value: "sin_clinica", label: "Sin clínica" },
] as const


function UsersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [activeSearch, setActiveSearch] = useState("")
  const [status, setStatus] = useState<string>("todos")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [blockOpen, setBlockOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
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
    onError: (error) => toast.error(submitErrorMessage(error)),
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
    onError: (error) => toast.error(submitErrorMessage(error)),
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
      invalidate()
    },
  })

  const unblockMutation = useMutation({
    mutationFn: (userId: string) =>
      api<unknown>(`/api/admin/organizations/users/${userId}/block`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Bloqueo retirado")
      invalidate()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
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
      invalidate()
    },
  })

  interface RecoveryFormValues {
    email: string
    kind: "acceso" | "propiedad"
    description: string
    verifiedBy: string
    verifiedAt: string
    method: string
  }
  const recoveryDefaults: RecoveryFormValues = {
    email: "",
    kind: "acceso",
    description: "",
    verifiedBy: "",
    verifiedAt: "",
    method: "",
  }
  const recoveryForm = useAppForm({
    defaultValues: recoveryDefaults,
    validators: { onSubmit: recoverySchema },
    onSubmit: async ({ value, formApi }) => {
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
          },
        }),
      })
      toast.success("Caso de recuperación abierto")
      setRecoveryOpen(false)
      formApi.reset()
      invalidate()
    },
  })
  // La ruta nombra la evidencia como `evidence.description`…; el formulario, sin prefijo.
  const recoverySurface = useFormSurface(recoveryForm, {
    fieldMap: (serverField) => serverField.replace(/^evidence\./, ""),
  })

  const blockForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: reasonSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!selectedId) return
      await blockMutation.mutateAsync({ userId: selectedId, reason: value.reason.trim() })
      formApi.reset()
    },
  })
  const blockError = useFormSubmitError(blockForm)
  const blockPending = useStore(blockForm.store, (state) => state.isSubmitting)

  const closeForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: reasonSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!selectedId) return
      await closeMutation.mutateAsync({ userId: selectedId, reason: value.reason.trim() })
      formApi.reset()
    },
  })
  const closeError = useFormSubmitError(closeForm)
  const closePending = useStore(closeForm.store, (state) => state.isSubmitting)

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
        <Select<string>
          value={status}
          items={Object.fromEntries(STATUS_OPTIONS.map((option) => [option.value, option.label]))}
          onValueChange={(next) => setStatus(next ?? "")}
        >
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
                    {item.name} · {item.organizationCount} {item.organizationCount === 1 ? "clínica" : "clínicas"} ·{" "}
                    {item.providers.map((provider) => PROVIDER_LABEL[provider] ?? provider).join(", ") || "contraseña"}
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
        pending={blockPending}
        error={blockError}
        onConfirm={() => void submitForm(blockForm)}
        onClose={() => {
          blockForm.reset()
          setBlockOpen(false)
        }}
      >
        <blockForm.AppField name="reason">
          {(field) => <field.TextField id="block-reason" label="Motivo (mínimo 10 caracteres)" maxLength={500} />}
        </blockForm.AppField>
      </ConfirmDialog>

      <ConfirmDialog
        open={closeOpen}
        title="Cerrar cuenta"
        description="Revoca sesiones, retira membresías y bloquea el acceso con el motivo del cierre. La autoría se conserva. Solo administración."
        confirmLabel="Cerrar cuenta"
        variant="destructive"
        pending={closePending}
        error={closeError}
        onConfirm={() => void submitForm(closeForm)}
        onClose={() => {
          closeForm.reset()
          setCloseOpen(false)
        }}
      >
        <closeForm.AppField name="reason">
          {(field) => <field.TextField id="close-reason" label="Motivo (mínimo 10 caracteres)" maxLength={500} />}
        </closeForm.AppField>
      </ConfirmDialog>

      <FormDrawer
        {...recoverySurface}
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        title="Abrir recuperación"
        description="Correo o propiedad con evidencia verificada explícita. Ejecutar exige dos aprobaciones (una de admin)."
        submitLabel="Abrir caso"
        cancelLabel={common.actions.cancel}
      >
        <div className="flex flex-col gap-4">
          <recoveryForm.AppField name="email">
            {(field) => <field.TextField id="rec-email" label="Correo de la cuenta" type="email" maxLength={320} />}
          </recoveryForm.AppField>
          <recoveryForm.AppField name="kind">
            {(field) => (
              <field.SelectField
                id="rec-kind"
                label="Tipo"
                options={[
                  { value: "acceso", label: "Recuperar acceso" },
                  { value: "propiedad", label: "Disputa de propiedad" },
                ]}
              />
            )}
          </recoveryForm.AppField>
          <recoveryForm.AppField name="description">
            {(field) => <field.TextField id="rec-desc" label="Evidencia presentada" maxLength={2000} />}
          </recoveryForm.AppField>
          <recoveryForm.AppField name="method">
            {(field) => <field.TextField id="rec-method" label="Cómo se verificó la autoridad" maxLength={500} />}
          </recoveryForm.AppField>
          <recoveryForm.AppField name="verifiedBy">
            {(field) => <field.TextField id="rec-by" label="Quién la verificó" maxLength={200} />}
          </recoveryForm.AppField>
          <recoveryForm.AppField name="verifiedAt">
            {(field) => (
              <field.TextField id="rec-at" label="Cuándo se verificó" placeholder="2026-10-14 10:30" maxLength={100} />
            )}
          </recoveryForm.AppField>
        </div>
      </FormDrawer>
    </PageShell>
  )
}
