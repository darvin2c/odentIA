import { FDI_ADULT, FDI_CHILD, conditionLabel, surfaceLabel } from "@odentia/clinical";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui";
import { FileText, Image as ImageIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { timeAgo } from "../../lib/crm";
import {
  statusLabel,
  timelineTypeLabel,
  type TimelineItem,
} from "../../lib/patients";
import { AnamnesisVersionDialog } from "./anamnesis-history";
import { EncounterHistoryCard } from "./encounter-history-card";

export interface TimelineProps {
  patientId: string;
  initialTooth?: number;
  onOdontogramSelect: (tooth: number) => void;
}

interface TimelinePage {
  data: TimelineItem[];
  nextCursor: string | null;
}

type FeedFilter = "todo" | "encounter" | "note" | "rx" | "foto" | "odontogram";

const FILTERS: Array<{ value: FeedFilter; label: string; dot?: string }> = [
  { value: "todo", label: "Todo" },
  { value: "encounter", label: "Atenciones", dot: "bg-blue-500" },
  { value: "note", label: "Notas", dot: "bg-violet-500" },
  { value: "rx", label: "RX", dot: "bg-sky-500" },
  { value: "foto", label: "Fotos", dot: "bg-emerald-500" },
  { value: "odontogram", label: "Odontograma", dot: "bg-amber-500" },
];

type GroupMode = "dia" | "tratamiento";

const GROUP_MODES: Array<{ value: GroupMode; label: string }> = [
  { value: "dia", label: "Día" },
  { value: "tratamiento", label: "Tratamiento" },
];

const ALL_TEETH = "todas";

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000;

const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  consentimiento: "Consentimiento",
  radiografia: "Radiografía",
  foto_clinica: "Foto clínica",
  informe: "Informe",
  otro: "Otro",
};

function documentCategoryLabel(category: string | undefined): string {
  if (!category) return "Documento";
  return DOCUMENT_CATEGORY_LABELS[category] ?? category;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayHeading(iso: string): string {
  const date = new Date(iso);
  const formatted = new Intl.DateTimeFormat("es-PE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const capitalized = formatted.charAt(0).toUpperCase() + formatted.slice(1);
  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return isToday ? `HOY · ${capitalized}` : capitalized;
}

function itemDateTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Date(iso).toLocaleString("es-PE");
}

function useDocumentUrl(patientId: string, documentId: string) {
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  });
}

/** Prefetcha la URL firmada para abrirla en el gesto del usuario sin bloqueos de ventanas. */
function DocumentOpenButton({ patientId, documentId, label }: { patientId: string; documentId: string; label: string }) {
  const signed = useDocumentUrl(patientId, documentId);
  const url = signed.data?.data.url ?? null;
  if (signed.isError) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="alert" className="text-xs text-destructive">
          No se pudo obtener el documento.
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void signed.refetch()}>
          Reintentar
        </Button>
      </span>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!url}
      onClick={() => {
        if (url) window.open(url, "_blank", "noopener");
      }}
    >
      {signed.isPending ? "Obteniendo documento…" : `Abrir ${label}`}
    </Button>
  );
}

function CardHeaderRow({
  badge,
  context,
  createdAt,
}: {
  badge: string;
  context?: string | null;
  createdAt: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>{badge}</Badge>
      {context ? <span className="text-xs text-muted-foreground">{context}</span> : null}
      <time
        dateTime={createdAt}
        title={itemDateTime(createdAt)}
        className="ml-auto text-xs text-muted-foreground"
      >
        {timeAgo(createdAt)}
      </time>
    </div>
  );
}

function NoteCard({ item }: { item: TimelineItem }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-4">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={item.diagnosisCode ? `CIE-10: ${item.diagnosisCode}` : null}
          createdAt={item.createdAt}
        />
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function OdontogramCard({
  item,
  onOdontogramSelect,
}: {
  item: TimelineItem;
  onOdontogramSelect: (tooth: number) => void;
}) {
  const tooth = item.toothNumbers[0];
  const meta: string[] = [];
  if (item.condition) meta.push(conditionLabel(item.condition));
  if (item.surface) meta.push(surfaceLabel(item.surface));
  if (item.status) meta.push(statusLabel(item.status));
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-4">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={[tooth != null ? `Pieza ${tooth}` : null, item.diagnosisCode ? `CIE-10: ${item.diagnosisCode}` : null]
            .filter(Boolean)
            .join(" · ") || null}
          createdAt={item.createdAt}
        />
        {meta.length > 0 ? <p className="text-sm text-muted-foreground">{meta.join(" · ")}</p> : null}
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        {tooth != null ? (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => onOdontogramSelect(tooth)}>
              Ver pieza {tooth} en el odontograma
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DocumentCard({ patientId, item }: { patientId: string; item: TimelineItem }) {
  const tooth = item.toothNumbers[0];
  const signed = useDocumentUrl(patientId, item.refId);
  const url = signed.data?.data.url ?? null;
  const isImage = item.category === "radiografia" || item.category === "foto_clinica";
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
          {documentCategoryLabel(item.category)}
          {tooth != null ? ` · Pieza ${tooth}` : ""}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions className="pr-2">
        <DocumentOpenButton patientId={patientId} documentId={item.refId} label={item.title} />
      </AttachmentActions>
    </Attachment>
  );
}

function AnamnesisCard({ item, onView }: { item: TimelineItem; onView: (refId: string) => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-4">
        <CardHeaderRow
          badge={timelineTypeLabel(item.type)}
          context={item.version != null ? `v${item.version}` : null}
          createdAt={item.createdAt}
        />
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => onView(item.refId)}>
            Ver anamnesis
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Historia clínica unificada: atenciones finalizadas, notas, anamnesis, documentos y odontograma. */
export function Timeline({ patientId, initialTooth, onOdontogramSelect }: TimelineProps) {
  const [filter, setFilter] = useState<FeedFilter>("todo");
  const [mode, setMode] = useState<GroupMode>("dia");
  const [tooth, setTooth] = useState<string>(initialTooth != null ? String(initialTooth) : ALL_TEETH);
  const [viewingAnamnesis, setViewingAnamnesis] = useState<string | null>(null);
  const toothId = useId();

  useEffect(() => {
    if (initialTooth != null) setTooth(String(initialTooth));
  }, [initialTooth]);

  const types =
    filter === "encounter" || filter === "note" || filter === "odontogram"
      ? filter
      : filter === "rx" || filter === "foto"
        ? "document"
        : undefined;
  const documentCategory =
    filter === "rx" ? "radiografia" : filter === "foto" ? "foto_clinica" : undefined;
  const toothNumber = tooth === ALL_TEETH ? undefined : Number(tooth);

  const feed = useInfiniteQuery({
    queryKey: ["timeline", patientId, types, toothNumber, documentCategory],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (types) params.set("types", types);
      if (toothNumber != null) params.set("toothNumber", String(toothNumber));
      if (documentCategory) params.set("documentCategory", documentCategory);
      if (pageParam) params.set("cursor", pageParam);
      const query = params.toString();
      return apiFetch<TimelinePage>(`/api/patients/${patientId}/timeline${query ? `?${query}` : ""}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.data) ?? [], [feed.data]);

  const groups = useMemo(() => {
    const ordered = new Map<string, { heading: string; sample: string; items: TimelineItem[] }>();
    if (mode === "dia") {
      for (const item of items) {
        const key = dayKey(item.createdAt);
        const group = ordered.get(key);
        if (group) group.items.push(item);
        else ordered.set(key, { heading: dayHeading(item.createdAt), sample: item.createdAt, items: [item] });
      }
      return [...ordered.entries()];
    }
    // Modo Tratamiento: una sección por atención (en orden descendente) y una
    // sección final "Generales" con eventos no vinculados a una atención.
    for (const item of items) {
      if (item.type !== "encounter") continue;
      ordered.set(item.id, {
        heading: `Atención ${dayHeading(item.createdAt)}`,
        sample: item.createdAt,
        items: [item],
      });
    }
    const generales = items.filter((item) => item.type !== "encounter");
    if (generales.length > 0) {
      ordered.set("generales", { heading: "Generales", sample: generales[0]!.createdAt, items: generales });
    }
    return [...ordered.entries()];
  }, [items, mode]);

  const toothItems: Record<string, string> = useMemo(
    () => ({
      [ALL_TEETH]: "Todas las piezas",
      ...Object.fromEntries([...FDI_ADULT, ...FDI_CHILD].map((n) => [String(n), `Pieza ${n}`] as const)),
    }),
    [],
  );

  const hasActiveFilter = filter !== "todo" || tooth !== ALL_TEETH;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" aria-label="Filtrar historia clínica">
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
        </div>
        <div className="flex gap-2" role="group" aria-label="Agrupar historia clínica">
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

      {feed.isPending ? <p className="text-sm text-muted-foreground">Cargando historia clínica…</p> : null}

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
          {hasActiveFilter ? "Sin eventos para los filtros seleccionados." : "Sin eventos en la historia clínica."}
        </p>
      ) : null}

      {groups.map(([key, group]) => (
        <section key={key} aria-label={group.heading} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-muted-foreground">
            <time dateTime={group.sample}>{group.heading}</time>
          </h3>
          {group.items.map((item) =>
            item.type === "encounter" ? (
              <EncounterHistoryCard key={item.id} patientId={patientId} item={item} />
            ) : item.type === "note" ? (
              <NoteCard key={item.id} item={item} />
            ) : item.type === "odontogram" ? (
              <OdontogramCard key={item.id} item={item} onOdontogramSelect={onOdontogramSelect} />
            ) : item.type === "document" ? (
              <DocumentCard key={item.id} patientId={patientId} item={item} />
            ) : (
              <AnamnesisCard key={item.id} item={item} onView={setViewingAnamnesis} />
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
              if (!feed.isFetchingNextPage && feed.hasNextPage) void feed.fetchNextPage();
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
  );
}
