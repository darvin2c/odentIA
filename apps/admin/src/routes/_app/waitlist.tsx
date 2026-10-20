import {
  Badge,
  Button,
  FieldLabel,
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
  DataTable,
  DataTableSkeleton,
  DetailDrawer,
  DetailField,
  DetailList,
  DetailSection,
  EmptyState,
  ErrorState,
  KpiCard,
  PageHeader,
  PageNotice,
  PageShell,
  SearchInput,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable, type VisibilityState } from "@tanstack/react-table"
import { CircleAlert, ListChecks } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { webUrl } from "../../lib/host"

type StatusFilter = "por_revisar" | "invitada" | "entro" | "descartada" | "todas"

interface WaitlistSearch {
  estado?: StatusFilter
  q?: string
  solicitud?: string
}

const STATUSES: StatusFilter[] = ["por_revisar", "invitada", "entro", "descartada", "todas"]

export const Route = createFileRoute("/_app/waitlist")({
  validateSearch: (search: Record<string, unknown>): WaitlistSearch => ({
    ...(typeof search.estado === "string" && STATUSES.includes(search.estado as StatusFilter) && search.estado !== "por_revisar"
      ? { estado: search.estado as StatusFilter }
      : {}),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    ...(typeof search.solicitud === "string" ? { solicitud: search.solicitud } : {}),
  }),
  component: WaitlistPage,
})

const appRoute = getRouteApi("/_app")

const STATUS_LABEL: Record<StatusFilter, string> = {
  por_revisar: "Por revisar",
  invitada: "Invitadas",
  entro: "Entraron",
  descartada: "Descartadas",
  todas: "Todas",
}
const ONE_LABEL: Record<Exclude<StatusFilter, "todas">, string> = {
  por_revisar: "Por revisar",
  invitada: "Invitada",
  entro: "Entró",
  descartada: "Descartada",
}
const DENTISTS_LABEL: Record<string, string> = { "1": "1", "2-3": "2 a 3", "4-9": "4 a 9", "10+": "10 o más" }
const TOOL_LABEL: Record<string, string> = {
  nada: "Nada",
  cuaderno_excel: "Cuaderno o Excel",
  otro_software: "Otro software",
}

const row = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  clinicName: z.string(),
  countryCode: z.string(),
  city: z.string(),
  dentists: z.string(),
  currentTool: z.string(),
  status: z.enum(["por_revisar", "invitada", "entro", "descartada"]),
  note: z.string().nullable(),
  discardReason: z.string().nullable(),
  planId: z.string().nullable(),
  planName: z.string().nullable(),
  inviteExpiresAt: z.string().nullable(),
  invitedAt: z.string().nullable(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  enteredAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  createdAt: z.string(),
  answerBy: z.string().nullable(),
})
type Row = z.infer<typeof row>
const pagePayload = z.object({
  rows: z.array(row),
  counts: z.record(z.string(), z.number()),
  seats: z.object({ planId: z.string(), planName: z.string(), used: z.number(), limit: z.number().nullable() }).nullable(),
  mode: z.enum(["invitacion", "abierta"]),
  answerDays: z.number(),
})
const invitePayload = z.object({ url: z.string(), expiresAt: z.string(), emailSent: z.boolean(), validDays: z.number() })

const dayFormat = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })
const timeFormat = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" })
const clean = (text: string) => text.replaceAll(".", "").replace(",", "")
const formatDay = (iso: string) => clean(dayFormat.format(new Date(iso)))
const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/** «hoy, 10:42», «ayer», «hace 3 días». */
function askedText(iso: string, now: Date): string {
  const date = new Date(iso)
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return `hoy, ${timeFormat.format(date)}`
  if (days === 1) return "ayer"
  return `hace ${days} días`
}

/** Cómo va lo que le toca a la administración con esta solicitud. */
function deadlineOf(item: Row, now: Date): { text: string; tone: "destructive" | "warning" | "muted" } {
  if (item.status === "por_revisar" && item.answerBy) {
    const left = Math.ceil((new Date(item.answerBy).getTime() - now.getTime()) / 86_400_000)
    if (left < 0) return { text: `Venció el ${formatDay(item.answerBy)}`, tone: "destructive" }
    if (left === 0) return { text: "Vence hoy", tone: "destructive" }
    return { text: `Responder hasta el ${formatDay(item.answerBy)}`, tone: left <= 1 ? "warning" : "muted" }
  }
  if (item.status === "invitada" && item.inviteExpiresAt) {
    const expires = new Date(item.inviteExpiresAt)
    if (expires <= now) return { text: `La invitación venció el ${formatDay(item.inviteExpiresAt)}`, tone: "destructive" }
    const left = Math.ceil((expires.getTime() - now.getTime()) / 86_400_000)
    return { text: `La invitación vence el ${formatDay(item.inviteExpiresAt)}`, tone: left <= 3 ? "warning" : "muted" }
  }
  if (item.status === "entro" && item.enteredAt) return { text: `Entró el ${formatDay(item.enteredAt)}`, tone: "muted" }
  return { text: "—", tone: "muted" }
}

function Deadline({ item, now }: { item: Row; now: Date }) {
  const deadline = deadlineOf(item, now)
  if (deadline.tone === "muted") return <span className="text-sm text-muted-foreground">{deadline.text}</span>
  return (
    <Badge variant={deadline.tone}>
      <CircleAlert aria-hidden />
      {deadline.text}
    </Badge>
  )
}

function WaitlistPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { adminSession } = appRoute.useRouteContext()
  const isAdmin = adminSession.actor.role === "admin"
  const status: StatusFilter = search.estado ?? "por_revisar"
  const list = useQuery({
    queryKey: ["admin", "waitlist", status, search.q ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams({ status })
      if (search.q) params.set("q", search.q)
      return pagePayload.parse(await api(`/api/admin/waitlist?${params}`))
    },
  })
  const rows = list.data?.rows ?? []
  const now = new Date()
  const open = (id: string | undefined) => void navigate({ search: (prev) => ({ ...prev, solicitud: id }), replace: true })
  const compact = Boolean(search.solicitud)

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "clinic",
        header: "Clínica",
        cell: ({ row: r }) => <span className="font-semibold">{r.original.clinicName}</span>,
        meta: { view: { role: "title" } },
      },
      {
        id: "who",
        header: "Quién",
        cell: ({ row: r }) => `${r.original.firstName} ${r.original.lastName}`,
        meta: { view: { primary: true } },
      },
      { id: "where", header: "Dónde", cell: ({ row: r }) => `${r.original.city}, ${countryName(r.original.countryCode)}` },
      { id: "dentists", header: "Odontólogos", cell: ({ row: r }) => DENTISTS_LABEL[r.original.dentists] ?? r.original.dentists },
      { id: "tool", header: "Usan hoy", cell: ({ row: r }) => TOOL_LABEL[r.original.currentTool] ?? r.original.currentTool },
      { id: "asked", header: "Pidió", cell: ({ row: r }) => askedText(r.original.createdAt, new Date()) },
      {
        id: "deadline",
        header: "Plazo",
        cell: ({ row: r }) => <Deadline item={r.original} now={new Date()} />,
        meta: { view: { primary: true } },
      },
    ],
    [],
  )
  const columnVisibility: VisibilityState = compact ? { where: false, dentists: false, tool: false, asked: false, who: false } : {}
  const table = useReactTable({ data: rows, columns, state: { columnVisibility }, getCoreRowModel: getCoreRowModel() })
  const counts = list.data?.counts ?? {}
  const seats = list.data?.seats ?? null
  const expiringSoon = rows.filter(
    (r) => r.status === "invitada" && r.inviteExpiresAt && new Date(r.inviteExpiresAt).getTime() - now.getTime() <= 3 * 86_400_000,
  ).length

  return (
    <PageShell className="space-y-5">
      <PageHeader
        title="Lista de espera"
        subtitle={
          list.data ? (
            <>
              Clínicas que pidieron entrar. Se responde en {list.data.answerDays}{" "}
              {list.data.answerDays === 1 ? "día hábil" : "días hábiles"}. Alta de clínicas:{" "}
              {list.data.mode === "invitacion" ? "solo con invitación" : "abierta"}
              {isAdmin ? (
                <>
                  {" · "}
                  <Link to="/billing" hash="alta" className="font-medium text-primary underline">
                    Cambiar
                  </Link>
                </>
              ) : null}
            </>
          ) : (
            "Clínicas que pidieron entrar."
          )
        }
      />
      {list.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiCard title="Por revisar" value={counts.por_revisar ?? 0} />
          <KpiCard
            title={seats ? "Lugares usados" : "Lugares por invitación"}
            value={seats ? (seats.limit === null ? `${seats.used}` : `${seats.used} de ${seats.limit}`) : "—"}
          />
          <KpiCard title={status === "invitada" ? "Invitaciones por vencer" : "Invitadas"} value={status === "invitada" ? expiringSoon : (counts.invitada ?? 0)} />
        </div>
      ) : null}
      {list.data && !seats ? (
        <PageNotice tone="aviso" label="Sin plan por invitación">
          Para invitar hace falta un plan con lugares (por ejemplo, Fundadores).{" "}
          {isAdmin ? (
            <Link to="/billing" hash="planes" className="font-medium underline">
              Crearlo en Cobros y planes
            </Link>
          ) : (
            "Pídeselo a la administración."
          )}
        </PageNotice>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="espera-estado">Estado</FieldLabel>
          <Select
            value={status}
            items={Object.fromEntries(STATUSES.map((s) => [s, s === "todas" ? STATUS_LABEL[s] : `${STATUS_LABEL[s]} ${counts[s] ?? 0}`]))}
            onValueChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, estado: value === "por_revisar" || !value ? undefined : (value as StatusFilter) }),
              })
            }
          >
            <SelectTrigger id="espera-estado" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "todas" ? STATUS_LABEL[value] : `${STATUS_LABEL[value]} ${counts[value] ?? 0}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SearchInput
          placeholder="Buscar por clínica, nombre o correo"
          isFetching={list.isFetching && !list.isPending}
          className="w-full sm:w-80"
        />
      </div>

      {list.isPending ? (
        <DataTableSkeleton columnCount={7} rowCount={4} label="Cargando las solicitudes" />
      ) : list.isError && !list.data ? (
        <ErrorState
          title="No pude cargar la lista de espera"
          error={list.error instanceof ApiError ? list.error.shape : list.error}
          onRetry={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        <ListEmpty status={status} searched={Boolean(search.q)} />
      ) : (
        <>
          <DataTable
            table={table}
            onRowClick={(r) => open(r.id)}
            isRowActive={(r) => r.id === search.solicitud}
            isFetching={list.isFetching}
          />
          {status === "por_revisar" ? (
            <p className="text-sm text-muted-foreground">
              Primero las que vencen antes. En «Invitadas» se ve cuándo vence cada invitación, con «Reenviar».
            </p>
          ) : null}
        </>
      )}

      {search.solicitud ? (
        <RequestDrawer
          // Cada solicitud abre su propio cajón: la nota y el enlace no pasan de una a otra.
          key={search.solicitud}
          item={rows.find((r) => r.id === search.solicitud) ?? null}
          isLoading={list.isPending}
          isAdmin={isAdmin}
          seats={seats}
          onClose={() => open(undefined)}
        />
      ) : null}
    </PageShell>
  )
}

function ListEmpty({ status, searched }: { status: StatusFilter; searched: boolean }) {
  const navigate = useNavigate({ from: Route.fullPath })
  if (searched) {
    return (
      <EmptyState
        title="Ninguna solicitud con esa búsqueda"
        description="Busca por nombre de la clínica, de quien pidió o por su correo."
        actionLabel="Quitar la búsqueda"
        onAction={() => void navigate({ search: (prev) => ({ ...prev, q: undefined }) })}
      />
    )
  }
  return (
    <EmptyState
      icon={ListChecks}
      title={status === "por_revisar" ? "No hay solicitudes por revisar" : `No hay solicitudes en «${STATUS_LABEL[status]}»`}
      description="Llegan desde «Pide tus USD 100» de la web. Cada una aparece aquí con su plazo para responder."
      learnMoreLabel="Ver el formulario en la web"
      learnMoreHref={webUrl("/solicitar-invitacion")}
    />
  )
}

function RequestDrawer({
  item,
  isLoading,
  isAdmin,
  seats,
  onClose,
}: {
  item: Row | null
  isLoading: boolean
  isAdmin: boolean
  seats: z.infer<typeof pagePayload>["seats"]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // Sin tocar, la nota es la guardada (aunque la lista llegue después de abrir el cajón).
  const [edited, setNote] = React.useState<string | null>(null)
  const note = edited ?? item?.note ?? ""
  const [confirmInvite, setConfirmInvite] = React.useState(false)
  const [discarding, setDiscarding] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [lastLink, setLastLink] = React.useState<string | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "waitlist"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }
  const saveNote = useMutation({
    mutationFn: async () =>
      api(`/api/admin/waitlist/${item?.id}/note`, { method: "PUT", body: JSON.stringify({ note: note.trim() || null }) }),
    onSuccess: () => {
      refresh()
      toast.success("Nota guardada")
    },
  })
  const invite = useMutation({
    mutationFn: async (send: boolean) =>
      invitePayload.parse(await api(`/api/admin/waitlist/${item?.id}/invite`, { method: "POST", body: JSON.stringify({ send }) })),
    onSuccess: async (result, send) => {
      setConfirmInvite(false)
      setLastLink(result.url)
      refresh()
      if (send) {
        if (result.emailSent) toast.success(`Invitación enviada a ${item?.email}`)
        return
      }
      try {
        await navigator.clipboard.writeText(result.url)
        toast.success("Enlace copiado: pégalo en WhatsApp")
      } catch {
        toast.message("Copia el enlace de abajo y pégalo en WhatsApp")
      }
    },
    onError: () => setConfirmInvite(false),
  })
  const discard = useMutation({
    mutationFn: async () => api(`/api/admin/waitlist/${item?.id}/discard`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }),
    onSuccess: () => {
      setDiscarding(false)
      setReason("")
      refresh()
      onClose()
      toast.success("Solicitud descartada")
    },
  })

  const now = new Date()
  const seatsFull = seats?.limit !== null && seats !== null && seats.used >= (seats.limit ?? Number.POSITIVE_INFINITY)
  const holdsSeat = item?.status === "invitada" && item.inviteExpiresAt !== null && new Date(item.inviteExpiresAt) > now
  const canInvite = isAdmin && item !== null && (item.status === "por_revisar" || item.status === "invitada") && seats !== null && (!seatsFull || holdsSeat)
  const nextSeat = seats ? seats.used + (holdsSeat ? 0 : 1) : null
  const noteDirty = (note.trim() || null) !== (item?.note ?? null)

  return (
    <DetailDrawer
      open
      size="lg"
      onClose={onClose}
      isDirty={noteDirty || reason.trim().length > 0}
      isSubmitting={invite.isPending || discard.isPending}
      title={item?.clinicName ?? "Solicitud"}
      isLoading={isLoading}
      error={!isLoading && !item ? "No encuentro esa solicitud en esta lista. Cambia el estado o búscala por nombre." : null}
      headerContent={
        item ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{ONE_LABEL[item.status]}</Badge>
            <span>Pidió {askedText(item.createdAt, now)}</span>
            <Deadline item={item} now={now} />
          </div>
        ) : undefined
      }
      actions={
        item && isAdmin && item.status !== "entro" && item.status !== "descartada" ? (
          <div className="flex w-full items-center justify-between gap-3">
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => setDiscarding(true)}>
              Descartar…
            </Button>
            <span className="text-sm text-muted-foreground">Descartar pide un motivo; no se le avisa.</span>
          </div>
        ) : undefined
      }
    >
      {item ? (
        <div className="flex flex-col gap-6">
          <DetailSection title="Quién pidió">
            <DetailList>
              <DetailField label="Quién">
                {item.firstName} {item.lastName}
              </DetailField>
              <DetailField label="Dónde">
                {item.city}, {countryName(item.countryCode)}
              </DetailField>
              <DetailField label="Correo">{item.email}</DetailField>
              <DetailField label="Celular">
                <a className="underline" href={`https://wa.me/${item.phone.replace(/^\+/, "")}`} target="_blank" rel="noreferrer">
                  {item.phone}
                </a>
              </DetailField>
              <DetailField label="Odontólogos">{DENTISTS_LABEL[item.dentists] ?? item.dentists}</DetailField>
              <DetailField label="Usan hoy">{TOOL_LABEL[item.currentTool] ?? item.currentTool}</DetailField>
            </DetailList>
          </DetailSection>

          <DetailSection title="Nota del equipo">
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="espera-nota" className="sr-only">
                Nota del equipo
              </FieldLabel>
              <Textarea id="espera-nota" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
              <div>
                <SubmitButton variant="outline" size="sm" pending={saveNote.isPending} disabled={!noteDirty} onClick={() => saveNote.mutate()}>
                  Guardar nota
                </SubmitButton>
              </div>
              {saveNote.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se guardó la nota. Tu texto sigue aquí.
                </p>
              ) : null}
            </div>
          </DetailSection>

          {item.status === "entro" ? (
            <DetailSection title="Entró">
              <p className="text-sm">
                Abrió{" "}
                {item.organizationId ? (
                  <Link to="/organizations" search={{ org: item.organizationId }} className="font-medium underline">
                    {item.organizationName ?? "su clínica"}
                  </Link>
                ) : (
                  "su clínica"
                )}{" "}
                el {item.enteredAt ? formatDay(item.enteredAt) : "—"}, con el plan {item.planName ?? "de la invitación"}.
              </p>
            </DetailSection>
          ) : item.status === "descartada" ? (
            <DetailSection title="Descartada">
              <p className="text-sm">
                {item.discardReason}
                {item.decidedByName ? ` · ${item.decidedByName}` : ""}
              </p>
            </DetailSection>
          ) : (
            <DetailSection title={item.status === "invitada" ? "Invitación" : "Invitar como Fundador"}>
              <div className="flex flex-col gap-3">
                {seats ? (
                  <p className="text-sm text-muted-foreground">
                    {item.status === "invitada" && item.inviteExpiresAt
                      ? `Invitada con ${item.planName ?? seats.planName}. ${
                          new Date(item.inviteExpiresAt) > now ? "Vence" : "Venció"
                        } el ${formatDay(item.inviteExpiresAt)}. Reenviar da un enlace nuevo de 14 días y anula el anterior.`
                      : `Entra con el plan ${seats.planName}. La invitación vale para ${item.email} y vence a los 14 días.${
                          seats.limit !== null && nextSeat !== null ? ` Le toca el lugar ${nextSeat} de ${seats.limit}.` : ""
                        }`}
                  </p>
                ) : null}
                {seatsFull && !holdsSeat ? (
                  <PageNotice tone="alarma" label="Lugares completos">
                    Los {seats?.limit} lugares de {seats?.planName} están ocupados. Para invitar, sube los lugares del plan en Cobros y planes.
                  </PageNotice>
                ) : null}
                {isAdmin ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={!canInvite} onClick={() => setConfirmInvite(true)}>
                      {item.status === "invitada" ? "Reenviar por correo…" : "Enviar invitación…"}
                    </Button>
                    <SubmitButton variant="outline" pending={invite.isPending && invite.variables === false} disabled={!canInvite} onClick={() => invite.mutate(false)}>
                      Copiar enlace para WhatsApp
                    </SubmitButton>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Invita la administración de odentIA.</p>
                )}
                {lastLink ? (
                  <p className="break-all rounded-lg bg-muted px-3 py-2 text-xs" aria-live="polite">
                    {lastLink}
                  </p>
                ) : null}
                {invite.data?.emailSent === false && invite.variables === true ? (
                  <PageNotice tone="alarma" label="Correo sin enviar">
                    La invitación quedó lista, pero el correo no salió. Copia el enlace y envíaselo por WhatsApp.
                  </PageNotice>
                ) : null}
                {invite.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {invite.error instanceof ApiError ? invite.error.message : "No se pudo invitar. Inténtalo de nuevo."}
                  </p>
                ) : null}
              </div>
            </DetailSection>
          )}

          <ConfirmDialog
            open={confirmInvite}
            title={`¿Enviar la invitación a ${item.email}?`}
            description={`Le llega un correo con «Crear mi cuenta». Con ese enlace abre una sola clínica, con el plan ${seats?.planName ?? "por invitación"}. Vale 14 días${
              item.status === "invitada" ? " y anula el enlace anterior" : ""
            }.`}
            confirmLabel="Enviar invitación"
            variant="default"
            cancelLabel="Seguir revisando"
            pending={invite.isPending}
            onConfirm={() => invite.mutate(true)}
            onClose={() => setConfirmInvite(false)}
          />
          <ConfirmDialog
            open={discarding}
            title={`¿Descartar la solicitud de ${item.clinicName}?`}
            description="Sale de la lista y, si tenía una invitación, deja de servir. No se le avisa."
            confirmLabel="Descartar"
            cancelLabel="Volver"
            pending={discard.isPending}
            confirmDisabled={reason.trim().length === 0}
            onConfirm={() => discard.mutate()}
            onClose={() => setDiscarding(false)}
          >
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="espera-motivo">Motivo</FieldLabel>
              <Textarea id="espera-motivo" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
              {discard.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {discard.error instanceof ApiError ? discard.error.message : "No se pudo descartar."}
                </p>
              ) : null}
            </div>
          </ConfirmDialog>
        </div>
      ) : null}
    </DetailDrawer>
  )
}
