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
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table"
import { BookOpen, CircleAlert, Clock } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { webUrl } from "../../lib/host"

type StatusFilter = "recibido" | "respondido" | "todas"

interface ComplaintsSearch {
  estado?: StatusFilter
  q?: string
  hoja?: string
}

export const Route = createFileRoute("/_app/complaints")({
  validateSearch: (search: Record<string, unknown>): ComplaintsSearch => ({
    ...(search.estado === "respondido" || search.estado === "todas" ? { estado: search.estado } : {}),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    ...(typeof search.hoja === "string" ? { hoja: search.hoja } : {}),
  }),
  component: ComplaintsPage,
})

const STATUS_LABEL: Record<StatusFilter, string> = {
  recibido: "Por responder",
  respondido: "Respondidas",
  todas: "Todas",
}
const KIND_LABEL: Record<string, string> = { reclamo: "Reclamo", queja: "Queja" }
const DOCUMENT_LABEL: Record<string, string> = {
  DNI: "DNI",
  CE: "Carné de extranjería",
  PASAPORTE: "Pasaporte",
}
const RESPONSE_LIMIT = 3000

const timeline = z.object({
  dueDate: z.string(),
  daysLeft: z.number(),
  overdue: z.boolean(),
  respondedOnTime: z.boolean().nullable(),
})
const listItem = z.object({
  id: z.string(),
  number: z.string(),
  createdAt: z.string(),
  kind: z.string(),
  consumerName: z.string(),
  status: z.enum(["recibido", "respondido"]),
  respondedAt: z.string().nullable(),
  responseEmailSent: z.boolean(),
  timeline,
})
type ListItem = z.infer<typeof listItem>
const summary = z.object({ pending: z.number(), dueSoon: z.number(), overdue: z.number() })
const listPayload = z.object({ items: z.array(listItem), total: z.number(), summary })
const detailPayload = listItem.extend({
  consumerAddress: z.string(),
  documentType: z.string(),
  documentNumber: z.string(),
  phone: z.string(),
  email: z.string(),
  isMinor: z.boolean(),
  guardianName: z.string().nullable(),
  itemType: z.string(),
  itemDescription: z.string(),
  amountMinor: z.number().nullable(),
  amountCurrency: z.string().nullable(),
  detail: z.string(),
  request: z.string(),
  providerResponse: z.string().nullable(),
  respondedByName: z.string().nullable(),
  emailSent: z.boolean(),
})
type Detail = z.infer<typeof detailPayload>

const LIMA = "America/Lima"
/** «vie 16 oct 2026»: el plazo y las hojas se leen en el día de Lima. */
const dayFormat = new Intl.DateTimeFormat("es-PE", {
  timeZone: LIMA,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
})
const longFormat = new Intl.DateTimeFormat("es-PE", {
  timeZone: LIMA,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})
const clean = (text: string) => text.replaceAll(".", "").replace(",", "")
const formatDay = (iso: string) => clean(dayFormat.format(new Date(iso)))
/** Un día civil ISO («2026-10-23») sin correrlo por la zona del navegador. */
const formatDueDay = (day: string) =>
  clean(
    new Intl.DateTimeFormat("es-PE", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date(`${day}T12:00:00Z`)),
  )

function amountOf(detail: Detail): string {
  if (detail.amountMinor === null || !detail.amountCurrency) return "No indicado"
  const symbol = detail.amountCurrency === "PEN" ? "S/" : detail.amountCurrency
  return `${symbol} ${(detail.amountMinor / 100).toFixed(2)}`
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Cómo va el plazo, en palabras y con su tono. */
function deadlineOf(item: Pick<ListItem, "status" | "timeline">): {
  text: string
  short: string
  tone: "destructive" | "warning" | "muted" | "success"
} {
  const t = item.timeline
  if (item.status === "respondido") {
    return t.respondedOnTime
      ? { text: "Respondida dentro del plazo", short: "A tiempo", tone: "success" }
      : { text: "Respondida fuera del plazo", short: "Fuera de plazo", tone: "warning" }
  }
  if (t.overdue) {
    return { text: `Venció el ${formatDueDay(t.dueDate)}`, short: "Venció", tone: "destructive" }
  }
  if (t.daysLeft === 0) {
    return { text: `Vence hoy (${formatDueDay(t.dueDate)})`, short: "Vence hoy", tone: "destructive" }
  }
  const left = `Quedan ${t.daysLeft} ${plural(t.daysLeft, "día hábil", "días hábiles")}`
  return {
    text: `${left} · vence ${formatDueDay(t.dueDate)}`,
    short: `Quedan ${t.daysLeft} ${plural(t.daysLeft, "día", "días")}`,
    tone: t.daysLeft <= 5 ? "warning" : "muted",
  }
}

function DeadlineBadge({ item, short = false }: { item: ListItem; short?: boolean }) {
  const deadline = deadlineOf(item)
  const label = short ? deadline.short : deadline.text
  if (deadline.tone === "muted") {
    return <span className="text-sm text-muted-foreground">{label}</span>
  }
  const Icon = deadline.tone === "destructive" ? CircleAlert : Clock
  return (
    <Badge variant={deadline.tone}>
      {deadline.tone === "success" ? null : <Icon aria-hidden />}
      {label}
    </Badge>
  )
}

function StatusBadge({ item }: { item: Pick<ListItem, "status" | "responseEmailSent"> }) {
  if (item.status === "recibido") return <Badge variant="secondary">Por responder</Badge>
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant="success">Respondida</Badge>
      {item.responseEmailSent ? null : <Badge variant="warning">Correo sin enviar</Badge>}
    </span>
  )
}

/** Borrador por hoja en este equipo: cambiar de hoja o recargar no lo pierde. */
const draftKey = (id: string) => `odentia.admin.complaint-draft.${id}`
function readDraft(id: string): string {
  try {
    return window.localStorage.getItem(draftKey(id)) ?? ""
  } catch {
    return ""
  }
}
function writeDraft(id: string, text: string) {
  try {
    if (text) window.localStorage.setItem(draftKey(id), text)
    else window.localStorage.removeItem(draftKey(id))
  } catch {
    // Sin almacenamiento el borrador vive mientras la hoja siga abierta.
  }
}

function ComplaintsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const status: StatusFilter = search.estado ?? "recibido"
  const list = useQuery({
    queryKey: ["admin", "complaints", status, search.q ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams({ status, limit: "100" })
      if (search.q) params.set("q", search.q)
      return listPayload.parse(await api(`/api/admin/consumer-complaints?${params}`))
    },
  })
  // La tabla necesita referencias estables (ver la lista de espera): sin datos, la misma lista vacía.
  const items = React.useMemo(() => list.data?.items ?? [], [list.data?.items])
  const open = (id: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, hoja: id }), replace: true })

  // Con la hoja abierta al lado, la lista se acorta a número, nombre y plazo.
  const compact = Boolean(search.hoja)
  const columns = React.useMemo<ColumnDef<ListItem>[]>(
    () => [
      {
        id: "number",
        header: "N.º",
        cell: ({ row }) => <span className="font-semibold tabular-nums">{row.original.number}</span>,
        meta: { view: { role: "title" } },
      },
      {
        id: "createdAt",
        header: "Recibida",
        cell: ({ row }) => formatDay(row.original.createdAt),
      },
      {
        id: "kind",
        header: "Tipo",
        cell: ({ row }) => KIND_LABEL[row.original.kind] ?? row.original.kind,
      },
      {
        id: "consumerName",
        header: "Quién reclama",
        cell: ({ row }) => row.original.consumerName,
        meta: { view: { primary: true } },
      },
      {
        id: "status",
        header: "Estado",
        cell: ({ row }) => <StatusBadge item={row.original} />,
      },
      {
        id: "deadline",
        header: "Plazo",
        cell: ({ row }) => <DeadlineBadge item={row.original} short={compact} />,
        meta: { view: { primary: true } },
      },
    ],
    [compact],
  )
  const columnVisibility = React.useMemo(
    (): VisibilityState => (compact ? { createdAt: false, kind: false, status: false } : {}),
    [compact],
  )
  const table = useReactTable({
    data: items,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <PageShell className="space-y-5">
      <PageHeader
        title="Libro de Reclamaciones"
        subtitle="Las hojas que llegan desde las webs de odentIA y latidIA. Cada una se responde por correo en un plazo de 15 días hábiles que no se puede ampliar."
      />
      {list.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiCard title="Por responder" value={list.data.summary.pending} />
          <KpiCard title="Vencen en 5 días hábiles o menos" value={list.data.summary.dueSoon} />
          <KpiCard title="Plazo vencido" value={list.data.summary.overdue} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="libro-estado">Estado</FieldLabel>
          <Select
            value={status}
            items={STATUS_LABEL}
            onValueChange={(value) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  estado: value === "recibido" || !value ? undefined : (value as StatusFilter),
                }),
              })
            }
          >
            <SelectTrigger id="libro-estado" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SearchInput
          placeholder="Buscar por número, nombre o documento"
          isFetching={list.isFetching && !list.isPending}
          className="w-full sm:w-96"
        />
      </div>

      {list.isPending ? (
        <DataTableSkeleton columnCount={6} rowCount={4} label="Cargando las hojas" />
      ) : list.isError && !list.data ? (
        <ErrorState
          title="No pude cargar las hojas"
          error={list.error instanceof ApiError ? list.error.shape : list.error}
          onRetry={() => void list.refetch()}
        />
      ) : items.length === 0 ? (
        <ListEmpty status={status} searched={Boolean(search.q)} />
      ) : (
        <>
          <DataTable
            table={table}
            onRowClick={(row) => open(row.id)}
            isRowActive={(row) => row.id === search.hoja}
            isFetching={list.isFetching}
          />
          {status === "recibido" ? (
            <p className="text-sm text-muted-foreground">
              Primero las que vencen antes. Las respondidas se ven al elegir «Respondidas» o «Todas»
              en Estado.
            </p>
          ) : null}
        </>
      )}

      {search.hoja ? <ComplaintDrawer id={search.hoja} onClose={() => open(undefined)} /> : null}
    </PageShell>
  )
}

function ListEmpty({ status, searched }: { status: StatusFilter; searched: boolean }) {
  const navigate = useNavigate({ from: Route.fullPath })
  if (searched) {
    return (
      <EmptyState
        title="Ninguna hoja con esa búsqueda"
        description="Busca por número de hoja, nombre o documento de quien reclamó."
        actionLabel="Quitar la búsqueda"
        onAction={() => void navigate({ search: (prev) => ({ ...prev, q: undefined }) })}
      />
    )
  }
  if (status === "recibido") {
    return (
      <EmptyState
        icon={BookOpen}
        title="No hay hojas por responder"
        description="Las que llegan desde el formulario de la web aparecen aquí con su plazo de 15 días hábiles."
        actionLabel="Ver las respondidas"
        onAction={() => void navigate({ search: (prev) => ({ ...prev, estado: "respondido" }) })}
        learnMoreLabel="Ver el formulario en la web"
        learnMoreHref={webUrl("/pe/libro-de-reclamaciones")}
      />
    )
  }
  return (
    <EmptyState
      icon={BookOpen}
      title={status === "respondido" ? "Aún no hay hojas respondidas" : "Aún no hay hojas de reclamación"}
      description="Llegan desde el formulario de la web. Cuando alguien envía una, aparece aquí y llega el aviso al buzón de reclamos."
      learnMoreLabel="Ver el formulario en la web"
      learnMoreHref={webUrl("/pe/libro-de-reclamaciones")}
    />
  )
}

function ComplaintDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ["admin", "complaint", id],
    queryFn: async () => detailPayload.parse(await api(`/api/admin/consumer-complaints/${id}`)),
  })
  const [draft, setDraft] = React.useState(() => readDraft(id))
  const [confirming, setConfirming] = React.useState(false)
  React.useEffect(() => setDraft(readDraft(id)), [id])

  const refresh = (sheet: Detail) => {
    queryClient.setQueryData(["admin", "complaint", id], sheet)
    void queryClient.invalidateQueries({ queryKey: ["admin", "complaints"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "complaints-summary"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }
  const respond = useMutation({
    mutationFn: async (response: string) =>
      detailPayload.parse(
        await api(`/api/admin/consumer-complaints/${id}/response`, {
          method: "POST",
          body: JSON.stringify({ response }),
        }),
      ),
    onSuccess: (sheet) => {
      writeDraft(id, "")
      setDraft("")
      setConfirming(false)
      refresh(sheet)
      if (sheet.responseEmailSent) toast.success(`Respuesta enviada a ${sheet.email}`)
    },
    onError: (error) => {
      setConfirming(false)
      // Otra persona respondió antes: se muestra su respuesta y el texto queda en el borrador.
      if (error instanceof ApiError && error.status === 409) void detail.refetch()
    },
  })
  const resend = useMutation({
    mutationFn: async () =>
      detailPayload.parse(
        await api(`/api/admin/consumer-complaints/${id}/response-email`, { method: "POST" }),
      ),
    onSuccess: (sheet) => {
      refresh(sheet)
      if (sheet.responseEmailSent) toast.success(`Respuesta enviada a ${sheet.email}`)
    },
  })

  const sheet = detail.data
  const firstName = sheet?.consumerName.split(" ")[0] ?? ""
  const tooShort = draft.trim().length < 10

  return (
    <DetailDrawer
      open
      size="lg"
      onClose={onClose}
      isDirty={sheet?.status === "recibido" && draft.trim().length > 0}
      isSubmitting={respond.isPending}
      title={sheet ? `Hoja N.º ${sheet.number}` : "Hoja de reclamación"}
      isLoading={detail.isPending}
      error={detail.isError ? "No pude abrir la hoja. Cierra y vuelve a intentarlo." : null}
      headerContent={
        sheet ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{KIND_LABEL[sheet.kind] ?? sheet.kind}</Badge>
              <StatusBadge item={sheet} />
              <DeadlineBadge item={sheet} />
            </div>
            <p className="text-sm text-muted-foreground">
              Recibida el {longFormat.format(new Date(sheet.createdAt))} (hora de Lima).{" "}
              {sheet.emailSent
                ? "La persona recibió su copia por correo."
                : "Su copia por correo no salió."}
            </p>
          </div>
        ) : undefined
      }
    >
      {sheet ? (
        <div className="flex flex-col gap-6">
          <DetailSection title="1 · Quién reclama">
            <DetailList>
              <DetailField label="Nombre">{sheet.consumerName}</DetailField>
              <DetailField label="Documento">
                {DOCUMENT_LABEL[sheet.documentType] ?? sheet.documentType} {sheet.documentNumber}
              </DetailField>
              <DetailField label="Domicilio">{sheet.consumerAddress}</DetailField>
              <DetailField label="Teléfono">{sheet.phone}</DetailField>
              <DetailField label="Correo">{sheet.email}</DetailField>
              {sheet.isMinor ? (
                <DetailField label="Padre, madre o apoderado">{sheet.guardianName}</DetailField>
              ) : null}
            </DetailList>
          </DetailSection>
          <DetailSection title="2 · Lo que contrató">
            <DetailList>
              <DetailField label="Tipo">{sheet.itemType === "producto" ? "Producto" : "Servicio"}</DetailField>
              <DetailField label="Monto reclamado">{amountOf(sheet)}</DetailField>
              <DetailField label="Descripción" className="@md:col-span-2">
                {sheet.itemDescription}
              </DetailField>
            </DetailList>
          </DetailSection>
          <DetailSection title="3 · Detalle y pedido">
            <DetailList columns={1}>
              <DetailField label="Detalle">
                <span className="whitespace-pre-wrap">{sheet.detail}</span>
              </DetailField>
              <DetailField label="Pedido">
                <span className="whitespace-pre-wrap">{sheet.request}</span>
              </DetailField>
            </DetailList>
          </DetailSection>

          {sheet.status === "respondido" ? (
            <DetailSection title="4 · Nuestra respuesta">
              <div className="flex flex-col gap-3">
                <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
                  {sheet.providerResponse}
                </p>
                <DetailList>
                  <DetailField label="Respondió">
                    {sheet.respondedByName ?? "Una persona del equipo"}
                    {sheet.respondedAt ? `, el ${longFormat.format(new Date(sheet.respondedAt))}` : ""}
                  </DetailField>
                  <DetailField label="Correo">
                    {sheet.responseEmailSent ? `Enviado a ${sheet.email}` : "Sin enviar"}
                  </DetailField>
                </DetailList>
                {sheet.responseEmailSent ? (
                  <p className="text-sm text-muted-foreground">
                    Ya no se puede cambiar. Queda en el libro tal como se envió.
                  </p>
                ) : (
                  <PageNotice
                    tone="alarma"
                    label="Correo sin enviar"
                    action={
                      <SubmitButton
                        variant="outline"
                        size="sm"
                        pending={resend.isPending}
                        onClick={() => resend.mutate()}
                      >
                        Reenviar el correo
                      </SubmitButton>
                    }
                  >
                    La respuesta quedó guardada, pero el correo a {firstName} no salió. No lo
                    reintentamos solos para no mandarle dos correos. También puedes llamar al{" "}
                    {sheet.phone}.
                  </PageNotice>
                )}
                {resend.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {resend.error instanceof Error ? resend.error.message : "No se pudo reenviar."}
                  </p>
                ) : null}
              </div>
            </DetailSection>
          ) : (
            <DetailSection title="4 · Nuestra respuesta">
              <div className="flex flex-col gap-2">
                <FieldLabel htmlFor="libro-respuesta">Qué hicimos y qué le respondemos</FieldLabel>
                <p className="text-sm text-muted-foreground" id="libro-respuesta-ayuda">
                  Escríbele a {firstName} directamente. Le llega por correo junto con su hoja completa
                  y queda en el libro.
                </p>
                <Textarea
                  id="libro-respuesta"
                  aria-describedby="libro-respuesta-ayuda"
                  rows={8}
                  maxLength={RESPONSE_LIMIT}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    writeDraft(id, event.target.value)
                  }}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{draft ? "Borrador guardado en este equipo" : ""}</span>
                  <span aria-live="polite">
                    {draft.length} / {RESPONSE_LIMIT}
                  </span>
                </div>
                {respond.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {respond.error instanceof ApiError && respond.error.status === 409
                      ? `${respond.error.message}. Tu texto sigue aquí por si lo necesitas.`
                      : "No se guardó la respuesta y no se envió nada. Tu texto sigue en el formulario."}
                  </p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <Button type="button" disabled={tooShort} onClick={() => setConfirming(true)}>
                    Enviar respuesta…
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {tooShort ? "Escribe al menos 10 caracteres." : "Te pedimos confirmar antes de enviar."}
                  </span>
                </div>
              </div>
            </DetailSection>
          )}

          <ConfirmDialog
            open={confirming}
            title={`¿Enviar la respuesta a ${sheet.consumerName}?`}
            description={`Se guarda en la hoja N.º ${sheet.number}, pasa a «Respondida» y le llega a ${sheet.email} con su hoja completa. Después no se puede cambiar ni borrar: queda en el libro tal como la envías.`}
            confirmLabel="Enviar respuesta"
            variant="default"
            cancelLabel="Seguir revisando"
            pending={respond.isPending}
            onConfirm={() => respond.mutate(draft.trim())}
            onClose={() => setConfirming(false)}
          >
            <p className="line-clamp-4 whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm">
              {draft.trim()}
            </p>
          </ConfirmDialog>
        </div>
      ) : null}
    </DetailDrawer>
  )
}
