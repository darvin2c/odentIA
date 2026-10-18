import {
  Button,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"

export const Route = createFileRoute("/_app/support")({
  // `?caso=<id>`: el enlace del aviso por correo abre ese caso.
  validateSearch: (search: Record<string, unknown>): { caso?: string } =>
    typeof search.caso === "string" && search.caso ? { caso: search.caso } : {},
  component: SupportPage,
})

const supportStatus = z.enum(["abierto", "en_atencion", "esperando_clinica", "resuelto"])
type SupportStatus = z.infer<typeof supportStatus>

const STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

const STATUSES: SupportStatus[] = ["abierto", "en_atencion", "esperando_clinica", "resuelto"]

const caseItem = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  kind: z.enum(["pregunta", "problema", "acceso"]),
  question: z.string(),
  status: supportStatus,
  assigneeStaffId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const caseMessage = z.object({
  id: z.string(),
  authorKind: z.enum(["cliente", "staff", "sistema"]),
  body: z.string(),
  isInternal: z.boolean(),
  createdAt: z.string(),
})

const caseDetail = caseItem.extend({
  detail: z.string().nullable(),
  screen: z.string(),
  role: z.string(),
  appVersion: z.string().nullable(),
  reopenedCount: z.number(),
  messages: z.array(caseMessage),
  attachments: z.array(
    z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number() }),
  ),
  grants: z.array(
    z.object({
      id: z.string(),
      expiresAt: z.string(),
      revokedAt: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
})

const diagnosticPayload = z.object({
  caseId: z.string(),
  organizationName: z.string(),
  scope: z.string(),
  grantExpiresAt: z.string(),
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  profile: z
    .object({
      countryCode: z.string(),
      currency: z.string(),
      timezone: z.string(),
      locale: z.string(),
    })
    .nullable(),
  branches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isActive: z.boolean(),
      timezone: z.string().nullable(),
      appointmentDefaultMinutes: z.number(),
    }),
  ),
  agent: z
    .object({
      enabled: z.boolean(),

      decisionProvider: z.string(),
      decisionRoutingEnabled: z.boolean(),
      clinicalAssistantEnabled: z.boolean(),
      dailyRunLimit: z.number(),
      activeFromMin: z.number().nullable(),
      activeUntilMin: z.number().nullable(),
      channels: z.array(z.string()).nullable(),
    })
    .nullable(),
  channels: z.array(
    z.object({
      channel: z.string(),
      provider: z.string(),
      displayName: z.string(),
      status: z.string(),
    }),
  ),
  services: z.object({ total: z.number() }),
  membersByRole: z.array(z.object({ role: z.string(), total: z.number() })),
})

const knowledgeGroup = z.object({
  dedupeKey: z.string(),
  question: z.string(),
  kind: z.string(),
  openCases: z.number(),
  organizations: z.number(),
  screens: z.array(z.string()),
})

const metricsPayload = z.object({
  byStatus: z.array(z.object({ status: supportStatus, total: z.number() })),
  byKind: z.array(z.object({ kind: z.string(), total: z.number() })),
  openWithoutAssignee: z.number(),
  activeGrants: z.number(),
  avgFirstReplyMinutes: z.number().nullable(),
})

const casesPayload = z.object({ items: z.array(caseItem), total: z.number() })
const sessionPayload = z.object({ actor: z.object({ userId: z.string(), role: z.string() }) })
const assigneePayload = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.enum(["admin", "support"]),
})

function SupportPage() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string>("")
  const [page, setPage] = useState(0)
  const linkedCase = Route.useSearch().caso ?? null
  const [selectedId, setSelectedId] = useState<string | null>(linkedCase)
  const [checked, setChecked] = useState<string[]>([])
  const [tab, setTab] = useState<"cola" | "conocimiento" | "metricas">("cola")
  // Borradores por caso: cambiar de ficha conserva cada texto y nunca envía
  // el borrador de un caso en otro. Solo se limpian al enviarse con éxito.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [manyBody, setManyBody] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const PAGE_SIZE = 20
  const listQuery =
    `/api/admin/support/cases?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}` +
    (status === "" ? "" : `&status=${status}`)
  const cases = useQuery({
    queryKey: ["admin-support-cases", status, page],
    queryFn: () => api(listQuery).then((body: unknown) => casesPayload.parse(body)),
  })
  const detail = useQuery({
    queryKey: ["admin-support-case", selectedId],
    queryFn: () =>
      api(`/api/admin/support/cases/${selectedId}`).then((body: unknown) => caseDetail.parse(body)),
    enabled: selectedId !== null,
  })
  const diagnostic = useQuery({
    queryKey: ["admin-support-diagnostic", selectedId],
    queryFn: () =>
      api(`/api/admin/support/cases/${selectedId}/diagnostic`).then((body: unknown) =>
        diagnosticPayload.parse(body),
      ),
    enabled: false,
    retry: false,
  })
  const knowledge = useQuery({
    queryKey: ["admin-support-knowledge"],
    queryFn: () =>
      api("/api/admin/support/knowledge").then((body: unknown) =>
        z.array(knowledgeGroup).parse(body),
      ),
    enabled: tab === "conocimiento",
  })
  const metrics = useQuery({
    queryKey: ["admin-support-metrics"],
    queryFn: () =>
      api("/api/admin/support/metrics").then((body: unknown) => metricsPayload.parse(body)),
    enabled: tab === "metricas",
  })
  const session = useQuery({
    queryKey: ["admin-session"],
    queryFn: () =>
      api("/api/admin/access/session").then((body: unknown) => sessionPayload.parse(body)),
    retry: false,
  })
  const assignees = useQuery({
    queryKey: ["admin-support-assignees"],
    queryFn: () =>
      api("/api/admin/support/assignees").then((body: unknown) =>
        z.array(assigneePayload).parse(body),
      ),
    staleTime: 300_000,
    retry: false,
  })

  // Invalida por prefijo: si cambia la ficha a mitad de una mutación, la
  // respuesta igual refresca la lista y el detalle que corresponda.
  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["admin-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["admin-support-case"] })
  }

  const sendReply = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      api(`/api/admin/support/cases/${input.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: input.body }),
      }),
    onSuccess: (_data, input) => {
      setReplyDrafts((current) => ({ ...current, [input.id]: "" }))
      invalidate()
    },
  })
  const sendNote = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      api(`/api/admin/support/cases/${input.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: input.body }),
      }),
    onSuccess: (_data, input) => {
      setNoteDrafts((current) => ({ ...current, [input.id]: "" }))
      invalidate()
    },
  })
  const assign = useMutation({
    mutationFn: (staffUserId: string | null) =>
      api(`/api/admin/support/cases/${selectedId}/assign`, {
        method: "POST",
        body: JSON.stringify({ staffUserId }),
      }),
    onSuccess: invalidate,
  })
  const setCaseStatus = useMutation({
    mutationFn: (next: SupportStatus) =>
      api(`/api/admin/support/cases/${selectedId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next }),
      }),
    onSuccess: invalidate,
  })
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append("file", file)
      return api(`/api/admin/support/cases/${selectedId}/attachments`, {
        method: "POST",
        body: form,
      })
    },
    onSuccess: invalidate,
  })
  const sendMany = useMutation({
    mutationFn: (confirmOrganizationIds: (string | null)[]) =>
      api(`/api/admin/support/messages/many`, {
        method: "POST",
        body: JSON.stringify({ caseIds: checked, body: manyBody.trim(), confirmOrganizationIds }),
      }),
    onSuccess: () => {
      setManyBody("")
      setChecked([])
      invalidate()
    },
  })
  const revokeGrant = useMutation({
    mutationFn: (grantId: string) =>
      api(`/api/admin/support/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId }),
      }),
    onSuccess: invalidate,
  })

  const items = cases.data?.items ?? []
  const total = cases.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const kase = detail.data ?? null
  const checkedCases = items.filter((item) => checked.includes(item.id))
  const recipientOrgs = checkedCases.map((item) => item.organizationId)
  const myUserId = session.data?.actor.userId ?? null
  const isAdmin = session.data?.actor.role === "admin"
  const assigneeName = (userId: string | null): string | null =>
    userId === null
      ? null
      : ((assignees.data ?? []).find((item) => item.userId === userId)?.name ?? null)

  function toggleCheck(id: string) {
    setChecked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  return (
    <PageShell className="flex flex-col gap-4">
      <PageHeader
        title="Soporte"
        subtitle="Casos de las clínicas: conversación, responsable y acceso diagnóstico con permiso."
      />

      <div role="group" aria-label="Vistas de soporte" className="flex flex-wrap gap-2">
        {(["cola", "conocimiento", "metricas"] as const).map((view) => (
          <Button
            key={view}
            type="button"
            aria-pressed={tab === view}
            variant={tab === view ? "default" : "outline"}
            className="min-h-11 sm:min-h-9"
            onClick={() => setTab(view)}
          >
            {view === "cola" ? "Cola" : view === "conocimiento" ? "Conocimiento" : "Métricas"}
          </Button>
        ))}
      </div>

      {tab === "metricas" ? (
        <section aria-label="Métricas de soporte" className="flex flex-col gap-2">
          {metrics.isPending ? (
            <LoadingState message="Cargando métricas…" />
          ) : metrics.isError ? (
            <ErrorState
              message="No pude cargar las métricas."
              onRetry={() => void metrics.refetch()}
            />
          ) : (
            <dl className="grid gap-2 sm:grid-cols-2">
              {(metrics.data?.byStatus ?? []).map((row) => (
                <div key={row.status} className="rounded-xl border px-3 py-2.5">
                  <dt className="text-sm text-muted-foreground">{STATUS_LABEL[row.status]}</dt>
                  <dd className="text-xl font-bold">{row.total}</dd>
                </div>
              ))}
              <div className="rounded-xl border px-3 py-2.5">
                <dt className="text-sm text-muted-foreground">Abiertos sin responsable</dt>
                <dd className="text-xl font-bold">{metrics.data?.openWithoutAssignee ?? 0}</dd>
              </div>
              <div className="rounded-xl border px-3 py-2.5">
                <dt className="text-sm text-muted-foreground">Accesos diagnóstico vigentes</dt>
                <dd className="text-xl font-bold">{metrics.data?.activeGrants ?? 0}</dd>
              </div>
              <div className="rounded-xl border px-3 py-2.5">
                <dt className="text-sm text-muted-foreground">Primera respuesta (promedio, min)</dt>
                <dd className="text-xl font-bold">
                  {metrics.data?.avgFirstReplyMinutes === null ||
                  metrics.data?.avgFirstReplyMinutes === undefined
                    ? "—"
                    : Math.round(metrics.data.avgFirstReplyMinutes)}
                </dd>
              </div>
            </dl>
          )}
        </section>
      ) : null}

      {tab === "conocimiento" ? (
        <section aria-label="Agrupación para conocimiento" className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Preguntas iguales entre clínicas, solo agregado: sirve para preparar respuestas comunes
            sin mezclar datos de organizaciones.
          </p>
          {knowledge.isPending ? (
            <LoadingState message="Cargando agrupación…" />
          ) : knowledge.isError ? (
            <ErrorState
              message="No pude cargar la agrupación."
              onRetry={() => void knowledge.refetch()}
            />
          ) : (knowledge.data ?? []).length === 0 ? (
            <EmptyState
              title="Sin grupos abiertos"
              description="No hay casos sin resolver para agrupar."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {(knowledge.data ?? []).map((group) => (
                <li key={group.dedupeKey} className="rounded-xl border px-3 py-2.5 text-sm">
                  <p className="font-semibold">«{group.question}»</p>
                  <p className="text-muted-foreground">
                    {group.openCases} {group.openCases === 1 ? "caso" : "casos"} ·{" "}
                    {group.organizations} {group.organizations === 1 ? "clínica" : "clínicas"} ·{" "}
                    {group.screens.join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === "cola" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel htmlFor="soporte-estado">Estado</FieldLabel>
            <Select
              value={status === "" ? "__all__" : status}
              items={{
                __all__: "Todos",
                ...Object.fromEntries(STATUSES.map((value) => [value, STATUS_LABEL[value]])),
              }}
              onValueChange={(value) => {
                setStatus(!value || value === "__all__" ? "" : value)
                setPage(0)
              }}
            >
              <SelectTrigger id="soporte-estado" className="w-56">
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {STATUS_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {cases.isPending ? (
            <LoadingState message="Cargando casos…" />
          ) : cases.isError ? (
            <ErrorState message="No pude cargar los casos." onRetry={() => void cases.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title="Sin casos" description="No hay casos con este filtro." />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-2 rounded-xl border px-3 py-2.5"
                  >
                    {isAdmin ? (
                      <input
                        type="checkbox"
                        aria-label={`Elegir caso: ${item.question}`}
                        checked={checked.includes(item.id)}
                        onChange={() => toggleCheck(item.id)}
                        className="mt-1.5 size-5"
                      />
                    ) : null}
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setSelectedId(item.id)}
                      aria-expanded={selectedId === item.id}
                    >
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                          {STATUS_LABEL[item.status]}
                        </span>
                        <span className="font-semibold">
                          {item.organizationName ?? "Sin clínica (acceso)"}
                        </span>
                      </span>
                      <span className="block truncate text-sm">«{item.question}»</span>
                    </button>
                  </li>
                ))}
              </ul>
              {pages > 1 ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={page === 0 || cases.isPending}
                    onClick={() => setPage(page - 1)}
                  >
                    ← Anteriores
                  </Button>
                  <span aria-live="polite" className="text-muted-foreground">
                    Página {page + 1} de {pages} · {total} {total === 1 ? "caso" : "casos"}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={page + 1 >= pages || cases.isPending}
                    onClick={() => setPage(page + 1)}
                  >
                    Siguientes →
                  </Button>
                </div>
              ) : null}
            </>
          )}

          {isAdmin && checkedCases.length > 1 ? (
            <section
              aria-label="Responder a varios casos"
              className="flex flex-col gap-2 rounded-xl border px-3 py-2.5"
            >
              <h3 className="text-sm font-bold">
                Responder a {checkedCases.length} casos con el mismo texto
              </h3>
              <p className="text-sm text-muted-foreground">
                Destinatarias:{" "}
                {checkedCases.map((item) => item.organizationName ?? "sin clínica").join(" · ")}.
                Cada caso recibe su propio mensaje privado.
              </p>
              <label className="flex flex-col gap-1 text-sm" htmlFor="soporte-varios">
                Respuesta común
                <textarea
                  id="soporte-varios"
                  rows={3}
                  maxLength={4000}
                  className="min-h-11 rounded-md border bg-card px-2 py-1.5"
                  value={manyBody}
                  onChange={(event) => setManyBody(event.target.value)}
                />
              </label>
              <Button
                type="button"
                className="min-h-11 self-start sm:min-h-9"
                disabled={manyBody.trim().length === 0 || sendMany.isPending}
                onClick={() => sendMany.mutate(recipientOrgs)}
              >
                Confirmar y enviar a estas organizaciones
              </Button>
              {sendMany.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {sendMany.error instanceof Error ? sendMany.error.message : "No se pudo enviar."}
                </p>
              ) : null}
            </section>
          ) : null}

          {kase ? (
            <section
              aria-label="Ficha del caso"
              className="flex flex-col gap-3 rounded-xl border px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={() => setSelectedId(null)}
                >
                  ← Cerrar ficha
                </Button>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                  {STATUS_LABEL[kase.status]}
                </span>
                <span className="text-sm font-semibold">
                  {kase.organizationName ?? "Sin clínica (acceso)"}
                </span>
              </div>
              <p className="text-sm font-semibold">«{kase.question}»</p>
              <p className="text-sm text-muted-foreground">
                Pantalla: {kase.screen} · Rol: {kase.role || "—"} · Versión:{" "}
                {kase.appVersion ?? "—"} · Reaperturas: {kase.reopenedCount} · Responsable:{" "}
                {assigneeName(kase.assigneeStaffId) ?? "sin asignar"}
              </p>

              <ol className="flex flex-col gap-2">
                {kase.messages.map((message) => (
                  <li
                    key={message.id}
                    className={
                      message.isInternal
                        ? "rounded-xl border border-dashed border-warning/50 bg-warning-soft px-3 py-2 text-sm"
                        : message.authorKind === "staff"
                          ? "rounded-xl bg-primary-soft px-3 py-2 text-sm"
                          : "rounded-xl border px-3 py-2 text-sm"
                    }
                  >
                    <p className="text-xs font-bold text-muted-foreground">
                      {message.isInternal
                        ? "Nota interna (solo equipo)"
                        : message.authorKind === "staff"
                          ? "Staff → clínica"
                          : "Clínica"}
                    </p>
                    <p className="whitespace-pre-wrap">{message.body}</p>
                  </li>
                ))}
              </ol>

              {kase.attachments.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm" aria-label="Adjuntos">
                  {kase.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="font-semibold text-primary underline underline-offset-4"
                        href={`${API_URL}/api/admin/support/cases/${kase.id}/attachments/${attachment.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {attachment.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  aria-label="Adjuntar archivo al caso"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) upload.mutate(file)
                    event.target.value = ""
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={upload.isPending}
                  aria-busy={upload.isPending}
                  onClick={() => fileRef.current?.click()}
                >
                  {upload.isPending ? "Subiendo…" : "Adjuntar (JPG, PNG, WebP o PDF, máx. 10 MB)"}
                </Button>
              </div>
              {upload.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {upload.error instanceof Error
                    ? upload.error.message
                    : "No se pudo subir el archivo."}
                </p>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <label
                  className="flex flex-col gap-1 text-sm font-semibold"
                  htmlFor="soporte-responder"
                >
                  Responder a la clínica
                  <textarea
                    id="soporte-responder"
                    rows={3}
                    maxLength={4000}
                    className="min-h-11 rounded-md border bg-card px-2 py-1.5 font-normal"
                    value={replyDrafts[kase.id] ?? ""}
                    onChange={(event) =>
                      setReplyDrafts((current) => ({ ...current, [kase.id]: event.target.value }))
                    }
                  />
                </label>
                <Button
                  type="button"
                  className="min-h-11 self-start sm:min-h-9"
                  disabled={(replyDrafts[kase.id] ?? "").trim().length === 0 || sendReply.isPending}
                  onClick={() =>
                    sendReply.mutate({ id: kase.id, body: (replyDrafts[kase.id] ?? "").trim() })
                  }
                >
                  Enviar respuesta
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex flex-col gap-1 text-sm font-semibold" htmlFor="soporte-nota">
                  Nota interna (la clínica no la ve)
                  <textarea
                    id="soporte-nota"
                    rows={2}
                    maxLength={4000}
                    className="min-h-11 rounded-md border bg-card px-2 py-1.5 font-normal"
                    value={noteDrafts[kase.id] ?? ""}
                    onChange={(event) =>
                      setNoteDrafts((current) => ({ ...current, [kase.id]: event.target.value }))
                    }
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start sm:min-h-9"
                  disabled={(noteDrafts[kase.id] ?? "").trim().length === 0 || sendNote.isPending}
                  onClick={() =>
                    sendNote.mutate({ id: kase.id, body: (noteDrafts[kase.id] ?? "").trim() })
                  }
                >
                  Guardar nota
                </Button>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <FieldLabel htmlFor="soporte-responsable">Responsable</FieldLabel>
                <Select
                  value={kase.assigneeStaffId ?? "__none__"}
                  items={{ __none__: "Sin asignar", ...Object.fromEntries(
                    (assignees.data ?? []).map((item) => [item.userId, item.name]),
                  ) }}
                  onValueChange={(value) =>
                    assign.mutate(!value || value === "__none__" ? null : value)
                  }
                  disabled={assign.isPending}
                >
                  <SelectTrigger id="soporte-responsable" className="w-56">
                    <SelectValue placeholder="Sin asignar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin asignar</SelectItem>
                    {(assignees.data ?? []).map((item) => (
                      <SelectItem key={item.userId} value={item.userId}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {myUserId ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={assign.isPending}
                    onClick={() => assign.mutate(myUserId)}
                  >
                    Asignarme
                  </Button>
                ) : null}
                {STATUSES.filter((value) => value !== kase.status).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={setCaseStatus.isPending}
                    onClick={() => setCaseStatus.mutate(value)}
                  >
                    {value === "resuelto" ? "Resolver" : `A ${STATUS_LABEL[value].toLowerCase()}`}
                  </Button>
                ))}
              </div>

              <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
                <p className="font-bold">Acceso diagnóstico</p>
                {(kase.grants ?? []).length === 0 ? (
                  <p className="text-muted-foreground">
                    Sin permisos: pide a un owner/admin de la clínica que lo autorice.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {kase.grants.map((grant) => (
                      <li key={grant.id} className="flex flex-wrap items-center gap-2">
                        <span>
                          Vence el {new Date(grant.expiresAt).toLocaleString()} ·{" "}
                          {grant.active ? "vigente" : grant.revokedAt ? "revocado" : "vencido"}
                        </span>
                        {grant.active ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-9"
                            disabled={revokeGrant.isPending}
                            onClick={() => revokeGrant.mutate(grant.id)}
                          >
                            Revocar
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={diagnostic.isFetching}
                    onClick={() => void diagnostic.refetch()}
                  >
                    {diagnostic.data
                      ? "Actualizar diagnóstico"
                      : "Ver diagnóstico (requiere permiso vigente)"}
                  </Button>
                </div>
                {diagnostic.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {diagnostic.error instanceof Error
                      ? diagnostic.error.message
                      : "Sin permiso vigente."}
                  </p>
                ) : null}
                {diagnostic.data ? (
                  <div className="flex flex-col gap-2 rounded-lg bg-card px-3 py-2">
                    <p className="text-muted-foreground">{diagnostic.data.scope}</p>
                    <p>
                      <strong>{diagnostic.data.organization.name}</strong> (
                      {diagnostic.data.organization.slug}) · permiso hasta el{" "}
                      {new Date(diagnostic.data.grantExpiresAt).toLocaleString()}
                    </p>
                    <p>
                      Perfil:{" "}
                      {diagnostic.data.profile
                        ? `${diagnostic.data.profile.countryCode} · ${diagnostic.data.profile.currency} · ${diagnostic.data.profile.timezone} · ${diagnostic.data.profile.locale}`
                        : "sin perfil"}{" "}
                      · Servicios: {diagnostic.data.services.total}
                    </p>
                    <p>
                      Sedes:{" "}
                      {diagnostic.data.branches.length === 0
                        ? "ninguna"
                        : diagnostic.data.branches
                            .map(
                              (branch) => `${branch.name}${branch.isActive ? "" : " (inactiva)"}`,
                            )
                            .join(" · ")}
                    </p>
                    <p>
                      Agente:{" "}
                      {diagnostic.data.agent
                        ? `${diagnostic.data.agent.enabled ? "encendido" : "apagado"} · decisiones ${diagnostic.data.agent.decisionProvider} · tope ${diagnostic.data.agent.dailyRunLimit}/día`
                        : "sin configuración"}
                    </p>
                    <p>
                      Canales:{" "}
                      {diagnostic.data.channels.length === 0
                        ? "ninguno"
                        : diagnostic.data.channels
                            .map((channel) => `${channel.displayName} (${channel.status})`)
                            .join(" · ")}
                    </p>
                    <p>
                      Equipo por rol:{" "}
                      {diagnostic.data.membersByRole.length === 0
                        ? "—"
                        : diagnostic.data.membersByRole
                            .map((row) => `${row.role}: ${row.total}`)
                            .join(" · ")}
                    </p>
                    <p className="text-muted-foreground">
                      No se abre agenda, contactos, pacientes, historia, bandeja ni exportaciones:
                      esta vista solo lee configuración.
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : selectedId !== null ? (
            <section
              aria-label="Ficha del caso"
              className="flex flex-col gap-3 rounded-xl border px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={() => setSelectedId(null)}
                >
                  ← Cerrar ficha
                </Button>
              </div>
              {detail.isPending ? (
                <LoadingState message="Cargando el caso…" />
              ) : (
                <ErrorState
                  message="No pude cargar este caso."
                  onRetry={() => void detail.refetch()}
                />
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </PageShell>
  )
}
