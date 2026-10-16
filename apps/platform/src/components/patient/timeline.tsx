import { conditionLabel, FDI_ADULT, FDI_CHILD, surfaceLabel } from "@odentia/clinical"
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Badge,
  Button,
  ButtonGroup,
  buttonVariants,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ClipboardList, FileText, Image as ImageIcon } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { timeAgo } from "../../lib/crm"
import { documentCategoryLabel as docCategoryLabel } from "../../lib/patient-overview"
import { statusLabel, type TimelineItem, timelineTypeLabel } from "../../lib/patients"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import { DocumentOpenButton, useDocumentUrl } from "./document-open-button"
import { SignedOdontogramFact } from "../odontogram-assessments"
import { EncounterHistoryCard } from "./encounter-history-card"
import { NewEncounterButton } from "./new-encounter-button"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

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
const DOCUMENT_FILTER_OF: Partial<Record<TimelineItem["type"], string>> = {
  prescription: "recetas",
  consent: "consentimientos",
  order: "ordenes",
  form: "formularios",
}

type GroupMode = "dia" | "atencion"

const GROUP_MODES: Array<{ value: GroupMode; label: string }> = [
  { value: "dia", label: "Día" },
  { value: "atencion", label: "Atención" },
]

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
          context={item.diagnosisCode ? `CIE-10: ${item.diagnosisCode}` : null}
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
  const meta: string[] = []
  if (item.condition) meta.push(conditionLabel(item.condition))
  if (item.surface) meta.push(surfaceLabel(item.surface))
  if (item.status) meta.push(statusLabel(item.status))
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-2">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={
            [
              tooth != null ? `Pieza ${tooth}` : null,
              item.diagnosisCode ? `CIE-10: ${item.diagnosisCode}` : null,
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
      <AttachmentActions className="pr-2">
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

/** Etiqueta en español de la decisión vigente de un tratamiento. */
function decisionLabel(decision: string): string {
  switch (decision) {
    case "aceptado":
      return "Aceptado"
    case "rechazado":
      return "Rechazado"
    case "pospuesto":
      return "Pospuesto"
    case "reemplazado":
      return "Reemplazado"
    default:
      return "Pendiente de decisión"
  }
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
  presentado: "Presentado",
  aceptado: "Aceptado",
  parcial: "Parcial",
  rechazado: "Rechazado",
  pospuesto: "Pospuesto",
  sustituido: "Sustituido",
  activo: "Vigente",
  anulado: "Anulado",
}

/**
 * Evento del recorrido clínico-económico (tratamiento, presupuesto, control,
 * receta o pago) con su contexto y un acceso directo al lugar donde se gestiona.
 * Antes estos eventos abrían una anamnesis inexistente.
 */
function JourneyCard({
  patientId,
  item,
  timezone,
  locale,
}: {
  patientId: string
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  const link = ((): { label: string; search: Record<string, unknown> } | null => {
    switch (item.type) {
      case "plan":
        return {
          label: "Abrir recorrido",
          search: { tab: "plan", itemId: item.planItemId ?? item.refId },
        }
      case "budget":
        return {
          label: "Ver el presupuesto",
          search: {
            tab: "plan",
            ...(item.planId ? { planId: item.planId } : {}),
            budgetId: item.budgetId ?? item.refId,
          },
        }
      case "follow_up":
        return { label: "Ver controles", search: { tab: "plan" } }
      default:
        return null
    }
  })()

  return (
    <div className="flex flex-col gap-2 elevated rounded-xl border bg-card p-6">
      <CardHeaderRow
        badge={timelineTypeLabel(item.type)}
        context={item.decision ? decisionLabel(item.decision) : null}
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
          <Badge variant="secondary">{STATUS_LABELS[item.status] ?? item.status}</Badge>
        ) : null}
        {item.dueAt ? (
          <span className="text-xs text-muted-foreground">
            Vence {new Date(item.dueAt).toLocaleDateString(locale, { timeZone: timezone })}
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
          <Link
            to="/patients/$patientId"
            params={{ patientId }}
            search={link.search as { tab: "resumen" }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {link.label}
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Un papel como hecho de la historia: «Firmó el consentimiento…», «Se pidió…»,
 * «Se completó el formulario…» o la receta emitida. El papel en sí se abre en
 * Documentos.
 */
function FactCard({
  patientId,
  item,
  timezone,
  locale,
}: {
  patientId: string
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  const filter = DOCUMENT_FILTER_OF[item.type]
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 elevated rounded-xl border bg-card px-6 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          createdAt={item.createdAt}
          timezone={timezone}
          locale={locale}
        />
        <p className="text-sm font-medium">{item.title}</p>
        {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
      </div>
      {filter ? (
        <Link
          to="/patients/$patientId"
          params={{ patientId }}
          search={{ tab: "documentos", tipo: filter } as { tab: "documentos" }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Ver en Documentos
        </Link>
      ) : null}
    </div>
  )
}

/** Atención anulada: queda en la historia con su motivo, sin su contenido. */
function VoidedEncounterCard({
  item,
  timezone,
  locale,
}: {
  item: TimelineItem
  timezone: string
  locale: string | undefined
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-dashed px-6 py-4">
      <CardHeaderRow
        badge="Atención anulada"
        context={item.title}
        createdAt={item.createdAt}
        timezone={timezone}
        locale={locale}
      />
      <p className="text-sm text-muted-foreground">
        Motivo: {item.voidReason ?? "sin registrar"}
      </p>
    </div>
  )
}

/** Historia clínica unificada: atenciones (también las anuladas), notas, anamnesis, papeles, odontograma y plan. */
export function Timeline({ patientId, initialTooth, onOdontogramSelect }: TimelineProps) {
  const [filter, setFilter] = useState<FeedFilter>("todo")
  const [mode, setMode] = useState<GroupMode>("dia")
  const [order, setOrder] = useState<"desc" | "asc">("desc")
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
    queryKey: ["timeline", patientId, types, toothNumber, order],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (types) params.set("types", types)
      if (toothNumber != null) params.set("toothNumber", String(toothNumber))
      if (order !== "desc") params.set("order", order)
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

  const groups = useMemo(() => {
    const ordered = new Map<string, { heading: string; sample: string; items: TimelineItem[] }>()
    if (mode === "dia") {
      for (const item of items) {
        const key = dayKey(item.createdAt, timezone)
        const group = ordered.get(key)
        if (group) group.items.push(item)
        else
          ordered.set(key, {
            heading: dayHeading(item.createdAt, timezone, locale),
            sample: item.createdAt,
            items: [item],
          })
      }
      return [...ordered.entries()]
    }
    // Modo Atención: una sección por atención con su motivo y fecha, y una
    // sección final "Generales" con notas sueltas y eventos no vinculados.
    // Los documentos de cada atención se ven dentro de su tarjeta
    // (misma unidad clínica), no duplicados en Generales.
    for (const item of items) {
      if (item.type !== "encounter") continue
      ordered.set(item.id, {
        heading: `Atención · ${item.title} · ${dayHeading(item.createdAt, timezone, locale)}`,
        sample: item.createdAt,
        items: [item],
      })
    }
    const generales = items.filter((item) => item.type !== "encounter")
    if (generales.length > 0) {
      ordered.set("generales", {
        heading: "Generales",
        sample: generales[0]!.createdAt,
        items: generales,
      })
    }
    return [...ordered.entries()]
  }, [items, mode, timezone, locale])

  const toothItems: Record<string, string> = useMemo(
    () => ({
      [ALL_TEETH]: "Todas las piezas",
      ...Object.fromEntries(
        [...FDI_ADULT, ...FDI_CHILD].map((n) => [String(n), `Pieza ${n}`] as const),
      ),
    }),
    [],
  )

  const hasActiveFilter = filter !== "todo" || tooth !== ALL_TEETH || order !== "desc"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto">
          <ButtonGroup aria-label="Filtrar historia clínica">
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={filter === option.value ? "default" : "outline"}
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup aria-label="Agrupar historia clínica">
            {GROUP_MODES.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={mode === option.value ? "default" : "outline"}
                aria-pressed={mode === option.value}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </ButtonGroup>
          <ButtonGroup aria-label="Orden de historia clínica">
            <Button
              type="button"
              size="sm"
              variant={order === "desc" ? "default" : "outline"}
              aria-pressed={order === "desc"}
              onClick={() => setOrder("desc")}
            >
              Recientes
            </Button>
            <Button
              type="button"
              size="sm"
              variant={order === "asc" ? "default" : "outline"}
              aria-pressed={order === "asc"}
              onClick={() => setOrder("asc")}
            >
              Antiguos
            </Button>
          </ButtonGroup>
        </div>
      </div>

      <Field className="max-w-64">
        <FieldLabel htmlFor={toothId}>Pieza</FieldLabel>
        <Select
          items={toothItems}
          value={toothItems[tooth] ? tooth : ALL_TEETH}
          onValueChange={(value) => setTooth(value ?? ALL_TEETH)}
        >
          <SelectTrigger id={toothId} aria-label="Pieza">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TEETH}>Todas las piezas</SelectItem>
            <SelectGroup>
              <SelectLabel>Permanentes</SelectLabel>
              {FDI_ADULT.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Pieza {n}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Temporales</SelectLabel>
              {FDI_CHILD.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Pieza {n}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {feed.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando historia clínica…</p>
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
          {group.items.map((item) =>
            item.type === "encounter" && item.status === "anulada" ? (
              <VoidedEncounterCard key={item.id} item={item} timezone={timezone} locale={locale} />
            ) : item.type === "encounter" ? (
              <EncounterHistoryCard key={item.id} patientId={patientId} item={item} />
            ) : item.type === "prescription" ||
              item.type === "consent" ||
              item.type === "order" ||
              item.type === "form" ? (
              <FactCard
                key={item.id}
                patientId={patientId}
                item={item}
                timezone={timezone}
                locale={locale}
              />
            ) : item.type === "note" ? (
              <NoteCard key={item.id} item={item} timezone={timezone} locale={locale} />
            ) : item.type === "odontogram" ? (
              <OdontogramCard
                key={item.id}
                item={item}
                timezone={timezone}
                locale={locale}
                onOdontogramSelect={onOdontogramSelect}
              />
            ) : item.type === "odontogram_signed" ? (
              <div key={item.id} className="flex flex-col gap-2 elevated rounded-xl border bg-card p-6">
                <SignedOdontogramFact patientId={patientId} assessmentId={item.refId} />
              </div>
            ) : item.type === "document" ? (
              <DocumentCard key={item.id} patientId={patientId} item={item} />
            ) : item.type === "anamnesis" ? (
              <AnamnesisCard
                key={item.id}
                item={item}
                timezone={timezone}
                locale={locale}
                onView={setViewingAnamnesis}
              />
            ) : (
              <JourneyCard
                key={item.id}
                patientId={patientId}
                item={item}
                timezone={timezone}
                locale={locale}
              />
            ),
          )}
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
