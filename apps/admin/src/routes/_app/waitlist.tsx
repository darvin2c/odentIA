import {
  Badge,
  Button,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  ConfirmDialog,
  DataTable,
  DatePickerButton,
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
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct, productWords, upperFirst } from "@odentia/clinical"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable, type VisibilityState } from "@tanstack/react-table"
import { CircleAlert, ListChecks } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { countByProduct, matchesProduct, perProduct, type ProductChoice, ProductFilter, ProductMark } from "../../components/product"
import { webUrl } from "../../lib/host"
import { KpiSkeleton } from "../../components/skeletons/page-loading"
import { WaitlistPageSkeleton, WaitlistSkeleton } from "../../components/skeletons/waitlist"

/** Lo anotado y el motivo de descartar, con los mismos límites que la ruta. */
const followUpSchema = z.object({
  body: z.string().trim().min(1, "Escribe qué pasó").max(2000, "Usa como máximo 2000 caracteres"),
  adminOnly: z.boolean(),
})
const discardSchema = z.object({
  reason: z.string().trim().min(1, "Escribe por qué se descarta").max(500, "Usa como máximo 500 caracteres"),
})

/**
 * Las etapas las calcula el servidor al leer (nadie las mueve a mano): la
 * invitación que vence pasa sola a «Invitación vencida» y la clínica con un
 * pago confirmado, a «Paga».
 */
const STAGES = ["por_revisar", "invitada", "invitacion_vencida", "entro", "paga", "descartada"] as const
type Stage = (typeof STAGES)[number]
type StageFilter = Stage | "todas"
const STAGE_FILTERS: StageFilter[] = [...STAGES, "todas"]
const isStageFilter = (value: unknown): value is StageFilter => typeof value === "string" && (STAGE_FILTERS as string[]).includes(value)

interface WaitlistSearch {
  etapa?: StageFilter
  producto?: ClinicalProduct
  q?: string
  solicitud?: string
}

export const Route = createFileRoute("/_app/waitlist")({
  validateSearch: (search: Record<string, unknown>): WaitlistSearch => {
    // `estado` es el nombre de antes: un enlace guardado con «?estado=entro» abre esa etapa.
    const etapa = isStageFilter(search.etapa) ? search.etapa : isStageFilter(search.estado) ? search.estado : undefined
    return {
      ...(etapa && etapa !== "por_revisar" ? { etapa } : {}),
      ...(isClinicalProduct(search.producto) ? { producto: search.producto } : {}),
      // Un enlace con «?q=987654321» llega como número: también es una búsqueda.
      ...((typeof search.q === "string" && search.q) || typeof search.q === "number" ? { q: String(search.q) } : {}),
      ...(typeof search.solicitud === "string" ? { solicitud: search.solicitud } : {}),
    }
  },
  pendingComponent: WaitlistPageSkeleton,
  component: WaitlistPage,
})

const appRoute = getRouteApi("/_app")

const STAGE_LABEL: Record<StageFilter, string> = {
  por_revisar: "Por revisar",
  invitada: "Invitada",
  invitacion_vencida: "Invitación vencida",
  entro: "Entró",
  paga: "Paga",
  descartada: "Descartada",
  todas: "Todas",
}
/** Lo que quiere decir cada etapa que no se explica sola. */
const STAGE_HELP: Partial<Record<Stage, string>> = {
  invitacion_vencida: "Su enlace de 14 días ya pasó y no entró. Toca reenviar.",
  entro: "Abrió su clínica y aún no registramos un pago suyo.",
  paga: "Ya registramos al menos un pago suyo.",
}
const PROFESSIONALS_LABEL: Record<string, string> = { "1": "1", "2-3": "2 a 3", "4-9": "4 a 9", "10+": "10 o más" }
const TOOL_LABEL: Record<string, string> = {
  nada: "Nada",
  cuaderno_excel: "Cuaderno o Excel",
  otro_software: "Otro software",
}

/** Qué le toca al equipo, como lo dice el servidor (`waitlistAnswer`): los días son de Lima. */
const answerShape = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("por_responder"), due: z.enum(["vencida", "hoy", "hasta"]), by: z.string(), day: z.string() }),
    z.object({ kind: z.literal("contactada"), day: z.string() }),
    z.object({ kind: z.literal("volver"), day: z.string() }),
  ])
  .nullable()
const row = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  clinicName: z.string(),
  countryCode: z.string(),
  city: z.string(),
  professionals: z.string(),
  currentTool: z.string(),
  product: z.enum(CLINICAL_PRODUCTS),
  status: z.enum(["por_revisar", "invitada", "entro", "descartada"]),
  stage: z.enum(STAGES),
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
  answer: answerShape,
  nextFollowUpOn: z.string().nullable(),
})
type Row = z.infer<typeof row>
const seatsShape = z.object({ planId: z.string(), planName: z.string(), used: z.number(), limit: z.number().nullable() }).nullable()
const modeShape = z.enum(["invitacion", "abierta"])
// Lugares y alta de cada producto (ADR 0093): cada uno tiene su Fundadores.
const pagePayload = z.object({
  rows: z.array(row),
  counts: z.record(z.string(), z.number()),
  // Con su valor si falta: mientras se despliega, la API anterior aún no dice el producto nuevo.
  seats: perProduct(seatsShape.default(null)),
  modes: perProduct(modeShape.default("invitacion")),
  answerDays: z.number(),
  today: z.string(),
})
type Seats = z.infer<typeof seatsShape>
const seatsText = (seats: Seats) => (seats ? (seats.limit === null ? `${seats.used}` : `${seats.used} de ${seats.limit}`) : "—")
const invitePayload = z.object({ url: z.string(), expiresAt: z.string(), emailSent: z.boolean(), validDays: z.number() })
const entryShape = z.object({
  id: z.string(),
  authorName: z.string().nullable(),
  body: z.string().nullable(),
  followUpOn: z.string().nullable(),
  adminOnly: z.boolean(),
  createdAt: z.string(),
})
type Entry = z.infer<typeof entryShape>
const detailPayload = z.object({
  request: row,
  entries: z.array(entryShape),
  seats: seatsShape,
  choices: z.object({ today: z.string(), tomorrow: z.string(), inThreeBusinessDays: z.string(), nextWeek: z.string(), latest: z.string() }),
})

const dayFormat = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })
const timeFormat = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" })
const clean = (text: string) => text.replaceAll(".", "").replace(",", "")
const formatDay = (iso: string) => clean(dayFormat.format(new Date(iso)))
/** Un día de Lima («2026-11-12») como «jue 12 nov»: al mediodía, para que ninguna zona lo corra de día. */
const formatLimaDay = (day: string) => clean(dayFormat.format(new Date(`${day}T12:00:00`)))
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

/** «hoy, 09:40», «ayer, 16:20», «mar 10 nov, 10:54». */
function whenText(iso: string, now: Date): string {
  const date = new Date(iso)
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  const day = days <= 0 ? "hoy" : days === 1 ? "ayer" : formatDay(iso)
  return `${day}, ${timeFormat.format(date)}`
}

/**
 * El plazo de una solicitud, con las palabras del servidor: la misma frase en
 * la columna Plazo, la cabecera del cajón e Inicio. «Vence» queda solo para
 * las invitaciones.
 */
function deadlineOf(item: Row, today: string, now: Date): { text: string; tone: "destructive" | "warning" | "muted" } {
  if (item.status === "invitada" && item.inviteExpiresAt) {
    const expires = new Date(item.inviteExpiresAt)
    if (expires <= now) return { text: `La invitación venció el ${formatDay(item.inviteExpiresAt)}`, tone: "destructive" }
    const left = Math.ceil((expires.getTime() - now.getTime()) / 86_400_000)
    return { text: `La invitación vence el ${formatDay(item.inviteExpiresAt)}`, tone: left <= 3 ? "warning" : "muted" }
  }
  const answer = item.answer
  if (answer?.kind === "por_responder") {
    if (answer.due === "vencida") return { text: `Respuesta vencida el ${formatLimaDay(answer.day)}`, tone: "destructive" }
    if (answer.due === "hoy") return { text: "Responder hoy", tone: "destructive" }
    return { text: `Responder hasta el ${formatLimaDay(answer.day)}`, tone: "muted" }
  }
  if (answer?.kind === "volver") {
    return { text: `Volver a contactar: ${formatLimaDay(answer.day)}`, tone: answer.day <= today ? "destructive" : "muted" }
  }
  if (answer?.kind === "contactada") return { text: `Contactada el ${formatLimaDay(answer.day)}`, tone: "muted" }
  if (item.status === "entro" && item.enteredAt) return { text: `Entró el ${formatDay(item.enteredAt)}`, tone: "muted" }
  return { text: "—", tone: "muted" }
}

function Deadline({ item, today, now }: { item: Row; today: string; now: Date }) {
  const deadline = deadlineOf(item, today, now)
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
  const stage: StageFilter = search.etapa ?? "por_revisar"
  const product: ProductChoice = search.producto ?? "todos"
  const list = useQuery({
    queryKey: ["admin", "waitlist", stage, search.q ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams({ stage })
      if (search.q) params.set("q", search.q)
      return pagePayload.parse(await api(`/api/admin/waitlist?${params}`))
    },
  })
  const allRows = list.data?.rows ?? []
  // La tabla y los selectores de Base UI necesitan referencias estables: con
  // `data` o `state` nuevos en cada render, la página se redibuja sin fin
  // (se congela al poner el foco en el panel de la solicitud).
  const rows = React.useMemo(
    () => (list.data?.rows ?? []).filter((r) => matchesProduct(product, r.product)),
    [list.data?.rows, product],
  )
  const productCounts = countByProduct(allRows, (r) => r.product)
  const today = list.data?.today ?? ""
  // Abrir una solicitud no cambia la etapa ni el producto de la lista de detrás.
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
      { id: "product", header: "Producto", cell: ({ row: r }) => <ProductMark product={r.original.product} /> },
      { id: "where", header: "Dónde", cell: ({ row: r }) => `${r.original.city}, ${countryName(r.original.countryCode)}` },
      { id: "professionals", header: "Atienden", cell: ({ row: r }) => PROFESSIONALS_LABEL[r.original.professionals] ?? r.original.professionals },
      { id: "tool", header: "Usan hoy", cell: ({ row: r }) => TOOL_LABEL[r.original.currentTool] ?? r.original.currentTool },
      { id: "asked", header: "Pidió", cell: ({ row: r }) => askedText(r.original.createdAt, new Date()) },
      {
        id: "deadline",
        header: "Plazo",
        cell: ({ row: r }) => <Deadline item={r.original} today={today} now={new Date()} />,
        meta: { view: { primary: true } },
      },
    ],
    [today],
  )
  const columnVisibility = React.useMemo<VisibilityState>(
    (): VisibilityState =>
      compact ? { product: false, where: false, professionals: false, tool: false, asked: false, who: false } : {},
    [compact],
  )
  const table = useReactTable({ data: rows, columns, state: { columnVisibility }, getCoreRowModel: getCoreRowModel() })
  const counts = list.data?.counts ?? {}
  const stageText = (value: StageFilter) => `${STAGE_LABEL[value]} ${counts[value] ?? 0}`
  const stageItems = React.useMemo(
    () => Object.fromEntries(STAGE_FILTERS.map((s) => [s, `${STAGE_LABEL[s]} ${list.data?.counts[s] ?? 0}`])),
    [list.data?.counts],
  )
  // Los productos que se miran: todos en «Todos».
  const shown: readonly ClinicalProduct[] = product === "todos" ? CLINICAL_PRODUCTS : [product]
  const seatsOf = list.data?.seats
  const withoutSeats = seatsOf ? shown.filter((of) => !seatsOf[of]) : []

  return (
    <PageShell className="space-y-5">
      <PageHeader
        title="Lista de espera"
        subtitle={
          list.data ? (
            <>
              Clínicas que pidieron entrar. Se responde en {list.data.answerDays}{" "}
              {list.data.answerDays === 1 ? "día hábil" : "días hábiles"}. Alta de clínicas:{" "}
              {shown.map((of) => `${productWords(of).name} ${list.data.modes[of] === "invitacion" ? "solo con invitación" : "abierta"}`).join(" · ")}
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
      {/* Por revisar e Invitadas ya los dice el filtro «Etapa», con su número. */}
      {list.isPending ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiSkeleton title="Lugares usados" description />
        </div>
      ) : list.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {product !== "todos" ? (
            <KpiCard
              title={seatsOf?.[product] ? "Lugares usados" : "Lugares por invitación"}
              value={seatsText(seatsOf?.[product] ?? null)}
            />
          ) : (
            <KpiCard
              title="Lugares usados"
              value={shown.reduce<number>((sum, of) => sum + (seatsOf?.[of]?.used ?? 0), 0)}
              description={shown.map((of) => `${productWords(of).name} ${seatsText(seatsOf?.[of] ?? null)}`).join(" · ")}
            />
          )}
        </div>
      ) : null}
      {list.data && withoutSeats.length > 0 ? (
        <PageNotice tone="aviso" label="Sin plan por invitación">
          Para invitar a {withoutSeats.map((of) => productWords(of).name).join(" y ")} hace falta un plan con lugares de ese producto (por
          ejemplo, Fundadores).{" "}
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
          <FieldLabel htmlFor="espera-etapa">Etapa</FieldLabel>
          <Select
            value={stage}
            items={stageItems}
            onValueChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, etapa: value === "por_revisar" || !isStageFilter(value) ? undefined : value }),
              })
            }
          >
            <SelectTrigger id="espera-etapa" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGE_FILTERS.map((value) => {
                const help = value === "todas" ? undefined : STAGE_HELP[value]
                return (
                  <SelectItem key={value} value={value}>
                    <span className="flex flex-col gap-0.5">
                      <span>{stageText(value)}</span>
                      {help ? <span className="text-xs font-normal text-muted-foreground">{help}</span> : null}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </div>
        <SearchInput
          placeholder="Buscar por clínica, nombre o correo"
          isFetching={list.isFetching && !list.isPending}
          className="w-full sm:w-80"
        />
        <ProductFilter
          value={product}
          onChange={(value) => void navigate({ search: (prev) => ({ ...prev, producto: value === "todos" ? undefined : value }) })}
          counts={productCounts}
        />
      </div>
      {stage !== "todas" && STAGE_HELP[stage] ? <p className="-mt-2 text-sm text-muted-foreground">{STAGE_HELP[stage]}</p> : null}

      {list.isPending ? (
        <WaitlistSkeleton />
      ) : list.isError && !list.data ? (
        <ErrorState
          title="No pude cargar la lista de espera"
          error={list.error instanceof ApiError ? list.error.shape : list.error}
          onRetry={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        <ListEmpty stage={stage} searched={Boolean(search.q)} />
      ) : (
        <>
          <DataTable
            table={table}
            onRowClick={(r) => open(r.id)}
            isRowActive={(r) => r.id === search.solicitud}
            isFetching={list.isFetching}
          />
          {stage === "por_revisar" ? (
            <p className="text-sm text-muted-foreground">
              Primero las que vencen antes. Las invitaciones que ya vencieron están en la etapa «Invitación vencida», con «Reenviar».
            </p>
          ) : null}
        </>
      )}

      {search.solicitud ? (
        <RequestDrawer
          // Cada solicitud abre su propio cajón: lo escrito y el enlace no pasan de una a otra.
          key={search.solicitud}
          id={search.solicitud}
          isAdmin={isAdmin}
          onClose={() => open(undefined)}
        />
      ) : null}
    </PageShell>
  )
}

function ListEmpty({ stage, searched }: { stage: StageFilter; searched: boolean }) {
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
      title={stage === "por_revisar" ? "No hay solicitudes por revisar" : `No hay solicitudes en «${STAGE_LABEL[stage]}»`}
      description="Llegan desde «Pide tus USD 100» de la web. Cada una aparece aquí con su plazo para responder."
      learnMoreLabel="Ver el formulario en la web"
      learnMoreHref={webUrl("/solicitar-invitacion")}
    />
  )
}

/** Cuándo volver a contactarla: lo pendiente, un día de los que se ofrecen, otro o ninguno. */
type FollowUpChoice = "mantener" | "manana" | "habiles" | "semana" | "otra" | "cerrar"
const FOLLOW_UP_CHOICES: readonly string[] = ["mantener", "manana", "habiles", "semana", "otra", "cerrar"]

function RequestDrawer({ id, isAdmin, onClose }: { id: string; isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  // La solicitud se pide por su id: el cajón abre aunque la lista de detrás mire otra etapa u otro producto.
  const detail = useQuery({
    queryKey: ["admin", "waitlist", "request", id],
    queryFn: async () => detailPayload.parse(await api(`/api/admin/waitlist/${encodeURIComponent(id)}`)),
  })
  const item = detail.data?.request ?? null
  const seats = detail.data?.seats ?? null
  const entries = detail.data?.entries ?? []
  const choices = detail.data?.choices ?? null
  const [confirmInvite, setConfirmInvite] = React.useState(false)
  const [discarding, setDiscarding] = React.useState(false)
  const [hiding, setHiding] = React.useState<Entry | null>(null)
  const [lastLink, setLastLink] = React.useState<string | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "waitlist"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }

  // Cuándo volver: si hay una fecha pendiente de hoy en adelante, al abrir viene «Mantener»;
  // cerrar el recordatorio se elige a propósito y el botón lo dice.
  const pending = item?.nextFollowUpOn ?? null
  const canKeep = pending !== null && choices !== null && pending >= choices.today
  const [picked, setPicked] = React.useState<FollowUpChoice | null | undefined>(undefined)
  const choice: FollowUpChoice | null = picked === undefined ? (canKeep ? "mantener" : null) : picked
  const [otherDay, setOtherDay] = React.useState("")
  const [dayError, setDayError] = React.useState<string | null>(null)
  const dayOf = (value: FollowUpChoice | null): string | null => {
    if (!choices) return null
    if (value === "mantener") return pending
    if (value === "manana") return choices.tomorrow
    if (value === "habiles") return choices.inThreeBusinessDays
    if (value === "semana") return choices.nextWeek
    if (value === "otra") return otherDay || null
    return null
  }
  const nextDay = dayOf(choice)
  // Una descartada ya cerró su seguimiento: se anota, pero sin fecha.
  const datesOpen = item !== null && item.status !== "descartada"
  const anotarLabel = !datesOpen
    ? "Anotar"
    : nextDay && nextDay === pending
      ? `Anotar · sigue el ${formatLimaDay(nextDay)}`
      : nextDay
        ? `Anotar y volver el ${formatLimaDay(nextDay)}`
        : pending && choice !== "otra"
          ? "Anotar y cerrar el seguimiento"
          : "Anotar"

  const addFollowUp = useMutation({
    mutationFn: async (input: { body: string; followUpOn: string | null; adminOnly: boolean }) =>
      api(`/api/admin/waitlist/${encodeURIComponent(id)}/follow-ups`, { method: "POST", body: JSON.stringify(input) }),
  })
  const followUpForm = useAppForm({
    defaultValues: { body: "", adminOnly: false },
    validators: { onSubmit: followUpSchema },
    onSubmit: async ({ value, formApi }) => {
      if (datesOpen && choice === "otra" && !otherDay) {
        setDayError("Elige el día para volver a contactarla")
        return
      }
      const followUpOn = datesOpen ? nextDay : null
      await addFollowUp.mutateAsync({ body: value.body.trim(), followUpOn, adminOnly: isAdmin && value.adminOnly })
      formApi.reset({ body: "", adminOnly: false })
      setPicked(undefined)
      setOtherDay("")
      setDayError(null)
      refresh()
      toast.success(
        followUpOn
          ? `Anotado. Volver a contactar: ${formatLimaDay(followUpOn)}`
          : pending && datesOpen
            ? "Anotado. Seguimiento cerrado"
            : "Anotado",
      )
    },
  })
  const onFollowUpSubmit = useFormSubmit(followUpForm)
  const followUpError = useFormSubmitError(followUpForm)
  const followUpSaving = useStore(followUpForm.store, (state) => state.isSubmitting)
  const body = useStore(followUpForm.store, (state) => state.values.body)

  const hide = useMutation({
    mutationFn: async (entryId: string) =>
      api(`/api/admin/waitlist/follow-ups/${encodeURIComponent(entryId)}/hide`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      setHiding(null)
      refresh()
      toast.success("Entrada oculta a soporte")
    },
  })
  const invite = useMutation({
    mutationFn: async (send: boolean) =>
      invitePayload.parse(await api(`/api/admin/waitlist/${encodeURIComponent(id)}/invite`, { method: "POST", body: JSON.stringify({ send }) })),
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
    mutationFn: async (reason: string) =>
      api(`/api/admin/waitlist/${encodeURIComponent(id)}/discard`, { method: "POST", body: JSON.stringify({ reason }) }),
  })
  const discardForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: discardSchema },
    onSubmit: async ({ value, formApi }) => {
      await discard.mutateAsync(value.reason.trim())
      formApi.reset()
      setDiscarding(false)
      refresh()
      onClose()
      toast.success("Solicitud descartada")
    },
  })
  const discardError = useFormSubmitError(discardForm)
  const discardPending = useStore(discardForm.store, (state) => state.isSubmitting)
  const reason = useStore(discardForm.store, (state) => state.values.reason)

  const now = new Date()
  const today = choices?.today ?? ""
  const seatsFull = seats?.limit !== null && seats !== null && seats.used >= (seats.limit ?? Number.POSITIVE_INFINITY)
  const holdsSeat = item?.status === "invitada" && item.inviteExpiresAt !== null && new Date(item.inviteExpiresAt) > now
  const canInvite = isAdmin && item !== null && (item.status === "por_revisar" || item.status === "invitada") && seats !== null && (!seatsFull || holdsSeat)
  const nextSeat = seats ? seats.used + (holdsSeat ? 0 : 1) : null
  const loadError =
    detail.isError && !detail.data
      ? detail.error instanceof ApiError && detail.error.status === 404
        ? "No encuentro esa solicitud. Puede que el enlace esté incompleto o que ya no exista."
        : "No pude cargar la solicitud. Ciérrala y vuelve a abrirla."
      : null
  const dateOptions: { value: FollowUpChoice; label: string }[] =
    choices && datesOpen
      ? [
          ...(canKeep && pending ? [{ value: "mantener" as const, label: `Mantener ${formatLimaDay(pending)}` }] : []),
          { value: "manana", label: `Mañana · ${formatLimaDay(choices.tomorrow)}` },
          { value: "habiles", label: `En 3 días hábiles · ${formatLimaDay(choices.inThreeBusinessDays)}` },
          { value: "semana", label: `La próxima semana · ${formatLimaDay(choices.nextWeek)}` },
          { value: "otra", label: "Otra fecha…" },
          ...(pending ? [{ value: "cerrar" as const, label: "No volver a contactar" }] : []),
        ]
      : []

  return (
    <DetailDrawer
      open
      size="lg"
      onClose={onClose}
      // Lo escrito en «¿Qué pasó?» no se pierde sin avisar: ni al cerrar ni al ir a otra pantalla.
      isDirty={body.trim().length > 0 || reason.trim().length > 0}
      isSubmitting={invite.isPending || discardPending || followUpSaving}
      title={item?.clinicName ?? "Solicitud"}
      isLoading={detail.isPending}
      error={loadError}
      headerContent={
        item ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{STAGE_LABEL[item.stage]}</Badge>
            <span>Pidió {askedText(item.createdAt, now)}</span>
            <Deadline item={item} today={today} now={now} />
            {item.nextFollowUpOn && item.answer?.kind !== "volver" ? (
              <Badge variant={item.nextFollowUpOn <= today ? "destructive" : "outline"}>
                Volver a contactar: {formatLimaDay(item.nextFollowUpOn)}
              </Badge>
            ) : null}
          </div>
        ) : undefined
      }
      actions={
        item && isAdmin && item.status !== "entro" && item.status !== "descartada" ? (
          <div className="flex w-full items-center justify-between gap-3">
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => setDiscarding(true)}>
              Descartar…
            </Button>
            <span className="text-sm text-muted-foreground">Descartar pide un motivo y cierra el seguimiento; no se le avisa.</span>
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
              <DetailField label="Producto">{productWords(item.product).name}</DetailField>
              <DetailField label="Dónde">
                {item.city}, {countryName(item.countryCode)}
              </DetailField>
              <DetailField label="Correo">{item.email}</DetailField>
              <DetailField label="Celular">
                <a className="underline" href={`https://wa.me/${item.phone.replace(/^\+/, "")}`} target="_blank" rel="noreferrer">
                  {item.phone}
                </a>
              </DetailField>
              <DetailField label={upperFirst(productWords(item.product).clinician.many)}>
                {PROFESSIONALS_LABEL[item.professionals] ?? item.professionals}
              </DetailField>
              <DetailField label="Usan hoy">{TOOL_LABEL[item.currentTool] ?? item.currentTool}</DetailField>
            </DetailList>
          </DetailSection>

          <DetailSection title="Seguimiento">
            <form noValidate onSubmit={onFollowUpSubmit} className="flex flex-col gap-3">
              <followUpForm.AppField name="body">
                {(field) => (
                  <field.TextareaField
                    id="espera-seguimiento"
                    label="¿Qué pasó?"
                    description="No escribas nombres de pacientes."
                    placeholder="Ej.: La llamé, pidió que le escriba la próxima semana."
                    rows={3}
                    maxLength={2000}
                  />
                )}
              </followUpForm.AppField>
              {datesOpen && choices ? (
                <div className="flex flex-col gap-2">
                  <span id="espera-volver" className="text-sm leading-snug font-medium">
                    Volver a contactar
                  </span>
                  <ToggleGroup
                    aria-labelledby="espera-volver"
                    value={choice ? [choice] : []}
                    onValueChange={(next: unknown[]) => {
                      const value = next[0]
                      setDayError(null)
                      if (typeof value === "string" && FOLLOW_UP_CHOICES.includes(value)) setPicked(value as FollowUpChoice)
                      // Con una fecha pendiente siempre hay algo elegido: cerrarla es «No volver a contactar».
                      else if (!pending) setPicked(null)
                    }}
                    spacing={1}
                    className="flex-wrap justify-start"
                  >
                    {dateOptions.map((option) => (
                      <ToggleGroupItem
                        key={option.value}
                        value={option.value}
                        className="h-auto min-h-9 rounded-3xl border px-3 py-1.5 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold"
                      >
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {choice === "otra" ? (
                    <DatePickerButton
                      aria-label="Otra fecha para volver a contactarla"
                      aria-invalid={dayError ? true : undefined}
                      value={otherDay}
                      onChange={(day) => {
                        setOtherDay(day)
                        setDayError(null)
                      }}
                      min={choices.today}
                      max={choices.latest}
                      className="w-56"
                    />
                  ) : null}
                  {dayError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {dayError}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {nextDay ? "Ese día aparece en Inicio, en «Seguimientos de hoy»." : "Sin fecha, no vuelve a salir en Inicio."}
                  </p>
                </div>
              ) : null}
              {isAdmin ? (
                <followUpForm.AppField name="adminOnly">
                  {(field) => (
                    <field.CheckboxField id="espera-solo-admin" label="Solo administración" description="Soporte verá la fecha, no lo escrito." />
                  )}
                </followUpForm.AppField>
              ) : null}
              <div>
                <SubmitButton type="submit" pending={followUpSaving}>
                  {anotarLabel}
                </SubmitButton>
              </div>
              {followUpError ? (
                <p role="alert" className="text-sm text-destructive">
                  {followUpError}
                </p>
              ) : null}
            </form>
            {entries.length > 0 ? (
              <ol aria-label="Entradas del seguimiento" className="mt-4 flex flex-col gap-3">
                {entries.map((entry) => (
                  <FollowUpEntry key={entry.id} entry={entry} now={now} isAdmin={isAdmin} onHide={() => setHiding(entry)} />
                ))}
              </ol>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">Las entradas no se editan ni se borran.</p>
          </DetailSection>

          {item.status === "entro" ? (
            <DetailSection title={item.stage === "paga" ? "Paga" : "Entró"}>
              <p className="text-sm">
                Abrió{" "}
                {item.organizationId ? (
                  <Link to="/organizations/$organizationId" params={{ organizationId: item.organizationId }} className="font-medium underline">
                    {item.organizationName ?? "su clínica"}
                  </Link>
                ) : (
                  "su clínica"
                )}{" "}
                el {item.enteredAt ? formatDay(item.enteredAt) : "—"}, con el plan {item.planName ?? "de la invitación"}.
                {item.organizationId ? "" : " Su clínica ya no existe."}
                {item.stage === "paga" ? " Ya registramos al menos un pago suyo." : ""}
              </p>
            </DetailSection>
          ) : item.status === "descartada" ? (
            <DetailSection title="Descartada">
              <p className="text-sm">
                {item.discardReason}
                {item.decidedByName ? ` · ${item.decidedByName}` : ""}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Su seguimiento quedó cerrado: no vuelve a salir en Inicio.</p>
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
                  <p className="text-sm text-muted-foreground">Invita alguien con el rol Administración.</p>
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
                    {submitErrorMessage(invite.error)}
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
            description="Sale de la lista y, si tenía una invitación, deja de servir. Su seguimiento se cierra: no vuelve a salir en Inicio. No se le avisa."
            confirmLabel="Descartar"
            cancelLabel="Volver"
            pending={discardPending}
            error={discardError}
            onConfirm={() => void submitForm(discardForm)}
            onClose={() => {
              discardForm.reset()
              setDiscarding(false)
            }}
          >
            <discardForm.AppField name="reason">
              {(field) => <field.TextareaField id="espera-motivo" label="Motivo (obligatorio)" rows={3} maxLength={500} />}
            </discardForm.AppField>
          </ConfirmDialog>
          <ConfirmDialog
            open={hiding !== null}
            title="¿Ocultar esta entrada a soporte?"
            description="Soporte seguirá viendo que hay una entrada y su fecha para volver a contactar, pero no lo escrito. No se puede deshacer."
            confirmLabel="Ocultar a soporte"
            cancelLabel="Volver"
            variant="default"
            pending={hide.isPending}
            error={hide.isError ? submitErrorMessage(hide.error) : null}
            onConfirm={() => hiding && hide.mutate(hiding.id)}
            onClose={() => {
              hide.reset()
              setHiding(null)
            }}
          />
        </div>
      ) : null}
    </DetailDrawer>
  )
}

/** Una entrada del seguimiento: quién, cuándo, qué pasó y cuándo volver. Solo se agregan. */
function FollowUpEntry({ entry, now, isAdmin, onHide }: { entry: Entry; now: Date; isAdmin: boolean; onHide: () => void }) {
  if (entry.body === null) {
    // Soporte ve que existe y su fecha, nunca lo escrito.
    return (
      <li className="rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <p>Entrada solo para administración · {whenText(entry.createdAt, now)}</p>
        {entry.followUpOn ? <p>Volver a contactar: {formatLimaDay(entry.followUpOn)}</p> : null}
      </li>
    )
  }
  return (
    <li className="flex flex-col gap-1 rounded-xl border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{entry.authorName ?? "Nota anterior, sin autor registrado"}</span>
        <span className="text-muted-foreground">{whenText(entry.createdAt, now)}</span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{entry.body}</p>
      {entry.followUpOn ? <p className="text-sm text-muted-foreground">Volver a contactar: {formatLimaDay(entry.followUpOn)}</p> : null}
      {isAdmin ? (
        entry.adminOnly ? (
          <p className="text-xs text-muted-foreground">Solo administración</p>
        ) : (
          <div>
            <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onHide}>
              Ocultar a soporte
            </Button>
          </div>
        )
      ) : null}
    </li>
  )
}
