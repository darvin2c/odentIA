import { type ConsentSections, consentSectionsToText } from "@odentia/clinical"
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldLabel,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  useIsMobile,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageNotice,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Check, ChevronDown, FileText, Pencil, Plus, X } from "lucide-react"
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import {
  type ConsentTemplate,
  fetchConsentPreview,
  fetchConsentTemplates,
  markConsentTemplateReviewed,
  saveConsentTemplate,
  setConsentTemplateActive,
} from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import { fetchConsentTemplateServices, saveConsentTemplateServices } from "../../lib/encounter-documents"
import { sameDraft, usePageDraftGuard } from "../../lib/page-draft-guard"
import { fetchServices } from "../../lib/services"
import { usePdfUrl } from "../patient/document-paper-panel"
import { ConsentReading } from "../public/link-steps"
import { TemplatesSkeleton } from "../skeletons/settings"
import { SettingsLoadError } from "./load-error"

/** Todas las versiones de un consentimiento, y cuál es la que se ve y se edita. */
interface ConsentGroup {
  key: string
  versions: ConsentTemplate[]
  /** La que se usa hoy o, si no hay, la última. */
  shown: ConsentTemplate
  /** Un borrador de antes de esta pantalla, si quedó uno. */
  draft: ConsentTemplate | null
  active: boolean
}

function groupConsents(templates: ConsentTemplate[]): ConsentGroup[] {
  const byKey = new Map<string, ConsentTemplate[]>()
  for (const item of templates) byKey.set(item.key, [...(byKey.get(item.key) ?? []), item])
  return [...byKey.entries()]
    .map(([key, list]) => {
      const versions = list.toSorted((a, b) => b.version - a.version)
      const published = versions.find((row) => row.status === "publicado")
      const draft = versions.find((row) => row.status === "borrador") ?? null
      return { key, versions, shown: published ?? versions[0]!, draft, active: Boolean(published) }
    })
    .sort((a, b) => a.shown.title.localeCompare(b.shown.title, "es"))
}

function useConsentTemplates() {
  return useQuery({ queryKey: ["consent-templates"], queryFn: () => fetchConsentTemplates(), retry: 1 })
}

function useConsentRefresh() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["consent-templates"] })
    void queryClient.invalidateQueries({ queryKey: ["consent-templates-published"] })
  }
}

/** Los servicios unidos a cada consentimiento, con sus nombres aunque no estén en la primera página. */
function useConsentServices() {
  const links = useQuery({ queryKey: ["consent-template-services"], queryFn: fetchConsentTemplateServices })
  const ids = [...new Set((links.data?.data ?? []).flatMap((link) => link.serviceIds))].sort()
  const names = useQuery({
    queryKey: ["services", "para-consentimientos", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const pages = []
      for (let at = 0; at < ids.length; at += 100) {
        pages.push(fetchServices({ ids: ids.slice(at, at + 100), limit: 100 }))
      }
      return (await Promise.all(pages)).flatMap((page) => page.data)
    },
  })
  const nameOf = useMemo(() => new Map((names.data ?? []).map((service) => [service.id, service.name])), [names.data])
  return {
    nameOf,
    /** Sin la lista no se sabe qué está unido: elegir ahí borraría lo que no se ve. */
    linksLoaded: links.isSuccess,
    linksFailed: links.isError,
    retryLinks: () => void links.refetch(),
    linkedOf: (key: string) => links.data?.data.find((link) => link.templateKey === key)?.serviceIds ?? [],
  }
}

function servicesLine(ids: string[], nameOf: Map<string, string>): string {
  if (ids.length === 0) return "Aún no se pide para ningún servicio"
  const names = ids.slice(0, 3).map((id) => nameOf.get(id) ?? "…")
  return `Se pide para: ${names.join(", ")}${ids.length > 3 ? ` y ${ids.length - 3} más` : ""}`
}

type ConsentFilter = "todos" | "revisar" | "apagados"

/**
 * La lista: cada consentimiento ya está activo y se enciende o apaga aquí mismo;
 * lo demás (leerlo, cambiarlo, para qué servicios) se abre desde su fila.
 */
export function ConsentTemplatesList() {
  const canAdmin = usePermission("settings.write")
  const navigate = useNavigate()
  const listQuery = useConsentTemplates()
  const groups = useMemo(() => groupConsents(listQuery.data?.data ?? []), [listQuery.data])
  const { nameOf, linkedOf, linksLoaded } = useConsentServices()
  const refresh = useConsentRefresh()
  const [filter, setFilter] = useState<ConsentFilter>("todos")
  const [turningOff, setTurningOff] = useState<ConsentTemplate | null>(null)
  const [preview, setPreview] = useState<ConsentPreviewDraft | null>(null)

  const activeMutation = useMutation({
    mutationFn: ({ template, active }: { template: ConsentTemplate; active: boolean }) =>
      setConsentTemplateActive(template.id, active),
    onSuccess: (_result, { template, active }) => {
      setTurningOff(null)
      toast.success(active ? `«${template.title}» está activo` : `«${template.title}» quedó apagado`)
      refresh()
    },
    onError: (error) => {
      setTurningOff(null)
      toast.error(submitErrorMessage(error))
    },
  })

  const openSheet = (key: string) => void navigate({ to: "/settings/forms", search: { consentimiento: key } })
  const unreviewed = groups.filter((group) => !group.shown.reviewedAt)
  const off = groups.filter((group) => !group.active)
  const shown = filter === "revisar" ? unreviewed : filter === "apagados" ? off : groups
  const neverLoaded = listQuery.isError && listQuery.data === undefined
  const filters: Array<{ id: ConsentFilter; label: string; count: number }> = [
    { id: "todos", label: "Todos", count: groups.length },
    { id: "revisar", label: "Sin revisar", count: unreviewed.length },
    { id: "apagados", label: "Apagados", count: off.length },
  ]

  return (
    <div className="flex flex-col gap-4">
      {canAdmin ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => openSheet("nuevo")}>
            <Plus aria-hidden />
            Nuevo consentimiento
          </Button>
        </div>
      ) : null}

      {listQuery.isPending ? (
        <TemplatesSkeleton />
      ) : neverLoaded ? (
        <SettingsLoadError what="los consentimientos" onRetry={() => void listQuery.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="Aún no hay consentimientos"
          description="Escribe el primero: en qué consiste, beneficios, riesgos, alternativas y qué pasa si no se trata."
          {...(canAdmin ? { actionLabel: "Nuevo consentimiento", onAction: () => openSheet("nuevo") } : {})}
        />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="los consentimientos" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {unreviewed.length > 0 ? (
            <PageNotice tone="aviso" label="Textos por revisar">
              {`${groups.length - unreviewed.length} de ${groups.length} revisados. Los demás ya se pueden usar: pide a un profesional de tu clínica que los lea, porque es lo que firma el paciente.`}
            </PageNotice>
          ) : null}
          {unreviewed.length > 0 || off.length > 0 || filter !== "todos" ? (
            <div role="group" aria-label="Filtrar" className="flex flex-wrap gap-2">
              {filters.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={filter === item.id ? "secondary" : "outline"}
                  aria-pressed={filter === item.id}
                  className="min-h-11 sm:min-h-8"
                  onClick={() => setFilter(item.id)}
                >
                  {item.label} · {item.count}
                </Button>
              ))}
            </div>
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguno con este filtro.</p>
          ) : (
            <ul className="elevated divide-y rounded-xl border bg-card">
              {shown.map((group) => {
                const { shown: template, active } = group
                return (
                  <li key={group.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                    <div className="min-w-0 flex-[999_1_18rem]">
                      <p className={active ? "font-medium" : "font-medium text-muted-foreground"}>{template.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {linksLoaded ? servicesLine(linkedOf(group.key), nameOf) : "Servicios por cargar"}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-sm">
                        {template.reviewedAt ? (
                          <>
                            <Check aria-hidden className="size-3.5 text-success" />
                            <span className="text-success">Revisado</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Sin revisar</span>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {template.sections ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`Vista previa de ${template.title}`}
                          onClick={() =>
                            setPreview({
                              title: template.title,
                              sections: template.sections as ConsentSections,
                            })
                          }
                        >
                          Vista previa
                        </Button>
                      ) : null}
                      {canAdmin ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`Editar ${template.title}`}
                          onClick={() => openSheet(group.key)}
                        >
                          <Pencil aria-hidden />
                          Editar
                        </Button>
                      ) : null}
                      {canAdmin ? (
                        <div className="flex min-h-11 items-center gap-2 pl-1 text-sm sm:min-h-8">
                          <Switch
                            checked={active}
                            disabled={activeMutation.isPending}
                            aria-label={`${template.title}: ${active ? "activo" : "apagado"}`}
                            onCheckedChange={(next) =>
                              next ? activeMutation.mutate({ template, active: true }) : setTurningOff(template)
                            }
                          />
                          <span aria-hidden>{active ? "Activo" : "Apagado"}</span>
                        </div>
                      ) : (
                        <Badge variant={active ? "default" : "secondary"}>{active ? "Activo" : "Apagado"}</Badge>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {canAdmin ? (
        <p className="text-sm text-muted-foreground">
          ¿Quieres hacerles a tus pacientes una pregunta propia?{" "}
          <Link
            to="/settings/forms"
            search={{ tab: "formularios" }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Crear un formulario
          </Link>
        </p>
      ) : null}

      {preview ? <ConsentPreviewDrawer draft={preview} onClose={() => setPreview(null)} /> : null}
      <ConfirmDialog
        open={turningOff !== null}
        variant="default"
        title={turningOff ? `Apagar «${turningOff.title}»` : "Apagar"}
        description="La atención deja de ofrecerlo y de pedirlo. Lo ya preparado o firmado no cambia, y puedes volver a encenderlo cuando quieras."
        confirmLabel="Apagar"
        pending={activeMutation.isPending}
        onClose={() => setTurningOff(null)}
        onConfirm={() => turningOff && activeMutation.mutate({ template: turningOff, active: false })}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vista previa
// ---------------------------------------------------------------------------

interface ConsentPreviewDraft {
  title: string
  sections: ConsentSections
}

/**
 * Cómo queda de verdad: el PDF sale del servidor, con el mismo generador de lo que
 * se firma, y lo del teléfono es la misma lectura que ve el paciente en su enlace.
 * Con una persona de ejemplo: nada de esto se guarda.
 */
function ConsentPreviewDrawer({ draft, onClose }: { draft: ConsentPreviewDraft; onClose: () => void }) {
  const mobile = useIsMobile() === true
  const pdf = useQuery({
    queryKey: ["consent-preview", draft],
    queryFn: () => fetchConsentPreview(draft),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const url = usePdfUrl(pdf.data)
  return (
    <DetailDrawer
      open
      size="xl"
      title={`Vista previa · ${draft.title || "Sin título"}`}
      description="Con una persona de ejemplo. No se guarda en ninguna ficha."
      onClose={onClose}
    >
      <Tabs defaultValue="pdf" className="flex flex-col gap-4 p-4">
        <TabsList aria-label="Vista">
          <TabsTrigger value="pdf">Hoja PDF</TabsTrigger>
          <TabsTrigger value="telefono">En el teléfono del paciente</TabsTrigger>
        </TabsList>
        <TabsContent value="pdf">
          {pdf.isError ? (
            <ErrorState
              title="No se pudo armar la vista previa"
              message={`${submitErrorMessage(pdf.error)}. Revisa lo escrito y vuelve a abrirla.`}
              onRetry={() => void pdf.refetch()}
            />
          ) : !url ? (
            <LoadingState kind="indeterminate" message="Armando la hoja…" />
          ) : mobile ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-center">
              <FileText aria-hidden className="size-10 text-muted-foreground" />
              <p className="text-sm font-medium break-words">{draft.title}</p>
              <a href={url} target="_blank" rel="noopener" className={buttonVariants({ className: "min-h-11 w-full" })}>
                Abrir PDF
              </a>
            </div>
          ) : (
            <iframe
              title={`Hoja de ${draft.title}`}
              src={url}
              className="h-[calc(100dvh-16rem)] min-h-96 w-full rounded-lg border bg-muted/30"
            />
          )}
        </TabsContent>
        <TabsContent value="telefono">
          <div className="mx-auto flex max-w-[24rem] flex-col gap-4 rounded-[2rem] border-8 border-foreground/80 bg-background p-5">
            <h2 className="text-lg font-semibold">{draft.title}</h2>
            <ConsentReading sections={draft.sections} body={null} />
            <p className="text-sm text-muted-foreground">
              Después escribe su documento, marca que entendió y firma con el dedo.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </DetailDrawer>
  )
}

// ---------------------------------------------------------------------------
// La hoja
// ---------------------------------------------------------------------------

const toLines = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean)

interface ConsentValues {
  title: string
  procedure: string
  benefits: string[]
  risks: string[]
  alternatives: string[]
  consequences: string
  notes: string
}

/** Las tres listas, con el nombre de cada línea para decir en cuál está el problema. */
const CONSENT_LISTS = [
  { name: "benefits", label: "Beneficios esperados", one: "beneficio", many: "beneficios", a: "un", the: "El" },
  { name: "risks", label: "Riesgos y molestias", one: "riesgo", many: "riesgos", a: "un", the: "El" },
  { name: "alternatives", label: "Alternativas", one: "alternativa", many: "alternativas", a: "una", the: "La" },
] as const

function consentSectionsOf(value: ConsentValues): ConsentSections {
  return {
    procedure: value.procedure.trim(),
    benefits: toLines(value.benefits),
    risks: toLines(value.risks),
    alternatives: toLines(value.alternatives),
    consequences: value.consequences.trim(),
    notes: value.notes.trim() || null,
  }
}

const CONSENT_SECTION_KEYS = ["procedure", "benefits", "risks", "alternatives", "consequences", "notes"] as const

/**
 * Los mismos límites que la ruta y el servidor (≤20 líneas de ≤500 caracteres por
 * lista y 20000 en total), dichos en la sección que hay que corregir; si el total
 * se pasa, en la más larga.
 */
const consentSchema = z
  .object({
    title: z.string().trim().min(1, "Escribe el título").max(200, "El título admite hasta 200 caracteres"),
    procedure: z
      .string()
      .trim()
      .min(10, "Describe el procedimiento (al menos 10 caracteres)")
      .max(4000, "El procedimiento admite hasta 4000 caracteres"),
    benefits: z.array(z.string()),
    risks: z.array(z.string()),
    alternatives: z.array(z.string()),
    consequences: z
      .string()
      .trim()
      .min(10, "Describe las consecuencias de no tratarse (al menos 10 caracteres)")
      .max(4000, "Las consecuencias admiten hasta 4000 caracteres"),
    notes: z.string().max(4000, "La información adicional admite hasta 4000 caracteres"),
  })
  .superRefine((value, ctx) => {
    for (const list of CONSENT_LISTS) {
      const items = toLines(value[list.name])
      const long = items.findIndex((item) => item.length > 500)
      const message =
        items.length === 0
          ? `Indica al menos ${list.a} ${list.one}`
          : items.length > 20
            ? `Escribe como mucho 20 ${list.many} (hay ${items.length})`
            : long >= 0
              ? `${list.the} ${list.one} ${long + 1} supera 500 caracteres`
              : null
      if (message) ctx.addIssue({ code: "custom", path: [list.name], message })
    }
    const sections = consentSectionsOf(value)
    if (consentSectionsToText(sections).length > 20000) {
      const size = (key: (typeof CONSENT_SECTION_KEYS)[number]) => {
        const text = sections[key]
        return Array.isArray(text) ? text.join("\n").length : (text ?? "").length
      }
      const longest = CONSENT_SECTION_KEYS.reduce((a, b) => (size(b) > size(a) ? b : a))
      ctx.addIssue({
        code: "custom",
        path: [longest],
        message: "El consentimiento supera 20000 caracteres en total: acorta esta sección",
      })
    }
  })

/** Lo editable se ve siempre, también sin pasar el mouse: un recuadro punteado. */
const SHEET_FIELD =
  "min-h-0 rounded-md border-dashed border-primary/40 bg-primary-soft/25 px-2 py-1 text-sm hover:bg-primary-soft/60 focus-visible:border-transparent focus-visible:bg-background"
const SHEET_LABEL = "text-sm font-bold text-foreground"
/** Lo que se completa solo con cada paciente: en gris y sin recuadro. */
const SHEET_FIXED = "rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"

/**
 * Una lista de la hoja: cada línea se escribe ahí mismo. Enter agrega otra, borrar
 * una vacía la quita y pegar varias líneas las separa.
 */
function SheetLines({
  id,
  invalid,
  describedBy,
  label,
  one,
  a,
  lines,
  onChange,
  onBlur,
}: {
  id: string
  invalid: boolean
  describedBy: string | undefined
  label: string
  one: string
  a: string
  lines: string[]
  onChange: (lines: string[]) => void
  onBlur: () => void
}) {
  const list = useRef<HTMLUListElement | null>(null)
  const [focusLine, setFocusLine] = useState<number | null>(null)
  useEffect(() => {
    if (focusLine === null) return
    list.current?.querySelectorAll("textarea")[focusLine]?.focus()
    setFocusLine(null)
  }, [focusLine])
  const replace = (index: number, text: string[]) => {
    const next = [...lines]
    next.splice(index, 1, ...text)
    onChange(next)
  }
  return (
    <div>
      <ul ref={list} className="flex flex-col gap-1">
        {lines.map((line, index) => (
          // El índice es la identidad: las líneas no tienen otra y escribir no las reordena.
          // biome-ignore lint/suspicious/noArrayIndexKey: ver arriba
          <li key={index} className="flex items-start gap-1.5">
            <span aria-hidden className="pt-1 text-sm">
              •
            </span>
            <Textarea
              id={index === 0 ? id : undefined}
              aria-label={`${label}, línea ${index + 1}`}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              rows={1}
              value={line}
              className={SHEET_FIELD}
              onBlur={onBlur}
              onChange={(event) => replace(index, [event.target.value])}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text")
                if (!pasted.includes("\n")) return
                event.preventDefault()
                replace(index, pasted.split("\n").map((text) => text.replace(/^[•*-]\s*/, "").trim()).filter(Boolean))
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  const next = [...lines]
                  next.splice(index + 1, 0, "")
                  onChange(next)
                  setFocusLine(index + 1)
                } else if (event.key === "Backspace" && line === "" && lines.length > 1) {
                  event.preventDefault()
                  onChange(lines.filter((_, at) => at !== index))
                  setFocusLine(Math.max(0, index - 1))
                }
              }}
            />
            {lines.length > 1 ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Quitar la línea ${index + 1} de ${label}`}
                onClick={() => onChange(lines.filter((_, at) => at !== index))}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="link"
        className="mt-1 min-h-11 px-0 sm:min-h-8"
        onClick={() => {
          onChange([...lines, ""])
          setFocusLine(lines.length)
        }}
      >
        <Plus aria-hidden />
        Agregar {a === "una" ? "otra" : "otro"} {one}
      </Button>
    </div>
  )
}

/** Abre la hoja de un consentimiento (o una en blanco) cuando llegan sus datos. */
export function ConsentSheetPage({ consentKey }: { consentKey: string }) {
  const navigate = useNavigate()
  const listQuery = useConsentTemplates()
  const isNew = consentKey === "nuevo"
  const group = useMemo(
    () => groupConsents(listQuery.data?.data ?? []).find((item) => item.key === consentKey) ?? null,
    [listQuery.data, consentKey],
  )
  if (!isNew && listQuery.isPending) return <TemplatesSkeleton />
  if (!isNew && listQuery.isError && !listQuery.data) {
    return <SettingsLoadError what="el consentimiento" onRetry={() => void listQuery.refetch()} />
  }
  if (!isNew && !group) {
    return (
      <EmptyState
        title="No encontramos este consentimiento"
        description="Vuelve a la lista para elegir otro."
        actionLabel="Ver los consentimientos"
        onAction={() => void navigate({ to: "/settings/forms" })}
      />
    )
  }
  return <ConsentSheet key={consentKey} group={group} />
}

function ConsentSheet({ group }: { group: ConsentGroup | null }) {
  const navigate = useNavigate()
  const refresh = useConsentRefresh()
  const canAdmin = usePermission("settings.write")
  // Si quedó un borrador se sigue desde él: guardar lo deja en uso, y no se pierde lo escrito.
  const template = group?.draft ?? group?.shown ?? null
  const { nameOf, linkedOf, linksLoaded, linksFailed, retryLinks } = useConsentServices()
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<ConsentPreviewDraft | null>(null)
  const [choosingServices, setChoosingServices] = useState(false)
  const [turningOff, setTurningOff] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const save = useMutation({ mutationFn: saveConsentTemplate })
  const [defaultValues] = useState<ConsentValues>(() => {
    const base = template?.sections ?? null
    return {
      title: template?.title ?? "",
      procedure: base?.procedure ?? "",
      benefits: base?.benefits.length ? base.benefits : [""],
      risks: base?.risks.length ? base.risks : [""],
      alternatives: base?.alternatives.length ? base.alternatives : [""],
      consequences: base?.consequences ?? "",
      notes: base?.notes ?? "",
    }
  })
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: consentSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        ...(template ? { key: template.key } : {}),
        title: value.title.trim(),
        sections: consentSectionsOf(value),
      })
      refresh()
      toast.success(
        template
          ? "Guardado. Los nuevos usarán este texto; lo ya firmado no cambia."
          : "Listo: ya está activo. Elige para qué servicios se pide.",
      )
      setLeaving(true)
    },
  })
  // El servidor nombra las secciones como van en el cuerpo (`sections.risks[3]`); aquí cada lista es un campo.
  const submit = useFormSubmit(form, {
    fieldMap: (key) => key.replace(/^sections\./, "").replace(/\[\d+\]$/, ""),
  })
  const submitError = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const values = useStore(form.store, (state) => state.values)
  const dirty = !leaving && !sameDraft(values, defaultValues)
  const guard = usePageDraftGuard(dirty)
  const backToList = () => void navigate({ to: "/settings/forms" })
  useEffect(() => {
    if (leaving) backToList()
    // Solo al terminar de guardar: `navigate` cambia con la ruta.
    // biome-ignore lint/correctness/useExhaustiveDependencies: ver arriba
  }, [leaving])

  const activeMutation = useMutation({
    mutationFn: (active: boolean) => setConsentTemplateActive(template!.id, active),
    onSuccess: (_result, active) => {
      setTurningOff(false)
      toast.success(active ? "Está activo" : "Quedó apagado")
      refresh()
    },
    onError: (error) => {
      setTurningOff(false)
      toast.error(submitErrorMessage(error))
    },
  })
  const reviewMutation = useMutation({
    mutationFn: () => markConsentTemplateReviewed(template!.id),
    onSuccess: () => {
      toast.success("Quedó como revisado")
      refresh()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  const linked = template ? linkedOf(template.key) : []
  const showPreview = () => {
    setPreview({
      title: values.title.trim(),
      sections: consentSectionsOf(values),
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" variant="ghost" className="min-h-11 -ml-2" onClick={() => guard.requestLeave(backToList)}>
          <ArrowLeft aria-hidden />
          Consentimientos
        </Button>
        <p aria-live="polite" className="min-w-24 flex-1 text-sm text-muted-foreground">
          {dirty ? "Cambios sin guardar" : template ? "Sin cambios" : "Consentimiento nuevo"}
        </p>
        <Button type="button" variant="outline" className="min-h-11" onClick={showPreview}>
          Vista previa
        </Button>
        {canAdmin ? (
          <SubmitButton type="submit" className="min-h-11" pending={pending}>
            Guardar cambios
          </SubmitButton>
        ) : null}
      </div>
      {submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-3">
          <p className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground">
            <strong className="font-semibold">Toca un recuadro punteado y escribe.</strong> Enter agrega otra línea. Lo
            gris se completa solo con cada paciente.
          </p>
          {group?.draft ? (
            <p className="text-sm text-muted-foreground">
              Sigues un borrador que quedó sin publicar. Al guardar, este texto queda en uso.
            </p>
          ) : null}
          {template && !template.sections ? (
            <Collapsible className="rounded-xl border p-3 text-sm">
              <CollapsibleTrigger
                render={
                  <Button type="button" variant="ghost" size="sm" className="group min-h-11 w-full justify-between sm:min-h-8">
                    Texto anterior, como referencia
                    <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
                  </Button>
                }
              />
              <CollapsibleContent>
                <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{template.body}</p>
              </CollapsibleContent>
            </Collapsible>
          ) : null}

          <article
            aria-label="Hoja del consentimiento"
            className="elevated flex flex-col gap-4 rounded-sm border bg-card p-4 sm:p-10"
          >
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Consentimiento informado</p>
              <form.AppField name="title">
                {(field) => (
                  <field.TextareaField
                    label="Título"
                    hideLabel
                    rows={1}
                    maxLength={200}
                    disabled={!canAdmin}
                    placeholder="Título, por ejemplo «Exodoncia»"
                    textareaClassName={`${SHEET_FIELD} font-serif text-2xl leading-tight font-semibold md:text-2xl`}
                  />
                )}
              </form.AppField>
            </div>
            <div className={`${SHEET_FIXED} grid grid-cols-1 gap-1 sm:grid-cols-3`}>
              <span>
                <strong className="block font-semibold">Paciente</strong>Se completa solo
              </span>
              <span>
                <strong className="block font-semibold">Documento</strong>Se completa solo
              </span>
              <span>
                <strong className="block font-semibold">Historia clínica</strong>Se completa solo
              </span>
            </div>
            <form.AppField name="procedure">
              {(field) => (
                <field.TextareaField
                  label={<span className={SHEET_LABEL}>Procedimiento propuesto</span>}
                  rows={2}
                  maxLength={4000}
                  disabled={!canAdmin}
                  placeholder="Explica en palabras simples en qué consiste."
                  textareaClassName={SHEET_FIELD}
                />
              )}
            </form.AppField>
            <p className={SHEET_FIXED}>
              <strong className="font-semibold">Diagnóstico que lo motiva</strong> · se toma de la atención
            </p>
            {CONSENT_LISTS.map((list) => (
              <form.AppField key={list.name} name={list.name}>
                {(field) => (
                  <field.Control label={<span className={SHEET_LABEL}>{list.label}</span>}>
                    {(control) => (
                      <SheetLines
                        id={control.id}
                        invalid={control.invalid}
                        describedBy={control.describedBy}
                        label={list.label}
                        one={list.one}
                        a={list.a}
                        lines={field.state.value}
                        onBlur={control.onBlur}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ))}
            <form.AppField name="consequences">
              {(field) => (
                <field.TextareaField
                  label={<span className={SHEET_LABEL}>Consecuencias de no tratarse</span>}
                  rows={2}
                  maxLength={4000}
                  disabled={!canAdmin}
                  placeholder="Qué puede pasar si decide no hacerlo."
                  textareaClassName={SHEET_FIELD}
                />
              )}
            </form.AppField>
            <form.AppField name="notes">
              {(field) => (
                <field.TextareaField
                  label={<span className={SHEET_LABEL}>Información adicional (opcional)</span>}
                  description="Si la dejas vacía, no sale en la hoja."
                  rows={1}
                  maxLength={4000}
                  disabled={!canAdmin}
                  placeholder="Indicaciones que quieras añadir."
                  textareaClassName={SHEET_FIELD}
                />
              )}
            </form.AppField>
            <div className={SHEET_FIXED}>
              <strong className="block font-semibold">Declaración y firmas</strong>
              La declaración es la misma en todos. El paciente firma al aceptarla y el profesional que informa, con su perfil.
            </div>
          </article>
        </div>

        <aside aria-label="Ajustes del consentimiento" className="flex min-w-0 flex-[1_1_16rem] flex-col gap-3">
          {template && canAdmin ? (
            <section className="elevated flex flex-col gap-1 rounded-xl border bg-card p-4">
              <label className="flex min-h-11 items-center justify-between gap-2 font-semibold">
                {group?.active ? "Activo" : "Apagado"}
                <Switch
                  checked={Boolean(group?.active)}
                  disabled={activeMutation.isPending}
                  onCheckedChange={(next) => (next ? activeMutation.mutate(true) : setTurningOff(true))}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                {group?.active
                  ? "La atención lo ofrece y se puede firmar por la web."
                  : "La atención no lo ofrece. Lo ya firmado no cambia."}
              </p>
            </section>
          ) : null}
          {template ? (
            <section className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h2 className="font-semibold">Se pide para</h2>
              <p className="text-sm text-muted-foreground">Al registrar estos servicios, la atención lo prepara sola.</p>
              {linksFailed ? (
                <SettingsLoadError what="los servicios" onRetry={retryLinks} />
              ) : !linksLoaded ? (
                <p className="text-sm text-muted-foreground">Cargando los servicios…</p>
              ) : linked.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {linked.map((id) => (
                    <li key={id}>
                      <Badge variant="secondary">{nameOf.get(id) ?? "…"}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">Ningún servicio todavía: se prepara a mano desde la atención.</p>
              )}
              {canAdmin && linksLoaded ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => setChoosingServices(true)}>
                  Elegir servicios
                </Button>
              ) : null}
            </section>
          ) : null}
          {template ? (
            <section className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h2 className="font-semibold">Revisión</h2>
              {template.reviewedAt ? (
                <p className="flex items-center gap-1 text-sm text-success">
                  <Check aria-hidden className="size-3.5" />
                  {template.reviewerName ? `Revisado por ${template.reviewerName}` : "Revisado"}
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Nadie de la clínica lo ha revisado. Se puede usar mientras tanto.</p>
                  {canAdmin ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={reviewMutation.isPending}
                      onClick={() => reviewMutation.mutate()}
                    >
                      Marcar como revisado
                    </Button>
                  ) : null}
                </>
              )}
              <p className="border-t pt-2 text-sm text-muted-foreground">
                {`Versión ${template.version}. Lo ya firmado conserva su texto, aunque cambies este.`}
              </p>
            </section>
          ) : null}
        </aside>
      </div>

      {preview ? <ConsentPreviewDrawer draft={preview} onClose={() => setPreview(null)} /> : null}
      {choosingServices && template ? (
        <ConsentServicesDrawer
          template={template}
          selected={linked}
          names={nameOf}
          onClose={() => setChoosingServices(false)}
          onSaved={() => {
            setChoosingServices(false)
            void queryClient.invalidateQueries({ queryKey: ["consent-template-services"] })
          }}
        />
      ) : null}
      <ConfirmDialog
        open={turningOff}
        variant="default"
        title={template ? `Apagar «${template.title}»` : "Apagar"}
        description="La atención deja de ofrecerlo y de pedirlo. Lo ya preparado o firmado no cambia, y puedes volver a encenderlo cuando quieras."
        confirmLabel="Apagar"
        pending={activeMutation.isPending}
        onClose={() => setTurningOff(false)}
        onConfirm={() => activeMutation.mutate(false)}
      />
      {guard.dialog}
    </form>
  )
}

/**
 * «Se pide para»: los servicios por los que la atención propone este
 * consentimiento («Necesita consentimiento · Preparar»). Es configuración, no
 * contenido: se guarda para la plantilla y todas sus versiones.
 */
function ConsentServicesDrawer({
  template,
  selected,
  names,
  onClose,
  onSaved,
}: {
  template: ConsentTemplate
  selected: string[]
  /** Nombres de los servicios ya unidos (de cualquier página del tarifario). */
  names: Map<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const ids = useId()
  const canAdmin = usePermission("settings.write")
  const [query, setQuery] = useState("")
  // Se busca en el servidor, en todo el tarifario: nunca una lista cortada en silencio.
  const q = useDeferredValue(query.trim())
  const searchQuery = useQuery({
    queryKey: ["services", "para-consentimientos", "buscar", q],
    queryFn: () => fetchServices({ q: q || undefined, state: "active", limit: 30 }),
    placeholderData: (previous) => previous,
  })
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map(names))
  const save = useMutation({
    mutationFn: (serviceIds: string[]) => saveConsentTemplateServices(template.id, serviceIds),
  })
  // Valores iniciales una sola vez, al abrir.
  const [defaultValues] = useState(() => ({ serviceIds: selected }))
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: consentServicesSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value.serviceIds)
      const count = value.serviceIds.length
      toast.success(`«${template.title}» se pide para ${count} servicio${count === 1 ? "" : "s"}`)
      onSaved()
    },
  })
  const surface = useFormSurface(form)
  const chosen = useStore(form.store, (state) => state.values.serviceIds)
  const found = searchQuery.data?.data ?? []
  const total = searchQuery.data?.total ?? 0
  // Lo elegido va primero, aunque la búsqueda no lo traiga; después, lo encontrado.
  const shown = [
    ...chosen.map((id) => ({ id, name: picked.get(id) ?? names.get(id) ?? "…" })),
    ...found.filter((service) => !chosen.includes(service.id)).map((service) => ({ id: service.id, name: service.name })),
  ]
  const services = found
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={`Se pide para · ${template.title}`}
      description="Al registrar o indicar uno de estos servicios, la atención propone preparar este consentimiento."
      submitDisabled={!canAdmin}
    >
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={`${ids}-q`}>Buscar un servicio</FieldLabel>
          <Input id={`${ids}-q`} value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <form.AppField name="serviceIds">
          {(field) => (
            <field.Group legend={<span className="sr-only">Servicios por los que se pide</span>} className="gap-2">
              {(control) =>
                searchQuery.isPending ? (
                  <p className="text-sm text-muted-foreground">Cargando servicios…</p>
                ) : searchQuery.isError && found.length === 0 ? (
                  <SettingsLoadError what="los servicios" onRetry={() => void searchQuery.refetch()} />
                ) : shown.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {q ? "Ningún servicio coincide." : "Aún no hay servicios en la lista de la clínica."}
                  </p>
                ) : (
                  <ul
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    className="flex flex-col gap-2"
                  >
                    {shown.map((service) => (
                      <li key={service.id}>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={chosen.includes(service.id)}
                            disabled={!canAdmin}
                            onCheckedChange={(value) => {
                              if (value === true) setPicked((known) => new Map(known).set(service.id, service.name))
                              field.handleChange((current) =>
                                value === true ? [...current, service.id] : current.filter((id) => id !== service.id),
                              )
                            }}
                          />
                          {service.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )
              }
            </field.Group>
          )}
        </form.AppField>
        {total > services.length ? (
          <p className="text-xs text-muted-foreground">
            {`Se ven ${services.length} de ${total} servicios: escribe el nombre para encontrar el resto.`}
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** El tope de la ruta (`PUT /consent-templates/:id/services`), dicho antes de enviar. */
const consentServicesSchema = z.object({
  serviceIds: z.array(z.string()).max(100, "Elige como mucho 100 servicios"),
})
