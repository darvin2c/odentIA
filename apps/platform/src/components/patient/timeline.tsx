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
import { FileText, Image as ImageIcon } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { timeAgo } from "../../lib/crm"
import { documentCategoryLabel as docCategoryLabel } from "../../lib/patient-overview"
import { statusLabel, type TimelineItem, timelineTypeLabel } from "../../lib/patients"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import { DocumentOpenButton, useDocumentUrl } from "./document-open-button"
import { EncounterHistoryCard } from "./encounter-history-card"

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
type FeedFilter = "todo" | "encounter" | "note" | "anamnesis" | "rx" | "foto" | "odontogram"

const FILTERS: Array<{ value: FeedFilter; label: string; dot?: string }> = [
  { value: "todo", label: "Todo" },
  { value: "encounter", label: "Atenciones", dot: "bg-blue-500" },
  { value: "note", label: "Notas", dot: "bg-violet-500" },
  { value: "anamnesis", label: "Anamnesis", dot: "bg-teal-500" },
  { value: "rx", label: "RX", dot: "bg-sky-500" },
  { value: "foto", label: "Fotos", dot: "bg-emerald-500" },
  { value: "odontogram", label: "Odontograma", dot: "bg-amber-500" },
]

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

function dayHeading(iso: string, timezone: string, locale: string): string {
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

function itemDateTime(iso: string, timezone: string, locale: string): string {
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
  locale: string
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
  locale: string
}) {
  return (
    <div className="flex flex-col gap-6 rounded-md bg-card p-6">
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
  locale: string
  onOdontogramSelect: (tooth: number) => void
}) {
  const tooth = item.toothNumbers[0]
  const meta: string[] = []
  if (item.condition) meta.push(conditionLabel(item.condition))
  if (item.surface) meta.push(surfaceLabel(item.surface))
  if (item.status) meta.push(statusLabel(item.status))
  return (
    <div className="flex flex-col gap-6 rounded-md bg-card p-6">
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
  locale: string
  onView: (refId: string) => void
}) {
  return (
    <div className="flex flex-col gap-6 rounded-md bg-card p-6">
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

/** Historia clínica unificada: atenciones finalizadas, notas, anamnesis, documentos y odontograma. */
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

  const types =
    filter === "encounter" || filter === "note" || filter === "odontogram" || filter === "anamnesis"
      ? filter
      : filter === "rx" || filter === "foto"
        ? "document"
        : undefined
  const documentCategory =
    filter === "rx" ? "radiografia" : filter === "foto" ? "foto_clinica" : undefined
  const toothNumber = tooth === ALL_TEETH ? undefined : Number(tooth)

  const feed = useInfiniteQuery({
    queryKey: ["timeline", patientId, types, toothNumber, documentCategory, order],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (types) params.set("types", types)
      if (toothNumber != null) params.set("toothNumber", String(toothNumber))
      if (documentCategory) params.set("documentCategory", documentCategory)
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
  const timezone = feed.data?.pages[0]?.timezone ?? "America/Lima"
  const locale = feed.data?.pages[0]?.locale ?? "es-PE"

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
                {option.dot ? (
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={`size-1.5 rounded-full ${option.dot}`} />
                    {option.label}
                  </span>
                ) : (
                  option.label
                )}
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
        <p className="text-sm text-muted-foreground">
          {hasActiveFilter
            ? "Sin eventos para los filtros seleccionados."
            : "Sin eventos en la historia clínica."}
        </p>
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
            item.type === "encounter" ? (
              <EncounterHistoryCard key={item.id} patientId={patientId} item={item} />
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
            ) : item.type === "document" ? (
              <DocumentCard key={item.id} patientId={patientId} item={item} />
            ) : (
              <AnamnesisCard
                key={item.id}
                item={item}
                timezone={timezone}
                locale={locale}
                onView={setViewingAnamnesis}
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
