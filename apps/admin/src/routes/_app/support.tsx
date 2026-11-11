import {
  Button,
  cn,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ExpandableText,
  PageHeader,
  PageShell,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { ProductMark, useOrgProducts } from "../../components/product"
import {
  SupportCaseSkeleton,
  SupportCasesSkeleton,
  SupportKnowledgeSkeleton,
  SupportMetricsSkeleton,
  SupportPageSkeleton,
} from "../../components/skeletons/support"
import { SupportHelpVideos } from "../../components/support-help-videos"
import { caseReview, SupportCaseReview } from "../../components/support-review"
import { api } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { useAdminUserId, useIsAdmin } from "../../lib/session"
import {
  accessUntilWords,
  agoWords,
  daysSince,
  grantWords,
  SUPPORT_KIND_LABEL,
  supportDay,
  supportDayTime,
  supportWaitWords,
} from "../../lib/support-words"

const supportStatus = z.enum(["abierto", "en_atencion", "esperando_clinica", "resuelto"])
type SupportStatus = z.infer<typeof supportStatus>
const supportKind = z.enum(["pregunta", "problema", "acceso", "cobro"])
type SupportKind = z.infer<typeof supportKind>

const STATUSES: SupportStatus[] = ["abierto", "en_atencion", "esperando_clinica", "resuelto"]
const KINDS: SupportKind[] = ["pregunta", "problema", "acceso", "cobro"]

const STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

/** Lo que dice el botón que lleva el caso a cada estado. */
const STATUS_ACTION: Record<SupportStatus, string> = {
  abierto: "Volver a abierto",
  en_atencion: "Pasar a en atención",
  esperando_clinica: "Esperar a la clínica",
  resuelto: "Resolver",
}

/** El estado de un canal de la clínica, en palabras (el diagnóstico). */
const CHANNEL_STATUS_WORDS: Record<string, string> = {
  active: "conectado",
  pending: "conectándose",
  error: "con error",
  disabled: "desactivado",
  revoked: "desconectado",
}

/** Desde cuántos días esperando a la clínica se sugiere cerrar (lo cierra una persona). */
const CLOSE_HINT_DAYS = 7

type Who = "mios" | "sin"
type SupportTab = "cola" | "conocimiento" | "metricas"

interface SupportSearch {
  /** El caso abierto: lo usa también el enlace del aviso por correo. */
  caso?: string
  clinica?: string
  tipo?: SupportKind
  quien?: Who
  /** Sin estado: los que no están resueltos. */
  estado?: SupportStatus
  pestana?: Exclude<SupportTab, "cola">
}

export const Route = createFileRoute("/_app/support")({
  validateSearch: (search: Record<string, unknown>): SupportSearch => ({
    ...(typeof search.caso === "string" && search.caso ? { caso: search.caso } : {}),
    ...(typeof search.clinica === "string" && search.clinica ? { clinica: search.clinica } : {}),
    ...(KINDS.includes(search.tipo as SupportKind) ? { tipo: search.tipo as SupportKind } : {}),
    ...(search.quien === "mios" || search.quien === "sin" ? { quien: search.quien } : {}),
    ...(STATUSES.includes(search.estado as SupportStatus) ? { estado: search.estado as SupportStatus } : {}),
    ...(search.pestana === "conocimiento" || search.pestana === "metricas" ? { pestana: search.pestana } : {}),
  }),
  pendingComponent: SupportPageSkeleton,
  component: SupportPage,
})

const caseItem = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  kind: supportKind,
  question: z.string(),
  status: supportStatus,
  assigneeStaffId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const queueItem = caseItem.extend({
  waitingOnUs: z.boolean(),
  waitingSince: z.string().nullable(),
  answerBy: z.string().nullable(),
  lastStaffReplyAt: z.string().nullable(),
  accessUntil: z.string().nullable(),
})
type QueueItem = z.infer<typeof queueItem>

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
  /** Solo en «Revisión de cobro»: la fila que la clínica pidió revisar (ADR 0054). */
  review: caseReview.nullable().optional(),
  accessRequestedAt: z.string().nullable(),
  /** Quien abrió y su rol de hoy (nulo en los automáticos de odentIA). */
  opener: z.object({ name: z.string(), roleLabel: z.string() }).nullable(),
  openerCanGrant: z.boolean(),
  /** La propietaria y los administradores de hoy. */
  granters: z.array(z.object({ name: z.string(), roleLabel: z.string() })),
  accessRequestPending: z.boolean(),
  /** El mensaje que deja el pedido, tal cual lo verá la clínica. */
  accessRequestText: z.string().nullable(),
  /** Por qué no se ofrece pedir el acceso. */
  accessRequestBlocked: z.string().nullable(),
  guideGapMarkedAt: z.string().nullable(),
})
type CaseDetail = z.infer<typeof caseDetail>

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
  /** `label`: el rol en español, en el producto de la clínica (lo dice el servidor). */
  membersByRole: z.array(z.object({ role: z.string(), label: z.string(), total: z.number() })),
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

const helpStatsRow = z.object({ name: z.string(), total: z.number() })
const helpStatsPayload = z.object({
  days: z.number(),
  asked: z.number(),
  unanswered: z.number(),
  notHelpful: z.number(),
  unansweredByScreen: z.array(helpStatsRow),
  notHelpfulByTopic: z.array(helpStatsRow),
})

const guideGapItem = z.object({
  caseId: z.string(),
  question: z.string(),
  kind: z.string(),
  topic: z.string().nullable(),
  markedAt: z.string(),
})

const casesPayload = z.object({ items: z.array(queueItem), total: z.number(), resolvedCount: z.number() })
const assigneePayload = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.enum(["admin", "support"]),
})

/** A quién le llega el pedido y quién lo autoriza: «Le llega a Rosa (Recepción). Lo autoriza: Ana Torres (Propietario) o un administrador.». */
function accessRecipientsWords(kase: CaseDetail): string {
  const person = (who: { name: string; roleLabel: string }) => `${who.name} (${who.roleLabel})`
  const opener = kase.opener ? person(kase.opener) : "quien abrió el caso"
  if (kase.openerCanGrant) return `Le llega a ${opener}, que puede autorizarlo.`
  const owner = kase.granters[0]
  return owner
    ? `Le llega a ${opener}. Lo autoriza: ${person(owner)} o un administrador.`
    : `Le llega a ${opener}. Lo autoriza la propietaria o un administrador de la clínica.`
}

/** Dónde está la espera de una fila de la cola, en una línea. */
function queueLine(item: QueueItem, now: Date): { text: string; urgent: boolean; closeHint: boolean } {
  if (item.waitingOnUs && item.waitingSince)
    return {
      ...supportWaitWords({ waitingSince: item.waitingSince, answerBy: item.answerBy, accessUntil: item.accessUntil }, now),
      closeHint: false,
    }
  const since = item.lastStaffReplyAt ?? item.updatedAt
  if (item.status === "esperando_clinica")
    return {
      text: `Espera a la clínica desde ${agoWords(since, now)}`,
      urgent: false,
      closeHint: daysSince(since, now) >= CLOSE_HINT_DAYS,
    }
  if (item.status === "resuelto") return { text: `Resuelto, ${agoWords(item.updatedAt, now)}`, urgent: false, closeHint: false }
  return { text: `Ya respondimos, ${agoWords(since, now)}`, urgent: false, closeHint: false }
}

function SupportPage() {
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const setSearch = (patch: Partial<SupportSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const tab: SupportTab = search.pestana ?? "cola"
  const selectedId = search.caso ?? null
  const [page, setPage] = useState(0)
  const [checked, setChecked] = useState<string[]>([])
  // Borradores por caso: cambiar de ficha conserva cada texto y nunca envía
  // el borrador de un caso en otro. Solo se limpian al enviarse con éxito.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [manyBody, setManyBody] = useState("")
  const [askingAccess, setAskingAccess] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  /** La fila desde la que se abrió la ficha: «Cerrar ficha» devuelve ahí el foco. */
  const openedFrom = useRef<string | null>(null)
  const focusedCase = useRef<string | null>(null)
  const now = new Date()

  const PAGE_SIZE = 20
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
  if (search.estado) params.set("status", search.estado)
  if (search.tipo) params.set("kind", search.tipo)
  if (search.quien) params.set("assignee", search.quien === "mios" ? "me" : "none")
  if (search.clinica) params.set("organizationId", search.clinica)
  const cases = useQuery({
    queryKey: ["admin-support-cases", search.estado ?? "sin_resolver", search.tipo ?? null, search.quien ?? null, search.clinica ?? null, page],
    queryFn: () => api(`/api/admin/support/cases?${params.toString()}`).then((body: unknown) => casesPayload.parse(body)),
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
  const helpStats = useQuery({
    queryKey: ["admin-support-help-stats"],
    queryFn: () =>
      api("/api/admin/support/help-stats").then((body: unknown) => helpStatsPayload.parse(body)),
    enabled: tab === "conocimiento",
  })
  const guideGaps = useQuery({
    queryKey: ["admin-support-guide-gaps"],
    queryFn: () =>
      api("/api/admin/support/knowledge/guide-gaps").then((body: unknown) => z.array(guideGapItem).parse(body)),
    enabled: tab === "conocimiento",
  })
  const metrics = useQuery({
    queryKey: ["admin-support-metrics"],
    queryFn: () =>
      api("/api/admin/support/metrics").then((body: unknown) => metricsPayload.parse(body)),
    enabled: tab === "metricas",
  })
  const myUserId = useAdminUserId()
  const isAdmin = useIsAdmin()
  const products = useOrgProducts().data ?? {}
  const assignees = useQuery({
    queryKey: ["admin-support-assignees"],
    queryFn: () =>
      api("/api/admin/support/assignees").then((body: unknown) =>
        z.array(assigneePayload).parse(body),
      ),
    staleTime: 300_000,
    retry: false,
  })

  const items = cases.data?.items ?? []
  // El nombre de la clínica del filtro: de sus filas o, sin filas, de su ficha.
  const clinicFromRows = items.find((item) => item.organizationId === search.clinica)?.organizationName ?? null
  const clinic = useQuery({
    queryKey: ["admin-support-clinic", search.clinica],
    queryFn: () => api<{ name: string }>(`/api/admin/organizations/${search.clinica}`).then((body) => body.name),
    enabled: Boolean(search.clinica) && cases.isSuccess && clinicFromRows === null,
    staleTime: 300_000,
  })
  const clinicName = clinicFromRows ?? clinic.data ?? null

  // Abrir un caso (con clic o con `?caso=`) lleva la ficha a la vista y el foco a su título.
  useEffect(() => {
    if (!selectedId || detail.data?.id !== selectedId || focusedCase.current === selectedId) return
    focusedCase.current = selectedId
    titleRef.current?.scrollIntoView({ block: "start" })
    titleRef.current?.focus({ preventScroll: true })
  }, [selectedId, detail.data?.id])

  function openCase(id: string) {
    openedFrom.current = id
    focusedCase.current = null
    setSearch({ caso: id })
  }

  function closeCase() {
    const from = openedFrom.current ?? selectedId
    focusedCase.current = null
    setSearch({ caso: undefined })
    requestAnimationFrame(() => {
      if (from) rowButtons.current.get(from)?.focus()
    })
  }

  function changeFilter(patch: Partial<SupportSearch>) {
    setPage(0)
    setChecked([])
    setSearch(patch)
  }

  // Invalida por prefijo: si cambia la ficha a mitad de una mutación, la
  // respuesta igual refresca la lista, el detalle e Inicio con el menú.
  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["admin-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["admin-support-case"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
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
  // Un segundo clic antes de que se pinte «Pidiendo…» no manda otro pedido: la
  // marca es inmediata; `isPending` llega a la pantalla después.
  const requestingAccess = useRef(false)
  const requestAccess = useMutation({
    mutationFn: (id: string) => api(`/api/admin/support/cases/${id}/request-access`, { method: "POST" }),
    onSuccess: () => {
      setAskingAccess(false)
      toast.success("Pediste el acceso: el caso espera a la clínica")
      invalidate()
    },
    onSettled: () => {
      requestingAccess.current = false
    },
  })
  const guideGap = useMutation({
    mutationFn: (input: { id: string; on: boolean }) =>
      api(`/api/admin/support/cases/${input.id}/guide-gap`, { method: input.on ? "PUT" : "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-support-guide-gaps"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-support-case"] })
    },
  })
  /** «Ya está en la guía» desde Conocimiento: se quita al momento y el aviso ofrece «Deshacer». */
  function inGuide(id: string) {
    guideGap.mutate(
      { id, on: false },
      {
        onSuccess: () =>
          toast.success("Quitado de «Para llevar a la guía»", {
            action: { label: "Deshacer", onClick: () => guideGap.mutate({ id, on: true }) },
          }),
      },
    )
  }
  const revokeGrant = useMutation({
    mutationFn: (grantId: string) =>
      api(`/api/admin/support/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId }),
      }),
    onSuccess: invalidate,
  })

  const total = cases.data?.total ?? 0
  const resolvedCount = cases.data?.resolvedCount ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const kase = detail.data ?? null
  const kaseProduct = kase?.organizationId ? products[kase.organizationId] : undefined
  const checkedCases = items.filter((item) => checked.includes(item.id))
  const recipientOrgs = checkedCases.map((item) => item.organizationId)
  const assigneeName = (userId: string | null): string | null =>
    userId === null
      ? null
      : ((assignees.data ?? []).find((item) => item.userId === userId)?.name ?? null)
  const orgNameOf = (item: { organizationName: string | null }) => item.organizationName ?? "Cuenta sin clínica"
  const kindItems = KINDS.filter((value) => value !== "cobro" || isAdmin)

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
            onClick={() => setSearch({ pestana: view === "cola" ? undefined : view })}
          >
            {view === "cola" ? "Cola" : view === "conocimiento" ? "Conocimiento" : "Métricas"}
          </Button>
        ))}
      </div>

      {tab === "metricas" ? (
        <section aria-label="Métricas de soporte" className="flex flex-col gap-2">
          {metrics.isPending ? (
            <SkeletonRegion message="Cargando métricas…">
              <SupportMetricsSkeleton />
            </SkeletonRegion>
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
        <section aria-label="Lo que Ariadna no supo" className="flex flex-col gap-2">
          <h2 className="font-heading text-base font-semibold">Lo que Ariadna no supo</h2>
          {helpStats.isPending ? (
            <SkeletonRegion message="Cargando lo que Ariadna no supo…">
              <SupportKnowledgeSkeleton />
            </SkeletonRegion>
          ) : helpStats.isError ? (
            <ErrorState message="No pude cargar lo que Ariadna no supo." onRetry={() => void helpStats.refetch()} />
          ) : helpStats.data ? (
            <>
              <p className="text-sm text-muted-foreground">
                Últimos {helpStats.data.days} días, en todas las clínicas: {helpStats.data.asked}{" "}
                {helpStats.data.asked === 1 ? "pregunta" : "preguntas"}, {helpStats.data.unanswered} sin respuesta y{" "}
                {helpStats.data.notHelpful} que no sirvieron. Lo que se preguntó no se guarda, salvo que la persona lo envíe.
              </p>
              {helpStats.data.unansweredByScreen.length > 0 || helpStats.data.notHelpfulByTopic.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["No supo responder, por pantalla", helpStats.data.unansweredByScreen],
                      ["Respondió y no sirvió, por tema", helpStats.data.notHelpfulByTopic],
                    ] as const
                  ).map(([title, rows]) => (
                    <div key={title} className="flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-sm">
                      <h3 className="font-semibold">{title}</h3>
                      {rows.length === 0 ? (
                        <p className="text-muted-foreground">Sin casos.</p>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {rows.map((row) => (
                            <li key={row.name} className="flex justify-between gap-3">
                              <span className="min-w-0">{row.name}</span>
                              <span className="tabular-nums">{row.total}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {tab === "conocimiento" ? (
        <section aria-labelledby="soporte-para-la-guia" className="flex flex-col gap-2">
          <h2 id="soporte-para-la-guia" className="font-heading text-base font-semibold">
            Para llevar a la guía
          </h2>
          <p className="text-sm text-muted-foreground">
            Casos que el equipo marcó con «Falta en la guía». Se quedan aquí hasta que alguien los quite.
          </p>
          {guideGaps.isPending ? (
            <SkeletonRegion message="Cargando lo que falta en la guía…">
              <SupportKnowledgeSkeleton />
            </SkeletonRegion>
          ) : guideGaps.isError ? (
            <ErrorState message="No pude cargar lo que falta en la guía." onRetry={() => void guideGaps.refetch()} />
          ) : (guideGaps.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nada marcado por ahora.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(guideGaps.data ?? []).map((gap) => (
                <li key={gap.caseId} className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
                  <p className="font-semibold [overflow-wrap:anywhere]">«{gap.question}»</p>
                  <p className="text-muted-foreground">
                    Tema: {gap.topic ?? "sin tema en la guía"} · marcado el {supportDay(gap.markedAt)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      onClick={() => {
                        focusedCase.current = null
                        setSearch({ pestana: undefined, caso: gap.caseId })
                      }}
                    >
                      Abrir caso
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      disabled={guideGap.isPending}
                      onClick={() => inGuide(gap.caseId)}
                    >
                      Ya está en la guía
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
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
            <SkeletonRegion message="Cargando agrupación…">
              <SupportKnowledgeSkeleton />
            </SkeletonRegion>
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

      {tab === "conocimiento" ? <SupportHelpVideos /> : null}

      {tab === "cola" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="soporte-estado">Estado</FieldLabel>
              <Select
                value={search.estado ?? "__open__"}
                items={{
                  __open__: "Sin resolver",
                  ...Object.fromEntries(STATUSES.map((value) => [value, STATUS_LABEL[value]])),
                }}
                onValueChange={(value) =>
                  changeFilter({ estado: !value || value === "__open__" ? undefined : (value as SupportStatus) })
                }
              >
                <SelectTrigger id="soporte-estado" className="w-52 max-w-full">
                  <SelectValue placeholder="Sin resolver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__open__">Sin resolver</SelectItem>
                  {STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {STATUS_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="soporte-tipo">Tipo</FieldLabel>
              <Select
                value={search.tipo ?? "__all__"}
                items={{
                  __all__: "Todos",
                  ...Object.fromEntries(kindItems.map((value) => [value, SUPPORT_KIND_LABEL[value]])),
                }}
                onValueChange={(value) =>
                  changeFilter({ tipo: !value || value === "__all__" ? undefined : (value as SupportKind) })
                }
              >
                <SelectTrigger id="soporte-tipo" className="w-48 max-w-full">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {kindItems.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SUPPORT_KIND_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span id="soporte-quien" className="text-sm leading-snug font-medium">
                Quién
              </span>
              <ToggleGroup
                aria-labelledby="soporte-quien"
                value={[search.quien ?? "todos"]}
                onValueChange={(next: unknown[]) => {
                  const picked = next[0]
                  // Tocar otra vez lo elegido no deja el filtro vacío.
                  if (picked === "todos") changeFilter({ quien: undefined })
                  else if (picked === "mios" || picked === "sin") changeFilter({ quien: picked })
                }}
                spacing={1}
                className="flex-wrap rounded-3xl border bg-muted p-1"
              >
                {(
                  [
                    ["todos", "Todos"],
                    ["mios", "Míos"],
                    ["sin", "Sin responsable"],
                  ] as const
                ).map(([value, label]) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="h-auto min-h-9 rounded-3xl px-3.5 py-1.5 font-semibold text-foreground hover:bg-background/60 aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:hover:bg-background"
                  >
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {search.clinica ? (
              <p className="flex min-h-9 flex-wrap items-center gap-2 rounded-3xl border bg-card px-3 py-1 text-sm">
                <span className="[overflow-wrap:anywhere]">
                  Clínica: <b>{clinicName ?? "la elegida"}</b>
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  aria-label={`Quitar el filtro de la clínica ${clinicName ?? ""}`.trim()}
                  onClick={() => changeFilter({ clinica: undefined })}
                >
                  Quitar
                </Button>
              </p>
            ) : null}
          </div>

          {cases.isPending ? (
            <SkeletonRegion message="Cargando casos…">
              <SupportCasesSkeleton />
            </SkeletonRegion>
          ) : cases.isError ? (
            <ErrorState message="No pude cargar los casos." onRetry={() => void cases.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title="Sin casos" description="No hay casos con este filtro." />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {items.map((item) => {
                  const line = queueLine(item, now)
                  const product = item.organizationId ? products[item.organizationId] : undefined
                  return (
                    <li
                      key={item.id}
                      className="flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2.5"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                            {STATUS_LABEL[item.status]}
                          </span>
                          <span className="text-xs font-semibold text-muted-foreground">{SUPPORT_KIND_LABEL[item.kind]}</span>
                          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{orgNameOf(item)}</span>
                          {product ? <ProductMark product={product} /> : null}
                        </span>
                        <ExpandableText
                          text={`«${item.question}»`}
                          label="Consulta del caso"
                          className="min-w-0 text-sm [overflow-wrap:anywhere]"
                        />
                        <p className={cn("text-sm", line.urgent ? "font-semibold text-destructive" : "text-muted-foreground")}>
                          {line.text}
                          {line.closeHint ? <span className="text-foreground"> · ¿Lo cerramos?</span> : null}
                        </p>
                        <p className="text-sm text-muted-foreground">{assigneeName(item.assigneeStaffId) ?? "Sin asignar"}</p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <Button
                            ref={(node) => {
                              if (node) rowButtons.current.set(item.id, node)
                              else rowButtons.current.delete(item.id)
                            }}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 self-start sm:min-h-9"
                            onClick={() => openCase(item.id)}
                            aria-expanded={selectedId === item.id}
                            aria-label={`Abrir caso de ${orgNameOf(item)}: ${item.question.slice(0, 80)}`}
                          >
                            Abrir caso
                          </Button>
                          {isAdmin ? (
                            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
                              <input
                                type="checkbox"
                                checked={checked.includes(item.id)}
                                onChange={() => toggleCheck(item.id)}
                                className="size-5 shrink-0"
                              />
                              Elegir para responder a varios
                            </label>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
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
          {!search.estado && resolvedCount > 0 && cases.isSuccess ? (
            <p className="text-sm text-muted-foreground">
              {resolvedCount === 1 ? "1 caso resuelto no se muestra." : `${resolvedCount} casos resueltos no se muestran.`}{" "}
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => changeFilter({ estado: "resuelto" })}>
                Ver resueltos
              </Button>
            </p>
          ) : null}

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
                {checkedCases.map((item) => orgNameOf(item)).join(" · ")}.
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
              aria-labelledby="soporte-ficha-titulo"
              className="flex scroll-mt-4 flex-col gap-3 rounded-xl border px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={closeCase}
                >
                  ← Cerrar ficha
                </Button>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                  {STATUS_LABEL[kase.status]}
                </span>
                <span className="text-xs font-semibold text-muted-foreground">{SUPPORT_KIND_LABEL[kase.kind]}</span>
                {kase.organizationId ? (
                  <Link
                    to="/organizations/$organizationId"
                    params={{ organizationId: kase.organizationId }}
                    search={{ tab: "equipo" }}
                    className="text-sm font-semibold underline-offset-4 hover:underline"
                  >
                    {orgNameOf(kase)}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold">{orgNameOf(kase)}</span>
                )}
                {kaseProduct ? <ProductMark product={kaseProduct} /> : null}
              </div>
              {/* La consulta entera (500 caracteres como mucho): es el título de la ficha y recibe el foco al abrirla. */}
              <h2
                id="soporte-ficha-titulo"
                ref={titleRef}
                tabIndex={-1}
                className="scroll-mt-4 rounded-md text-sm font-semibold whitespace-pre-wrap outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
              >
                «{kase.question}»
              </h2>
              <p className="text-sm text-muted-foreground">
                Pantalla: {kase.screen} · Rol: {kase.role || "—"} · Versión:{" "}
                {kase.appVersion ?? "—"} · Abierto el {supportDayTime(kase.createdAt)} · Reaperturas: {kase.reopenedCount} · Responsable:{" "}
                {assigneeName(kase.assigneeStaffId) ?? "sin asignar"}
              </p>
              {kase.review ? (
                <SupportCaseReview caseId={kase.id} review={kase.review} roleLabel={kase.role} isAdmin={isAdmin} />
              ) : null}

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
                          : "Clínica"}{" "}
                      · {supportDayTime(message.createdAt)}
                    </p>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
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
                  <SelectTrigger id="soporte-responsable" className="w-56 max-w-full">
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
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  disabled={assign.isPending}
                  onClick={() => assign.mutate(myUserId)}
                >
                  Asignarme
                </Button>
                <span className="flex min-h-11 items-center gap-2 sm:min-h-9">
                  <Switch
                    id="soporte-falta-guia"
                    checked={kase.guideGapMarkedAt !== null}
                    disabled={guideGap.isPending}
                    onCheckedChange={(on) =>
                      guideGap.mutate(
                        { id: kase.id, on },
                        { onSuccess: () => toast.success(on ? "Marcado: falta en la guía" : "Quitado de «Para llevar a la guía»") },
                      )
                    }
                  />
                  <FieldLabel htmlFor="soporte-falta-guia">Falta en la guía</FieldLabel>
                </span>
                {/* Una «Revisión de cobro» se resuelve al decidirla (ADR 0054). */}
                {STATUSES.filter((value) => value !== kase.status && !(value === "resuelto" && kase.review?.status === "pendiente")).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={setCaseStatus.isPending}
                    onClick={() => setCaseStatus.mutate(value)}
                  >
                    {STATUS_ACTION[value]}
                  </Button>
                ))}
              </div>

              <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
                <p className="font-bold">Acceso diagnóstico</p>
                {(kase.grants ?? []).length === 0 ? (
                  <p className="text-muted-foreground">Sin permisos todavía.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {kase.grants.map((grant) => (
                      <li key={grant.id} className="flex flex-wrap items-center gap-2">
                        <span>{grantWords(grant, now)}</span>
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
                <AccessRequestLine kase={kase} now={now} />
                <div className="flex flex-wrap gap-2">
                  {kase.accessRequestText ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      onClick={() => {
                        requestAccess.reset()
                        setAskingAccess(true)
                      }}
                    >
                      Pedir acceso de diagnóstico…
                    </Button>
                  ) : null}
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
                      {supportDayTime(diagnostic.data.grantExpiresAt)}
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
                        ? `${diagnostic.data.agent.enabled ? "encendido" : "apagado"} · decisiones ${diagnostic.data.agent.decisionProvider}`
                        : "sin configuración"}
                    </p>
                    <p>
                      Canales:{" "}
                      {diagnostic.data.channels.length === 0
                        ? "ninguno"
                        : diagnostic.data.channels
                            .map((channel) => `${channel.displayName} (${CHANNEL_STATUS_WORDS[channel.status] ?? channel.status})`)
                            .join(" · ")}
                    </p>
                    <p>
                      Equipo por rol:{" "}
                      {diagnostic.data.membersByRole.length === 0
                        ? "—"
                        : diagnostic.data.membersByRole
                            .map((row) => `${row.label}: ${row.total}`)
                            .join(" · ")}
                    </p>
                    <p className="text-muted-foreground">
                      No se abre agenda, contactos, pacientes, historia, bandeja ni exportaciones:
                      esta vista solo lee configuración.
                    </p>
                  </div>
                ) : null}
              </div>
              {kase.accessRequestText ? (
                <ConfirmDialog
                  open={askingAccess}
                  title="¿Pedir el acceso de diagnóstico?"
                  description={accessRecipientsWords(kase)}
                  confirmLabel="Pedir acceso"
                  cancelLabel="Volver"
                  variant="default"
                  pending={requestAccess.isPending}
                  error={requestAccess.isError ? (requestAccess.error instanceof Error ? requestAccess.error.message : "No se pudo pedir el acceso.") : null}
                  onConfirm={() => {
                    if (requestingAccess.current) return
                    requestingAccess.current = true
                    requestAccess.mutate(kase.id)
                  }}
                  onClose={() => setAskingAccess(false)}
                >
                  <div className="flex flex-col gap-1.5 text-sm">
                    <p className="font-semibold">Este mensaje queda en el caso:</p>
                    <blockquote className="rounded-xl bg-primary-soft px-3 py-2 whitespace-pre-wrap">{kase.accessRequestText}</blockquote>
                    <p className="text-muted-foreground">
                      El caso pasa a «Esperando a la clínica». Si no lo ven en 15 minutos, les llega el correo de que soporte necesita algo.
                    </p>
                  </div>
                </ConfirmDialog>
              ) : null}
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
                  onClick={closeCase}
                >
                  ← Cerrar ficha
                </Button>
              </div>
              {detail.isPending ? (
                <SkeletonRegion message="Cargando el caso…" className="flex flex-col gap-3">
                  <SupportCaseSkeleton />
                </SkeletonRegion>
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

/**
 * Cómo va el pedido de acceso: «Pediste acceso el mié 11 nov, 10:40 · esperando
 * a la clínica», o «Acceso autorizado hasta las 15:30» con un permiso vigente.
 */
function AccessRequestLine({ kase, now }: { kase: CaseDetail; now: Date }) {
  const active = kase.grants.find((grant) => grant.active)
  if (active) return <p className="font-semibold">{accessUntilWords(active.expiresAt, now)}</p>
  if (kase.accessRequestPending && kase.accessRequestedAt)
    return (
      <p>
        Pediste acceso el {supportDayTime(kase.accessRequestedAt)}
        {kase.status === "esperando_clinica" ? " · esperando a la clínica" : ""}
      </p>
    )
  if (kase.accessRequestText)
    return (
      <p className="text-muted-foreground">
        {kase.openerCanGrant
          ? `Lo puede autorizar quien abrió el caso: es ${kase.opener?.roleLabel ?? "de la clínica"}.`
          : "Lo autoriza la propietaria o un administrador de la clínica: al pedirlo, ellos también ven el caso."}
      </p>
    )
  return null
}
