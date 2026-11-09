import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Badge,
  Button,
  cn,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldLabel,
} from "@odentia/ui"
import { SkeletonRegion, ViewTabs, zonedDateOf } from "@odentia/ui-patterns"
import { TimelineItemsSkeleton } from "../skeletons/person-sections"
import { useInfiniteQuery } from "@tanstack/react-query"
import { ClipboardList, FileText, Image as ImageIcon } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { timeAgo } from "../../lib/crm"
import type { DocumentFilter } from "../../lib/patient-areas"
import { documentCategoryLabel as docCategoryLabel } from "../../lib/patient-overview"
import { statusLabel, type TimelineItem, timelineTypeLabel } from "../../lib/patients"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import { DocumentOpenButton, useDocumentUrl } from "./document-open-button"
import { EncounterHistoryCard, VoidedEncounterLine } from "./encounter-history-card"
import { NewEncounterButton } from "./new-encounter-button"
import { useOpenWide, type WideTarget } from "./wide-section"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { productUi } from "../../product/product-ui"
import { PlaceSelect } from "../../product/site-fields"

const ALL_TEETH = "all"
export interface TimelineProps {
  patientId: string
  initialTooth?: number
  onOdontogramSelect: (tooth: number) => void
}

interface TimelinePage {
  data: TimelineItem[]
  nextCursor: string | null
  timezone: string
  locale: string
}
/**
 * Historia es «qué pasó y cuándo» (ADR 0035): los papeles salen como hechos
 * («firmó», «se pidió»), sin filtro propio; para buscarlos está Documentos.
 */
type FeedFilter = "todo" | "encounter" | "plan" | "note"

const FILTERS: Array<{ value: FeedFilter; label: string; types: string }> = [
  {
    value: "todo",
    label: "Todo",
    types:
      "encounter,note,odontogram,anamnesis,document,plan,budget,follow_up,prescription,consent,order,form",
  },
  { value: "encounter", label: "Atenciones", types: "encounter" },
  { value: "plan", label: "Plan", types: "plan,budget,follow_up" },
  { value: "note", label: "Notas clínicas", types: "note" },
]

/** El filtro de Documentos donde está cada papel de la historia. */
const DOCUMENT_FILTER_OF: Partial<Record<TimelineItem["type"], DocumentFilter>> = {
  prescription: "recetas",
  consent: "consentimientos",
  order: "ordenes",
  form: "formularios",
}

/**
 * Lo que ya no vale y se pliega al final de su día (QA de la ficha del 8 nov:
 * lo anulado iba arriba de lo vigente): la atención anulada, el tratamiento
 * cancelado y el presupuesto o el consentimiento anulados. La receta anulada y
 * la revocación se ven: la receta impresa pudo salir y revocar es un hecho
 * clínico vigente (mesa del 9 nov).
 */
function isRetired(item: TimelineItem): boolean {
  if (item.type === "encounter") return item.status === "anulada"
  if (item.type === "plan") return item.status === "cancelado" || item.status === "reemplazado"
  if (item.type === "budget") return item.status === "cancelado"
  if (item.type === "follow_up") return item.status === "cancelado"
  if (item.type === "consent") return item.status === "anulado"
  return false
}

/** «1 atención y 1 presupuesto»: lo plegado dicho por lo que es, no solo cuántos. */
function retiredSummary(items: TimelineItem[]): string {
  const NAMES: Partial<Record<TimelineItem["type"], [string, string]>> = {
    encounter: ["atención", "atenciones"],
    plan: ["tratamiento", "tratamientos"],
    budget: ["presupuesto", "presupuestos"],
    follow_up: ["control", "controles"],
    consent: ["consentimiento", "consentimientos"],
  }
  const parts: string[] = []
  for (const [type, [one, many]] of Object.entries(NAMES) as Array<[TimelineItem["type"], [string, string]]>) {
    const n = items.filter((item) => item.type === type).length
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`
}

function dayKey(iso: string, timezone: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

function dayHeading(iso: string, timezone: string, locale: string | undefined): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  return new Date(iso).toLocaleDateString(locale, {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function itemDateTime(iso: string, timezone: string, locale: string | undefined): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  return new Date(iso).toLocaleString(locale, { timeZone: timezone })
}

function CardHeaderRow({
  badge,
  context,
  createdAt,
  timezone,
  locale,
}: {
  badge: string
  context?: string | null
  createdAt: string
  timezone: string
  locale: string | undefined
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>{badge}</Badge>
      {context ? <span className="text-xs text-muted-foreground">{context}</span> : null}
      <time
        dateTime={createdAt}
        title={itemDateTime(createdAt, timezone, locale)}
        className="ml-auto text-xs text-muted-foreground"
      >
        {timeAgo(createdAt)}
      </time>
    </div>
  )
}

function NoteCard({
  item,
  timezone,
  locale,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-2">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={item.diagnosisCode ? `Diagnóstico: ${item.diagnosisCode}` : null}
          createdAt={item.createdAt}
          timezone={timezone}
          locale={locale}
        />
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
      </div>
    </div>
  )
}

function OdontogramCard({
  item,
  timezone,
  locale,
  onOdontogramSelect,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
  onOdontogramSelect: (tooth: number) => void
}) {
  const tooth = item.toothNumbers[0]
  const site = productUi().site
  const meta: string[] = []
  if (item.condition) meta.push(site?.findingName(item.condition) ?? item.condition)
  if (item.surface) meta.push(site?.partName(item.surface) ?? item.surface)
  if (item.status) meta.push(statusLabel(item.status))
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-2">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={
            [
              tooth != null ? `Pieza ${tooth}` : null,
              item.diagnosisCode ? `Diagnóstico: ${item.diagnosisCode}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || null
          }
          createdAt={item.createdAt}
          timezone={timezone}
          locale={locale}
        />
        {meta.length > 0 ? (
          <p className="text-sm text-muted-foreground">{meta.join(" · ")}</p>
        ) : null}
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        {tooth != null ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOdontogramSelect(tooth)}
            >
              Ver pieza {tooth} en el odontograma
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
function DocumentCard({ patientId, item }: { patientId: string; item: TimelineItem }) {
  const teeth = item.toothNumbers ?? []
  const tags = item.tags ?? []
  const signed = useDocumentUrl(patientId, item.refId)
  const url = signed.data?.data.url ?? null
  const isImage = item.category === "radiografia" || item.category === "foto_clinica"
  return (
    <Attachment orientation="horizontal" className="w-full">
      <AttachmentMedia variant={isImage && url ? "image" : "icon"}>
        {isImage && url ? (
          <img src={url} alt={item.title} loading="lazy" />
        ) : isImage ? (
          <ImageIcon aria-hidden="true" />
        ) : (
          <FileText aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{item.title}</AttachmentTitle>
        <AttachmentDescription>
          {item.category ? docCategoryLabel(item.category) : "Documento"}
          {teeth.length > 0 ? ` · P${teeth.join(", ")}` : ""}
          {tags.length > 0 ? ` · ${tags.join(", ")}` : ""}
          {item.encounterId ? " · vinculado a atención" : ""}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions className="max-w-full min-w-0 shrink pr-2">
        <DocumentOpenButton patientId={patientId} documentId={item.refId} label={item.title} />
      </AttachmentActions>
    </Attachment>
  )
}

function AnamnesisCard({
  item,
  timezone,
  locale,
  onView,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
  onView: (refId: string) => void
}) {
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-2">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={item.version != null ? `v${item.version}` : null}
          createdAt={item.createdAt}
          timezone={timezone}
          locale={locale}
        />
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => onView(item.refId)}>
            Ver anamnesis
          </Button>
        </div>
      </div>
    </div>
  )
}

const STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  programado: "Programado",
  en_curso: "En curso",
  suspendido: "Suspendido",
  realizado: "Realizado",
  cancelado: "Cancelado",
  reemplazado: "Reemplazado",
  emitida: "Emitida",
  anulada: "Anulada",
  borrador: "Borrador",
  activo: "Vigente",
  anulado: "Anulado",
}

/**
 * Evento del recorrido clínico-económico (tratamiento, presupuesto, control,
 * receta o pago) con su contexto y un acceso directo al lugar donde se gestiona.
 * Antes estos eventos abrían una anamnesis inexistente.
 */
function JourneyCard({
  item,
  timezone,
  locale,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  const openWide = useOpenWide()
  const link = ((): { label: string; target: WideTarget } | null => {
    switch (item.type) {
      case "plan":
        return { label: "Abrir recorrido", target: { id: "plan", itemId: item.planItemId ?? item.refId } }
      case "budget":
        return { label: "Ver el presupuesto", target: { id: "plan", budgetId: item.budgetId ?? item.refId } }
      case "follow_up":
        return { label: "Ver controles", target: { id: "plan" } }
      default:
        return null
    }
  })()

  return (
    <div className="flex flex-col gap-2 elevated rounded-xl border bg-card p-6">
      <CardHeaderRow
        badge={timelineTypeLabel(item.type)}
        createdAt={item.createdAt}
        timezone={timezone}
        locale={locale}
      />
      <p className="text-sm font-medium">{item.title}</p>
      {item.detail ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.detail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {item.status ? (
          // «Vencido» lo decide el servidor con la regla del Plan y del Resumen (QA del 8 nov, B4).
          <Badge variant={item.type === "follow_up" && item.statusText === "Vencido" ? "destructive" : "secondary"}>
            {item.statusText ?? STATUS_LABELS[item.status] ?? item.status}
          </Badge>
        ) : null}
        {/* La fecha del control mientras sigue abierto: «Toca el» o, si ya pasó, «Tocaba el». */}
        {item.dueAt && (item.status === "pendiente" || item.status === "programado") ? (
          <span className="text-xs text-muted-foreground">
            {zonedDateOf(item.dueAt, timezone) < zonedDateOf(new Date().toISOString(), timezone) ? "Tocaba el" : "Toca el"}{" "}
            {new Date(item.dueAt).toLocaleDateString(locale, { timeZone: timezone })}
          </span>
        ) : null}
        {item.toothNumbers.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            Pieza{item.toothNumbers.length > 1 ? "s" : ""} {item.toothNumbers.join(", ")}
          </span>
        ) : null}
      </div>
      {link ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => openWide?.(link.target)}>
            {link.label}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Un papel como hecho de la historia: «Firmó: …», «Se pidió…»,
 * «Se completó el formulario…» o la receta emitida. El papel en sí se abre en
 * Documentos.
 */
/** Los tipos que se dicen en femenino («Receta anulada», «Orden anulada»). */
const FEMININE_TYPES = new Set(["prescription", "order", "note", "anamnesis", "encounter"])

function FactCard({
  item,
  timezone,
  locale,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  const openWide = useOpenWide()
  const filter = DOCUMENT_FILTER_OF[item.type]
  // Lo anulado se ve distinto, como la atención anulada: el servidor dice el estado.
  const voided = item.status === "anulada" || item.status === "anulado"
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-6 py-4",
        voided ? "border-dashed" : "elevated bg-card",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <CardHeaderRow
          badge={voided ? `${timelineTypeLabel(item.type)} ${FEMININE_TYPES.has(item.type) ? "anulada" : "anulado"}` : timelineTypeLabel(item.type)}
          createdAt={item.createdAt}
          timezone={timezone}
          locale={locale}
        />
        <p className={cn("text-sm font-medium", voided && "text-muted-foreground")}>{item.title}</p>
        {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
      </div>
      {filter ? (
        <Button type="button" variant="outline" size="sm" onClick={() => openWide?.({ id: "documentos", documentFilter: filter })}>
          Ver en Documentos
        </Button>
      ) : null}
    </div>
  )
}

/** Historia clínica unificada: atenciones (también las anuladas), notas, anamnesis, papeles, odontograma y plan. */
export function Timeline({ patientId, initialTooth, onOdontogramSelect }: TimelineProps) {
  const [filter, setFilter] = useState<FeedFilter>("todo")
  // Lo plegado de cada día que se abrió.
  const [openRetired, setOpenRetired] = useState<ReadonlySet<string>>(new Set())
  const [tooth, setTooth] = useState<string>(
    initialTooth != null ? String(initialTooth) : ALL_TEETH,
  )
  const [viewingAnamnesis, setViewingAnamnesis] = useState<string | null>(null)
  const toothId = useId()

  useEffect(() => {
    if (initialTooth != null) setTooth(String(initialTooth))
  }, [initialTooth])

  const types = FILTERS.find((option) => option.value === filter)?.types ?? FILTERS[0].types
  const toothNumber = tooth === ALL_TEETH ? undefined : Number(tooth)

  const feed = useInfiniteQuery({
    queryKey: ["timeline", patientId, types, toothNumber],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (types) params.set("types", types)
      if (toothNumber != null) params.set("toothNumber", String(toothNumber))
      if (pageParam) params.set("cursor", pageParam)
      const query = params.toString()
      return apiFetch<TimelinePage>(
        `/api/patients/${patientId}/timeline${query ? `?${query}` : ""}`,
      )
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.data) ?? [], [feed.data])
  const timezone = feed.data?.pages[0]?.timezone ?? activeOrgTimeZone()
  const locale = feed.data?.pages[0]?.locale ?? activeOrgLocale()

  // Un día, con su atención como tarjeta (lo nacido en ella va dentro, lo dice el
  // servidor) y lo anulado plegado al final del día: ya no hace falta agrupar
  // «por atención» aparte (QA de la ficha del 8 nov).
  const groups = useMemo(() => {
    const ordered = new Map<string, { heading: string; sample: string; items: TimelineItem[]; retired: TimelineItem[] }>()
    for (const item of items) {
      const key = dayKey(item.createdAt, timezone)
      const group =
        ordered.get(key) ??
        ordered
          .set(key, { heading: dayHeading(item.createdAt, timezone, locale), sample: item.createdAt, items: [], retired: [] })
          .get(key)!
      if (isRetired(item)) group.retired.push(item)
      else group.items.push(item)
    }
    return [...ordered.entries()]
  }, [items, timezone, locale])

  // El filtro por lugar y los hechos propios del producto (odentIA: la pieza y el odontograma firmado).
  const { site, history } = productUi()

  const hasActiveFilter = filter !== "todo" || tooth !== ALL_TEETH

  const renderItem = (item: TimelineItem) =>
    item.type === "encounter" && item.status === "anulada" ? (
      <VoidedEncounterLine key={item.id} item={item} />
    ) : item.type === "encounter" ? (
      <EncounterHistoryCard key={item.id} patientId={patientId} item={item} />
    ) : item.type === "prescription" || item.type === "consent" || item.type === "order" || item.type === "form" ? (
      <FactCard key={item.id} item={item} timezone={timezone} locale={locale} />
    ) : item.type === "note" ? (
      <NoteCard key={item.id} item={item} timezone={timezone} locale={locale} />
    ) : item.type === "odontogram" ? (
      <OdontogramCard key={item.id} item={item} timezone={timezone} locale={locale} onOdontogramSelect={onOdontogramSelect} />
    ) : history.owns(item.type) ? (
      <history.Item key={item.id} item={item} patientId={patientId} />
    ) : item.type === "document" ? (
      <DocumentCard key={item.id} patientId={patientId} item={item} />
    ) : item.type === "anamnesis" ? (
      <AnamnesisCard key={item.id} item={item} timezone={timezone} locale={locale} onView={setViewingAnamnesis} />
    ) : (
      <JourneyCard key={item.id} item={item} timezone={timezone} locale={locale} />
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ViewTabs label="Filtrar historia clínica" value={filter} options={FILTERS} onValueChange={setFilter} />
      </div>

      {site ? (
        <Field className="max-w-64">
          <FieldLabel htmlFor={toothId}>{site.placeLabel}</FieldLabel>
          <PlaceSelect
            id={toothId}
            value={toothNumber}
            onChange={(place) => setTooth(place != null ? String(place) : ALL_TEETH)}
          />
        </Field>
      ) : null}

      {feed.isPending ? (
        <SkeletonRegion message="Cargando historia clínica…" className="flex flex-col gap-4">
          <TimelineItemsSkeleton />
        </SkeletonRegion>
      ) : null}

      {feed.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {feed.error.message}
          </p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void feed.refetch()}>
              Reintentar
            </Button>
          </div>
        </div>
      ) : null}

      {!feed.isPending && !feed.isError && items.length === 0 ? (
        hasActiveFilter && filter !== "encounter" ? (
          <p className="text-sm text-muted-foreground">Sin hechos para los filtros elegidos.</p>
        ) : (
          // Vacío con su acción (ADR 0035): la historia empieza con una atención.
          <Empty className="rounded-lg border border-dashed border-border bg-surface p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon" aria-hidden>
                <ClipboardList />
              </EmptyMedia>
              <EmptyTitle>Todavía no tiene atenciones</EmptyTitle>
              <EmptyDescription>Lo que pasa en cada atención queda aquí, con su fecha.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <NewEncounterButton patientId={patientId} />
            </EmptyContent>
          </Empty>
        )
      ) : null}

      {groups.map(([key, group]) => (
        <section
          key={key}
          aria-label={group.heading}
          className="relative flex flex-col gap-3 border-l-2 border-border pl-4 sm:pl-5"
        >
          <span
            aria-hidden="true"
            className="absolute -left-[7px] top-1 size-3 rounded-full border-2 border-primary bg-background"
          />
          <h3 className="text-sm font-semibold text-muted-foreground">
            <time dateTime={group.sample}>{group.heading}</time>
          </h3>
          {group.items.map(renderItem)}
          {group.retired.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto justify-start p-0 text-muted-foreground"
                aria-expanded={openRetired.has(key)}
                aria-controls={`retired-${key}`}
                onClick={() =>
                  setOpenRetired((current) => {
                    const next = new Set(current)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
              >
                {openRetired.has(key) ? "Ocultar lo anulado" : `Anulado ese día: ${retiredSummary(group.retired)} · Ver`}
              </Button>
              {openRetired.has(key) ? (
                <div id={`retired-${key}`} className="flex flex-col gap-2">
                  {group.retired.map(renderItem)}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ))}

      {feed.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={feed.isFetchingNextPage}
            onClick={() => {
              if (!feed.isFetchingNextPage && feed.hasNextPage) void feed.fetchNextPage()
            }}
          >
            {feed.isFetchingNextPage ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      ) : null}

      <AnamnesisVersionDialog
        patientId={patientId}
        versionId={viewingAnamnesis}
        onClose={() => setViewingAnamnesis(null)}
      />
    </div>
  )
}
