import { type ConsentSections, consentSectionsToText } from "@odentia/clinical"
import { productUi } from "../../product/product-ui"
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  type FieldControl,
  fieldErrorMessages,
  FormChoiceField,
  FormDrawer,
  PageHeader,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ChevronDown, Plus, X } from "lucide-react"
import { type ReactNode, useDeferredValue, useId, useMemo, useState } from "react"
import { z } from "zod"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import {
  archiveConsentTemplate,
  archiveFormTemplate,
  type ConsentTemplate,
  createConsentTemplate,
  createFormTemplate,
  createSuggestedConsentTemplates,
  FIELD_TYPE_LABELS,
  type FormFieldDef,
  type FormFieldType,
  type FormSchemaDef,
  type FormSectionDef,
  type FormTemplate,
  fetchConsentTemplates,
  fetchFormTemplates,
  fetchSpecialties,
  publishConsentTemplate,
  publishFormTemplate,
  updateConsentTemplate,
  updateFormTemplate,
} from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import { fetchConsentTemplateServices, saveConsentTemplateServices } from "../../lib/encounter-documents"
import { fetchServices } from "../../lib/services"

export const Route = createFileRoute("/_org/settings/forms")({
  // «Te espera» abre directo la pestaña de consentimientos (?tab=consentimientos).
  validateSearch: (search: Record<string, unknown>): { tab?: "formularios" | "consentimientos" } =>
    search.tab === "consentimientos" || search.tab === "formularios" ? { tab: search.tab } : {},
  component: FormulariosPage,
})

const TITLE = "Formularios y consentimientos"
const SUBTITLE = "Las plantillas que usa tu clínica. Se preparan en borrador y se publican; lo ya respondido o firmado no cambia."

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]

/** El estado de una versión, con las mismas palabras en las dos pestañas. */
const TEMPLATE_STATUS_LABELS: Record<"borrador" | "publicado" | "archivado", string> = {
  borrador: "borrador",
  publicado: "vigente",
  archivado: "archivada",
}

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-3 rounded-xl border bg-card p-4"
const ROW_BUTTON = "min-h-11 sm:min-h-8"

/**
 * Formularios clínicos y consentimientos: plantillas por secciones y campos,
 * con versiones. Una versión publicada no se edita: se prepara la siguiente.
 */
function FormulariosPage() {
  const canRead = usePermission("settings.read")
  const search = Route.useSearch()
  const [tab, setTab] = useState<string>(search.tab ?? "formularios")
  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Plantillas">
          <TabsTrigger value="formularios">Formularios clínicos</TabsTrigger>
          <TabsTrigger value="consentimientos">Consentimientos</TabsTrigger>
        </TabsList>
        {/* Las dos siguen montadas: cambiar de pestaña no descarta un borrador abierto al lado. */}
        <TabsContent value="formularios" className="pt-4" keepMounted>
          <FormTemplatesPanel />
        </TabsContent>
        <TabsContent value="consentimientos" className="pt-4" keepMounted>
          <ConsentTemplatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** El hueco de la lista mientras carga: el mismo en las dos pestañas. */
function TemplatesSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {label}
      </p>
      {["w-56", "w-44", "w-64"].map((width) => (
        <div key={width} className={CARD} aria-hidden>
          <Skeleton className={`h-5 max-w-full ${width}`} />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-48" />
        </div>
      ))}
    </div>
  )
}

/** Las versiones de una plantilla, de la más nueva a la más antigua. */
function byTemplate<T extends { key: string; version: number; title: string }>(templates: T[]): T[][] {
  const byKey = new Map<string, T[]>()
  for (const item of templates) {
    const list = byKey.get(item.key) ?? []
    list.push(item)
    byKey.set(item.key, list)
  }
  return [...byKey.values()]
    .map((versions) => versions.sort((a, b) => b.version - a.version))
    .sort((a, b) => (a[0]?.title ?? "").localeCompare(b[0]?.title ?? "", "es"))
}

/** Las acciones de la lista: iguales de sitio en las dos pestañas. */
function PanelActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>
}

// ---------------------------------------------------------------------------
// Formularios clínicos
// ---------------------------------------------------------------------------

function slugifyLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
  return base || "campo"
}

function FormTemplatesPanel() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("settings.write")
  // Al lado: una plantilla nueva, un borrador o la versión de la que parte la siguiente.
  const builder = useSideForm<FormTemplate>()
  const openBuilder = builder.open
  const [confirm, setConfirm] = useState<
    { kind: "publish"; draft: FormTemplate } | { kind: "archive"; draft: FormTemplate } | null
  >(null)

  const listQuery = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => fetchFormTemplates(),
    retry: 1,
  })
  const templates = listQuery.data?.data ?? []
  const grouped = useMemo(() => byTemplate(templates), [templates])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["form-templates"] })

  const publishMutation = useMutation({
    mutationFn: (draft: FormTemplate) => publishFormTemplate(draft.id),
    onSuccess: (_result, draft) => {
      setConfirm(null)
      toast.success(`Versión ${draft.version} de «${draft.title}» publicada`)
      void invalidate()
    },
    onError: (error) => {
      setConfirm(null)
      toast.error(submitErrorMessage(error))
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (draft: FormTemplate) => archiveFormTemplate(draft.id),
    onSuccess: (_result, draft) => {
      setConfirm(null)
      toast.success(`Borrador de «${draft.title}» archivado`)
      void invalidate()
    },
    onError: (error) => {
      setConfirm(null)
      toast.error(submitErrorMessage(error))
    },
  })

  const neverLoaded = listQuery.isError && listQuery.data === undefined
  const publishing = confirm?.kind === "publish" ? confirm.draft : null
  const replaced = publishing
    ? templates.find((template) => template.key === publishing.key && template.status === "publicado")
    : undefined

  return (
    <div className="flex flex-col gap-4">
      {canAdmin && grouped.length > 0 ? (
        <PanelActions>
          <Button type="button" className="min-h-11" onClick={() => openBuilder(null)}>
            <Plus aria-hidden />
            Nueva plantilla
          </Button>
        </PanelActions>
      ) : null}

      {listQuery.isPending ? (
        <TemplatesSkeleton label="Cargando las plantillas de formularios…" />
      ) : neverLoaded ? (
        <SettingsLoadError what="las plantillas de formularios" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="las plantillas de formularios" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {grouped.length === 0 ? (
            <EmptyState
              title="Aún no hay plantillas de formularios"
              description="Prepara la primera con sus secciones y campos y publícala para usarla en la ficha del paciente."
              {...(canAdmin ? { actionLabel: "Nueva plantilla", onAction: () => openBuilder(null) } : {})}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map((versions) => {
                const latest = versions[0]
                if (!latest) return null
                const draft = versions.find((version) => version.status === "borrador")
                const current = versions.find((version) => version.status === "publicado")
                return (
                  <li key={latest.key} className={CARD}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{latest.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {current ? `Vigente: versión ${current.version}` : "Sin versión vigente"}
                          {draft ? ` · borrador de la versión ${draft.version}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {versions.map((version) => (
                          <Badge key={version.id} variant={version.status === "publicado" ? "default" : "secondary"}>
                            Versión {version.version} · {TEMPLATE_STATUS_LABELS[version.status]}
                          </Badge>
                        ))}
                        {latest.respondent === "portal" ? <Badge variant="outline">Lo responde el paciente</Badge> : null}
                      </div>
                    </div>
                    {canAdmin ? (
                      <div className="flex flex-wrap gap-2">
                        {draft ? (
                          <>
                            <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={() => openBuilder(draft)}>
                              Editar borrador
                            </Button>
                            <Button type="button" size="sm" className={ROW_BUTTON} onClick={() => setConfirm({ kind: "publish", draft })}>
                              Publicar versión {draft.version}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} onClick={() => setConfirm({ kind: "archive", draft })}>
                              Archivar el borrador
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={() => openBuilder({ ...latest })}>
                            Nueva versión desde la {latest.version}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {builder.form ? (
        <TemplateBuilder
          key={builder.form.opening}
          initial={builder.form.target}
          onDirtyChange={builder.setDirty}
          onClose={builder.close}
          onDone={() => {
            builder.close()
            void invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={builder} what="otra plantilla" />

      <ConfirmDialog
        open={confirm?.kind === "publish"}
        variant="default"
        title={publishing ? `Publicar la versión ${publishing.version}` : "Publicar"}
        description={
          replaced
            ? `La versión ${replaced.version} se archiva y los formularios nuevos usarán la ${publishing?.version}. Lo ya respondido conserva su título y sus preguntas.`
            : "Quedará disponible para responder en la ficha. Una versión publicada ya no se edita: para cambiarla se prepara la siguiente."
        }
        confirmLabel="Publicar"
        pending={publishMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "publish" && publishMutation.mutate(confirm.draft)}
      />
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        variant="default"
        title={confirm?.kind === "archive" ? `Archivar el borrador de «${confirm.draft.title}»` : "Archivar"}
        description="El borrador ya no se podrá editar ni publicar. La versión vigente, si la hay, y lo ya respondido no cambian."
        confirmLabel="Archivar"
        pending={archiveMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "archive" && archiveMutation.mutate(confirm.draft)}
      />
    </div>
  )
}

/** Lo que se edita de una plantilla de formulario; `specialtyId` vacío es «sin especialidad». */
interface TemplateValues {
  title: string
  description: string
  specialtyId: string
  respondent: "staff" | "portal"
  sections: FormSectionDef[]
}

const CHOICE_TYPES: readonly FormFieldType[] = ["opcion_unica", "opcion_multiple"]

/** Las preguntas de las que puede depender otra («Mostrar si»): Sí/No y de opciones. */
const conditionsOn = (field: FormFieldDef) => field.type === "booleano" || CHOICE_TYPES.includes(field.type)

/**
 * Una clave que no tiene ninguna otra sección o pregunta de la plantilla:
 * `base` o, si ya está, `base_2`, `base_3`… Así quitar una pregunta y agregar
 * otra no repite la clave de una que sigue (el servidor las rechaza repetidas).
 */
function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  // El servidor admite claves de hasta 49 caracteres.
  const stem = base.slice(0, 44)
  let n = 2
  while (taken.has(`${stem}_${n}`)) n += 1
  return `${stem}_${n}`
}

/**
 * Lo que se revisa antes de guardar, con las reglas y las palabras del
 * servidor (`assertFormSchema`): cada problema en la pregunta o la sección que
 * hay que corregir, nombrada por su texto.
 */
const templateSchema = z
  .object({
    title: z.string().trim().min(1, "Escribe el título").max(200, "El título admite hasta 200 caracteres"),
    description: z.string().max(2000, "La descripción admite hasta 2000 caracteres"),
    specialtyId: z.string(),
    respondent: z.enum(["staff", "portal"]),
    sections: z.array(z.custom<FormSectionDef>()),
  })
  .superRefine(({ respondent, sections }, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message })
    if (sections.length === 0) issue(["sections"], "Agrega al menos una sección")
    if (sections.length > 30) issue(["sections"], "El formulario admite hasta 30 secciones")
    // Las preguntas ya recorridas: una pregunta solo depende de una anterior.
    const previous = new Map<string, FormFieldDef>()
    sections.forEach((section, si) => {
      const sectionTitle = section.title.trim()
      const sectionName = sectionTitle ? `«${sectionTitle}»` : String(si + 1)
      if (!sectionTitle) issue(["sections", si, "title"], `Escribe el título de la sección ${si + 1}`)
      if (section.fields.length === 0) {
        issue(["sections", si, "fields"], `La sección ${sectionName} necesita al menos un campo`)
      } else if (section.fields.length > 60) {
        issue(["sections", si, "fields"], `La sección ${sectionName} admite hasta 60 campos`)
      }
      section.fields.forEach((field, fi) => {
        const at = ["sections", si, "fields", fi]
        const label = field.label.trim()
        // Sin texto, la pregunta se nombra por su lugar.
        const named = label ? `«${label}»` : `la pregunta ${fi + 1} de la sección ${sectionName}`
        const Named = label ? named : `La pregunta ${fi + 1} de la sección ${sectionName}`
        if (!label) issue([...at, "label"], `Escribe ${named}`)
        if (respondent === "portal" && field.type === "adjunto") {
          issue([...at, "type"], `${Named}: el cuestionario del portal no admite archivos adjuntos`)
        }
        if (CHOICE_TYPES.includes(field.type)) {
          const count = field.options?.length ?? 0
          if (count < 2 || count > 50) issue([...at, "options"], `${Named} necesita entre 2 y 50 opciones`)
        }
        if (field.type === "escala") {
          const min = field.min ?? 0
          const max = field.max ?? 10
          if (!Number.isInteger(min)) {
            issue([...at, "min"], `El extremo inferior de ${named} debe ser un número entero`)
          } else if (!Number.isInteger(max)) {
            issue([...at, "max"], `El extremo superior de ${named} debe ser un número entero`)
          } else if (min >= max) {
            issue([...at, "max"], `El extremo superior de ${named} debe ser mayor que el inferior`)
          } else if (max - min > 100) {
            issue([...at, "max"], `La escala de ${named} abarca más de 100 puntos`)
          }
        }
        if (field.type === "numero" && field.min != null && field.max != null && field.min > field.max) {
          issue([...at, "max"], `El máximo de ${named} no puede ser menor que el mínimo`)
        }
        if (field.showIf) {
          const source = previous.get(field.showIf.field)
          const { equals } = field.showIf
          if (!source) {
            issue([...at, "showIf"], `${Named} depende de una pregunta anterior que ya no existe`)
          } else if (!conditionsOn(source)) {
            issue([...at, "showIf"], `${Named} solo puede depender de una pregunta Sí/No o de opciones`)
          } else if (source.type === "booleano" && typeof equals !== "boolean") {
            issue([...at, "showIf"], `Elige si ${named} se muestra con Sí o con No`)
          } else if (source.type !== "booleano" && (typeof equals !== "string" || !source.options?.includes(equals))) {
            issue([...at, "showIf"], `Elige qué opción de «${source.label}» muestra ${named}`)
          }
        }
        previous.set(field.id, field)
      })
    })
  })

/**
 * El servidor nombra cada dato como va en el cuerpo
 * (`schema.sections[0].fields[1].showIf.field`); aquí la plantilla es `sections`,
 * la condición «Mostrar si» es un solo campo y las opciones, una sola lista.
 */
const templateFieldMap = (key: string) =>
  key
    .replace(/^schema\./, "")
    .replace(/\.showIf\.(field|equals)$/, ".showIf")
    .replace(/\.options\[\d+\]$/, ".options")

function useTemplateForm(initial: FormTemplate | null, onSubmit: (value: TemplateValues) => Promise<void>) {
  // Valores iniciales una sola vez, al abrir: `key` remonta el formulario en cada apertura.
  const [defaultValues] = useState<TemplateValues>(() => ({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    specialtyId: initial?.specialtyId ?? "",
    respondent: initial?.respondent ?? "staff",
    sections: initial ? structuredClone(initial.schema.sections) : [{ id: "general", title: "General", fields: [] }],
  }))
  return useAppForm({
    defaultValues,
    validators: { onSubmit: templateSchema },
    onSubmit: ({ value }) => onSubmit(value),
  })
}

type TemplateForm = ReturnType<typeof useTemplateForm>

function TemplateBuilder({
  initial,
  onDirtyChange,
  onClose,
  onDone,
}: {
  initial: FormTemplate | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onDone: () => void
}) {
  const ids = useId()
  const canAdmin = usePermission("settings.write")
  const isNewVersion = Boolean(initial && initial.status !== "borrador")

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })
  const specialties = specialtiesQuery.data?.data ?? []

  const saveMutation = useMutation({
    mutationFn: (body: Parameters<typeof createFormTemplate>[0]) =>
      initial && !isNewVersion
        ? updateFormTemplate(initial.id, body)
        : // Una versión nueva conserva la clave de su plantilla; una plantilla nueva la recibe del servidor.
          createFormTemplate({ ...body, ...(initial ? { key: initial.key } : {}) }),
  })

  const form = useTemplateForm(initial, async (value) => {
    const schema: FormSchemaDef = {
      sections: value.sections.map((section) => ({
        ...section,
        fields: section.fields.map(({ definition, ...field }) => ({
          ...field,
          // Lo opcional que quedó vacío no viaja como texto vacío.
          unit: field.unit?.trim() || null,
          help: field.help?.trim() || null,
          // Pasar a los antecedentes es del cuestionario que responde el paciente.
          ...(value.respondent === "portal" ? { definition } : {}),
        })),
      })),
    }
    const title = value.title.trim()
    await saveMutation.mutateAsync({
      title,
      description: value.description.trim() || null,
      specialtyId: value.specialtyId || null,
      respondent: value.respondent,
      schema,
    })
    toast.success(`Borrador de «${title}» guardado`)
    onDone()
  })
  const surface = useFormSurface(form, { fieldMap: templateFieldMap })
  useReportDirty(surface.isDirty, onDirtyChange)
  const respondent = useStore(form.store, (state) => state.values.respondent)
  // Cada pregunta pinta sus controles según su tipo y las anteriores: se lee la plantilla entera.
  const sections = useStore(form.store, (state) => state.values.sections)

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={
        initial && !isNewVersion
          ? `Editar borrador · versión ${initial.version}`
          : initial
            ? `Nueva versión de «${initial.title}»`
            : "Nueva plantilla"
      }
      description="Se guarda como borrador. Para usarla en la ficha, publícala desde la lista."
      submitDisabled={!canAdmin}
    >
      <div className="flex flex-col gap-5">
        {isNewVersion && initial ? (
          <p className="rounded-xl border p-3 text-sm text-muted-foreground">
            La versión {initial.version} está publicada y no se edita: al guardar se crea el borrador de la
            siguiente.
          </p>
        ) : null}
        <form.AppField name="title">
          {(field) => <field.TextField label="Título" maxLength={200} disabled={!canAdmin} />}
        </form.AppField>
        <form.AppField name="description">
          {(field) => (
            <field.TextareaField label="Descripción (opcional)" rows={2} maxLength={2000} disabled={!canAdmin} />
          )}
        </form.AppField>
        <form.AppField name="specialtyId">
          {(field) => (
            <field.SelectField
              label="Especialidad"
              options={[
                { value: "", label: "Sin especialidad" },
                ...specialties.map((s) => ({ value: s.id, label: s.name })),
              ]}
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
        <form.AppField name="respondent">
          {(field) => (
            <field.SelectField
              label="Quién lo responde"
              options={[
                { value: "staff", label: "El equipo, desde la ficha" },
                { value: "portal", label: "El paciente, desde el portal (cuestionario previo)" },
              ]}
              description={
                respondent === "portal"
                  ? "Lo que responde el paciente llega como «declarado»; el profesional lo revisa y lo finaliza. Al finalizarlo, las respuestas marcadas como alergias pasan a sus antecedentes sin confirmar y la receta avisa."
                  : undefined
              }
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
        <form.Field name="sections" mode="array">
          {(sectionsField) => {
            // `mode="array"` solo vuelve a pintar al cambiar el largo: lo demás se lee de `sections`.
            const allFields = sections.flatMap((section) => section.fields)
            const sectionErrors = fieldErrorMessages(sectionsField.state.meta.errors)
            const sectionsErrorId = `${ids}-secciones-error`
            return (
              <>
                {/* Por posición: los campos de TanStack se nombran por ella (`sections[0].title`). */}
                {sections.map((section, si) => {
                  const before = sections.slice(0, si).flatMap((s) => s.fields)
                  return (
                    <section
                      // biome-ignore lint/suspicious/noArrayIndexKey: las secciones son un arreglo del formulario sin id propio: TanStack Form las nombra por su posición
                      key={si}
                      className="rounded-xl border p-3"
                    >
                      <div className="flex items-start gap-2">
                        <form.AppField name={`sections[${si}].title`}>
                          {(field) => (
                            <field.TextField
                              label={`Título de la sección ${si + 1}`}
                              hideLabel
                              maxLength={120}
                              disabled={!canAdmin}
                            />
                          )}
                        </form.AppField>
                        {canAdmin && sections.length > 1 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={ROW_BUTTON}
                            onClick={() => sectionsField.removeValue(si)}
                          >
                            Quitar sección
                          </Button>
                        ) : null}
                      </div>
                      <form.Field name={`sections[${si}].fields`} mode="array">
                        {(fieldsField) => {
                          const fieldErrors = fieldErrorMessages(fieldsField.state.meta.errors)
                          const fieldsErrorId = `${ids}-seccion-${si}-error`
                          return (
                            <div className="mt-3 flex flex-col gap-3">
                              {section.fields.map((field, fi) => (
                                <FieldEditor
                                  // biome-ignore lint/suspicious/noArrayIndexKey: las preguntas son un arreglo del formulario sin id propio: TanStack Form las nombra por su posición
                                  key={fi}
                                  form={form}
                                  si={si}
                                  fi={fi}
                                  field={field}
                                  previous={[...before, ...section.fields.slice(0, fi)]}
                                  declaresHealth={respondent === "portal"}
                                  disabled={!canAdmin}
                                  onRemove={() => fieldsField.removeValue(fi)}
                                />
                              ))}
                              {canAdmin ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className={`self-start ${ROW_BUTTON}`}
                                  aria-describedby={fieldErrors.length > 0 ? fieldsErrorId : undefined}
                                  onClick={() =>
                                    fieldsField.pushValue({
                                      id: uniqueKey(
                                        `campo_${allFields.length + 1}`,
                                        new Set(allFields.map((f) => f.id)),
                                      ),
                                      label: "Nuevo campo",
                                      type: "texto",
                                    })
                                  }
                                >
                                  Agregar campo
                                </Button>
                              ) : null}
                              {fieldErrors.length > 0 ? (
                                <FieldError id={fieldsErrorId} errors={fieldErrors.map((message) => ({ message }))} />
                              ) : null}
                            </div>
                          )
                        }}
                      </form.Field>
                    </section>
                  )
                })}
                {canAdmin ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    aria-describedby={sectionErrors.length > 0 ? sectionsErrorId : undefined}
                    onClick={() =>
                      sectionsField.pushValue({
                        id: uniqueKey(`seccion_${sections.length + 1}`, new Set(sections.map((s) => s.id))),
                        title: "Nueva sección",
                        fields: [],
                      })
                    }
                  >
                    Agregar sección
                  </Button>
                ) : null}
                {sectionErrors.length > 0 ? (
                  <FieldError id={sectionsErrorId} errors={sectionErrors.map((message) => ({ message }))} />
                ) : null}
              </>
            )
          }}
        </form.Field>
      </div>
    </FormDrawer>
  )
}

/** Lo que ocupa una casilla en la fila de una pregunta (la misma altura táctil que antes). */
const CHECK_FIELD = "w-auto gap-2 text-sm min-h-11 sm:min-h-0"

function FieldEditor({
  form,
  si,
  fi,
  field,
  previous,
  declaresHealth,
  disabled,
  onRemove,
}: {
  form: TemplateForm
  si: number
  fi: number
  field: FormFieldDef
  /** Las preguntas anteriores: de las Sí/No y de opciones puede depender esta. */
  previous: FormFieldDef[]
  /** Lo responde el paciente: una respuesta de texto puede pasar a sus antecedentes. */
  declaresHealth: boolean
  disabled: boolean
  onRemove: () => void
}) {
  const sources = previous.filter(conditionsOn)
  const conditionSource = sources.find((f) => f.id === field.showIf?.field)
  // Una condición sobre una pregunta quitada (o que ya no es Sí/No ni de opciones) sigue a la vista para corregirla.
  const lost = field.showIf && !conditionSource ? field.showIf.field : null
  const lostLabel = previous.find((f) => f.id === lost)?.label
  const sourceItems: [string, string][] = [
    ["siempre", "siempre"],
    ...sources.map((f): [string, string] => [f.id, `«${f.label}»`]),
    ...(lost ? [[lost, lostLabel ? `«${lostLabel}»` : "una pregunta quitada"] as [string, string]] : []),
  ]
  const textAnswer = field.type === "texto" || field.type === "texto_largo"
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <form.AppField
          name={`sections[${si}].fields[${fi}].label`}
          listeners={{
            onChange: ({ value }) => {
              // La clave provisional (`campo_N`) toma el texto de la pregunta, sin repetir la de otra.
              if (!form.getFieldValue(`sections[${si}].fields[${fi}].id`).startsWith("campo_")) return
              const taken = new Set(
                form.state.values.sections.flatMap((section, i) =>
                  section.fields.filter((_, j) => i !== si || j !== fi).map((other) => other.id),
                ),
              )
              form.setFieldValue(`sections[${si}].fields[${fi}].id`, uniqueKey(slugifyLabel(value), taken))
            },
          }}
        >
          {(labelField) => <labelField.TextField label="Pregunta" maxLength={200} disabled={disabled} />}
        </form.AppField>
        <form.AppField
          name={`sections[${si}].fields[${fi}].type`}
          listeners={{
            onChange: ({ value }) => {
              if (value === "escala") {
                form.setFieldValue(`sections[${si}].fields[${fi}].min`, (min) => min ?? 0)
                form.setFieldValue(`sections[${si}].fields[${fi}].max`, (max) => max ?? 10)
              }
              // Solo una respuesta de texto pasa a los antecedentes.
              if (value !== "texto" && value !== "texto_largo") {
                form.setFieldValue(`sections[${si}].fields[${fi}].definition`, null)
              }
            },
          }}
        >
          {(typeField) => (
            <typeField.SelectField
              label="Tipo de respuesta"
              disabled={disabled}
              options={FIELD_TYPES.filter(
                // «Pieza dentaria» solo donde el producto registra el «dónde» (o si ya la usa).
                (type) => type !== "pieza" || productUi().site || field.type === "pieza",
              ).map((type) => ({ value: type, label: FIELD_TYPE_LABELS[type] }))}
            />
          )}
        </form.AppField>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <form.AppField name={`sections[${si}].fields[${fi}].required`}>
          {(requiredField) => <requiredField.CheckboxField label="Obligatorio" disabled={disabled} className={CHECK_FIELD} />}
        </form.AppField>
        {declaresHealth && textAnswer ? (
          <form.AppField name={`sections[${si}].fields[${fi}].definition`}>
            {(definitionField) => (
              <FormChoiceField label="Son alergias: pasan a sus antecedentes" className={CHECK_FIELD}>
                {(control) => (
                  <Checkbox
                    id={control.id}
                    name={control.name}
                    checked={definitionField.state.value === "AllergyIntolerance.code"}
                    disabled={disabled}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onCheckedChange={(checked) => {
                      definitionField.handleChange(checked === true ? "AllergyIntolerance.code" : null)
                      definitionField.handleBlur()
                    }}
                  />
                )}
              </FormChoiceField>
            )}
          </form.AppField>
        ) : null}
        {textAnswer ? (
          <form.AppField name={`sections[${si}].fields[${fi}].unit`}>
            {(unitField) => (
              <unitField.TextField
                label="Unidad"
                hideLabel
                className="w-32"
                placeholder="Unidad (opcional)"
                maxLength={20}
                disabled={disabled}
              />
            )}
          </form.AppField>
        ) : null}
        {field.type === "numero" ? (
          <>
            <form.AppField name={`sections[${si}].fields[${fi}].min`}>
              {(minField) => (
                <minField.Control label="Mínimo" hideLabel className="w-28">
                  {(control) => (
                    <Input
                      {...control.props}
                      placeholder="Mín"
                      type="number"
                      value={minField.state.value ?? ""}
                      disabled={disabled}
                      onChange={(event) =>
                        minField.handleChange(event.target.value === "" ? null : Number(event.target.value))
                      }
                    />
                  )}
                </minField.Control>
              )}
            </form.AppField>
            <form.AppField name={`sections[${si}].fields[${fi}].max`}>
              {(maxField) => (
                <maxField.Control label="Máximo" hideLabel className="w-28">
                  {(control) => (
                    <Input
                      {...control.props}
                      placeholder="Máx"
                      type="number"
                      value={maxField.state.value ?? ""}
                      disabled={disabled}
                      onChange={(event) =>
                        maxField.handleChange(event.target.value === "" ? null : Number(event.target.value))
                      }
                    />
                  )}
                </maxField.Control>
              )}
            </form.AppField>
            <form.AppField name={`sections[${si}].fields[${fi}].unit`}>
              {(unitField) => (
                <unitField.TextField
                  label="Unidad"
                  hideLabel
                  className="w-32"
                  placeholder="Unidad"
                  maxLength={20}
                  disabled={disabled}
                />
              )}
            </form.AppField>
          </>
        ) : null}
        {field.type === "escala" ? (
          <>
            <form.AppField name={`sections[${si}].fields[${fi}].min`}>
              {(minField) => (
                <minField.Control label="Extremo inferior de la escala" hideLabel className="w-24">
                  {(control) => (
                    <Input
                      {...control.props}
                      type="number"
                      step={1}
                      value={minField.state.value ?? 0}
                      disabled={disabled}
                      onChange={(event) => minField.handleChange(Number(event.target.value))}
                    />
                  )}
                </minField.Control>
              )}
            </form.AppField>
            <span className="text-sm">a</span>
            <form.AppField name={`sections[${si}].fields[${fi}].max`}>
              {(maxField) => (
                <maxField.Control label="Extremo superior de la escala" hideLabel className="w-24">
                  {(control) => (
                    <Input
                      {...control.props}
                      type="number"
                      step={1}
                      value={maxField.state.value ?? 10}
                      disabled={disabled}
                      onChange={(event) => maxField.handleChange(Number(event.target.value))}
                    />
                  )}
                </maxField.Control>
              )}
            </form.AppField>
          </>
        ) : null}
        <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} disabled={disabled} onClick={onRemove}>
          Quitar campo
        </Button>
      </div>
      {sources.length > 0 || field.showIf ? (
        <form.AppField name={`sections[${si}].fields[${fi}].showIf`}>
          {(conditionField) => (
            <conditionField.Control label="Mostrar si" hideLabel className="mt-2">
              {(control) => (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Mostrar si</span>
                  <Select
                    items={Object.fromEntries(sourceItems)}
                    value={conditionField.state.value?.field ?? "siempre"}
                    disabled={disabled}
                    onValueChange={(v) => {
                      const source = sources.find((f) => f.id === v)
                      conditionField.handleChange(
                        source
                          ? {
                              field: source.id,
                              equals: source.type === "booleano" ? true : (source.options?.[0] ?? ""),
                            }
                          : null,
                      )
                    }}
                  >
                    <SelectTrigger
                      id={control.id}
                      className="w-56"
                      aria-label="Pregunta de la que depende"
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sourceItems.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {conditionSource ? (
                    <>
                      <span>es</span>
                      <Select
                        items={Object.fromEntries(
                          conditionSource.type === "booleano"
                            ? [
                                ["true", "Sí"],
                                ["false", "No"],
                              ]
                            : (conditionSource.options ?? []).map((o) => [o, o]),
                        )}
                        value={String(conditionField.state.value?.equals ?? "")}
                        disabled={disabled}
                        onValueChange={(v) =>
                          conditionField.handleChange({
                            field: conditionSource.id,
                            equals: conditionSource.type === "booleano" ? v === "true" : (v ?? ""),
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-40"
                          aria-label="Respuesta que lo muestra"
                          aria-invalid={control.invalid || undefined}
                          aria-describedby={control.describedBy}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {conditionSource.type === "booleano" ? (
                            <>
                              <SelectItem value="true">Sí</SelectItem>
                              <SelectItem value="false">No</SelectItem>
                            </>
                          ) : (
                            (conditionSource.options ?? []).map((o) => (
                              <SelectItem key={o} value={o}>
                                {o}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </>
                  ) : null}
                </div>
              )}
            </conditionField.Control>
          )}
        </form.AppField>
      ) : null}
      {CHOICE_TYPES.includes(field.type) ? (
        <form.AppField name={`sections[${si}].fields[${fi}].options`}>
          {(optionsField) => (
            <optionsField.Control label="Nueva opción" hideLabel className="mt-2">
              {(control) => (
                <OptionsEditor
                  control={control}
                  options={optionsField.state.value ?? []}
                  disabled={disabled}
                  onChange={(options) => optionsField.handleChange(options)}
                />
              )}
            </optionsField.Control>
          )}
        </form.AppField>
      ) : null}
      <form.AppField name={`sections[${si}].fields[${fi}].help`}>
        {(helpField) => (
          <helpField.TextField
            label="Texto de ayuda"
            hideLabel
            className="mt-2"
            placeholder="Texto de ayuda (opcional)"
            maxLength={500}
            disabled={disabled}
          />
        )}
      </form.AppField>
    </div>
  )
}

/**
 * Las opciones de una pregunta. El error de la lista (cuántas hay) va debajo
 * de todo, en el hueco de `control`; el de lo que se intenta agregar, junto a
 * «Nueva opción».
 */
function OptionsEditor({
  control,
  options,
  disabled,
  onChange,
}: {
  control: FieldControl
  options: string[]
  disabled: boolean
  onChange: (options: string[]) => void
}) {
  const [draft, setDraft] = useState("")
  const [draftError, setDraftError] = useState<string | null>(null)
  const draftErrorId = `${control.id}-nueva-error`
  const add = () => {
    const value = draft.trim()
    if (value && options.includes(value)) {
      setDraftError(`«${value}» ya está en la lista`)
      return
    }
    if (value && options.length >= 50) {
      setDraftError("Una pregunta admite hasta 50 opciones")
      return
    }
    if (value) onChange([...options, value])
    setDraft("")
  }
  return (
    <div>
      <ul className="flex flex-wrap gap-1">
        {options.map((option) => (
          <li key={option}>
            <Badge variant="secondary" className="h-auto gap-1 py-0.5 pr-0.5">
              {option}
              {!disabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="max-sm:size-11"
                  aria-label={`Quitar ${option}`}
                  onClick={() => onChange(options.filter((o) => o !== option))}
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </Badge>
          </li>
        ))}
      </ul>
      {!disabled ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-2">
            <Input
              {...control.props}
              aria-invalid={control.invalid || draftError !== null || undefined}
              aria-describedby={[control.describedBy, draftError ? draftErrorId : null].filter(Boolean).join(" ") || undefined}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setDraftError(null)
              }}
              onKeyDown={(event) => {
                // Enter agrega la opción; no envía el formulario de la plantilla.
                if (event.key === "Enter") {
                  event.preventDefault()
                  add()
                }
              }}
              placeholder="Nueva opción"
              maxLength={120}
              aria-label="Nueva opción"
            />
            <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={add}>
              Agregar
            </Button>
          </div>
          {draftError ? <FieldError id={draftErrorId} errors={[{ message: draftError }]} /> : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Consentimientos
// ---------------------------------------------------------------------------

function ConsentTemplatesPanel() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("settings.write")
  // Al lado: una plantilla nueva, un borrador o la versión de la que parte la siguiente.
  const builder = useSideForm<ConsentTemplate>()
  const openBuilder = builder.open
  const [confirm, setConfirm] = useState<
    | { kind: "publish"; draft: ConsentTemplate; current: ConsentTemplate | undefined }
    | { kind: "archive"; template: ConsentTemplate }
    | null
  >(null)

  const listQuery = useQuery({
    queryKey: ["consent-templates"],
    queryFn: () => fetchConsentTemplates(),
    retry: 1,
  })
  const templates = listQuery.data?.data ?? []
  const grouped = useMemo(() => byTemplate(templates), [templates])
  // «Se pide para»: los servicios que piden cada plantilla (por su clave).
  const linksQuery = useQuery({
    queryKey: ["consent-template-services"],
    queryFn: fetchConsentTemplateServices,
  })
  // Se nombran por id los servicios ya unidos, estén o no en la primera página del tarifario (tope B3).
  const linkedIds = [...new Set((linksQuery.data?.data ?? []).flatMap((link) => link.serviceIds))].sort()
  const namesQuery = useQuery({
    queryKey: ["services", "para-consentimientos", linkedIds],
    enabled: linkedIds.length > 0,
    queryFn: async () => {
      const pages = []
      for (let at = 0; at < linkedIds.length; at += 100) {
        pages.push(fetchServices({ ids: linkedIds.slice(at, at + 100), limit: 100 }))
      }
      return (await Promise.all(pages)).flatMap((page) => page.data)
    },
  })
  const serviceName = new Map((namesQuery.data ?? []).map((service) => [service.id, service.name]))
  const linkedOf = (key: string) => linksQuery.data?.data.find((link) => link.templateKey === key)?.serviceIds ?? []
  const [servicesFor, setServicesFor] = useState<ConsentTemplate | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["consent-templates"] })
    void queryClient.invalidateQueries({ queryKey: ["consent-templates-published"] })
  }

  const publishMutation = useMutation({
    mutationFn: (draft: ConsentTemplate) => publishConsentTemplate(draft.id),
    onSuccess: (_result, draft) => {
      setConfirm(null)
      toast.success(`Versión ${draft.version} de «${draft.title}» publicada`)
      invalidate()
    },
    onError: (error) => {
      setConfirm(null)
      toast.error(submitErrorMessage(error))
    },
  })
  const archiveMutation = useMutation({
    mutationFn: (template: ConsentTemplate) => archiveConsentTemplate(template.id),
    onSuccess: (_result, template) => {
      setConfirm(null)
      toast.success(`Plantilla «${template.title}» archivada`)
      invalidate()
    },
    onError: (error) => {
      setConfirm(null)
      toast.error(submitErrorMessage(error))
    },
  })
  const suggestedMutation = useMutation({
    mutationFn: () => createSuggestedConsentTemplates(),
    onSuccess: (result) => {
      invalidate()
      const count = result.data.length
      toast.success(
        count === 0
          ? "Ya tienes todas las plantillas sugeridas"
          : count === 1
            ? "Se agregó 1 plantilla sugerida como borrador: revísala antes de publicarla"
            : `Se agregaron ${count} plantillas sugeridas como borrador: revísalas antes de publicarlas`,
      )
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  const neverLoaded = listQuery.isError && listQuery.data === undefined

  return (
    <div className="flex flex-col gap-4">
      {canAdmin && grouped.length > 0 ? (
        <PanelActions>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={suggestedMutation.isPending}
            onClick={() => suggestedMutation.mutate()}
          >
            Agregar plantillas sugeridas
          </Button>
          <Button type="button" className="min-h-11" onClick={() => openBuilder(null)}>
            <Plus aria-hidden />
            Nueva plantilla
          </Button>
        </PanelActions>
      ) : null}

      {listQuery.isPending ? (
        <TemplatesSkeleton label="Cargando las plantillas de consentimientos…" />
      ) : neverLoaded ? (
        <SettingsLoadError what="las plantillas de consentimientos" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="las plantillas de consentimientos" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {grouped.length === 0 ? (
            <EmptyState
              title="Aún no hay plantillas de consentimientos"
              description="Redacta la primera —procedimiento, beneficios, riesgos, alternativas y qué pasa si no se trata— o empieza con las sugeridas."
              {...(canAdmin
                ? {
                    actionLabel: "Nueva plantilla",
                    onAction: () => openBuilder(null),
                    secondaryActionLabel: "Agregar plantillas sugeridas",
                    onSecondaryAction: () => suggestedMutation.mutate(),
                  }
                : {})}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map((versions) => {
                const latest = versions[0]
                if (!latest) return null
                const draft = versions.find((v) => v.status === "borrador")
                const current = versions.find((v) => v.status === "publicado")
                return (
                  <li key={latest.key} className={CARD}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{latest.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {current ? `Vigente: versión ${current.version}` : "Sin versión vigente"}
                          {draft ? ` · borrador de la versión ${draft.version}` : ""}
                          {latest.sections ? "" : " · texto libre (anterior a las secciones)"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {linkedOf(latest.key).length > 0
                            ? `Se pide para: ${linkedOf(latest.key)
                                .map((id) => serviceName.get(id) ?? "…")
                                .join(", ")}`
                            : "Aún no se pide para ningún servicio: la atención no lo propone sola"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {versions.map((version) => (
                          <Badge key={version.id} variant={version.status === "publicado" ? "default" : "secondary"}>
                            Versión {version.version} · {TEMPLATE_STATUS_LABELS[version.status]}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    {canAdmin ? (
                      <div className="flex flex-wrap gap-2">
                        {draft ? (
                          <>
                            <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={() => openBuilder(draft)}>
                              Editar borrador
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className={ROW_BUTTON}
                              onClick={() => setConfirm({ kind: "publish", draft, current })}
                            >
                              Publicar versión {draft.version}
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={() => openBuilder({ ...latest })}>
                            Nueva versión desde la {latest.version}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={ROW_BUTTON}
                          onClick={() => setServicesFor(latest)}
                        >
                          Se pide para…
                        </Button>
                        {current ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={ROW_BUTTON}
                            onClick={() => setConfirm({ kind: "archive", template: current })}
                          >
                            Archivar
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {builder.form ? (
        <ConsentBuilder
          key={builder.form.opening}
          initial={builder.form.target}
          onDirtyChange={builder.setDirty}
          onClose={builder.close}
          onDone={() => {
            builder.close()
            invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={builder} what="otra plantilla" />
      {servicesFor ? (
        <ConsentServicesDrawer
          template={servicesFor}
          selected={linkedOf(servicesFor.key)}
          names={serviceName}
          onClose={() => setServicesFor(null)}
          onSaved={() => {
            setServicesFor(null)
            void queryClient.invalidateQueries({ queryKey: ["consent-template-services"] })
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirm?.kind === "publish"}
        variant="default"
        title={confirm?.kind === "publish" ? `Publicar la versión ${confirm.draft.version}` : "Publicar"}
        description={
          confirm?.kind === "publish"
            ? confirm.current
              ? `La versión ${confirm.current.version} se archiva: los consentimientos nuevos usarán la ${confirm.draft.version}. Los ya generados conservan su texto.`
              : "Quedará disponible para generar consentimientos en la ficha. Una versión publicada ya no se edita: para cambiarla se prepara la siguiente."
            : ""
        }
        confirmLabel="Publicar"
        pending={publishMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "publish" && publishMutation.mutate(confirm.draft)}
      />
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        variant="default"
        title={confirm?.kind === "archive" ? `Archivar «${confirm.template.title}»` : "Archivar"}
        description="Deja de ofrecerse para consentimientos nuevos. Los documentos ya generados no cambian."
        confirmLabel="Archivar"
        pending={archiveMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "archive" && archiveMutation.mutate(confirm.template)}
      />
    </div>
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

const toLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean)

/** Lo que se edita de un consentimiento: las tres listas, una línea por elemento. */
interface ConsentValues {
  title: string
  specialtyId: string
  procedure: string
  benefits: string
  risks: string
  alternatives: string
  consequences: string
  notes: string
}

/** Las tres listas, con el nombre de cada elemento para decir en cuál está el problema. */
const CONSENT_LISTS = [
  { name: "benefits", label: "Beneficios esperados", one: "beneficio", many: "beneficios", a: "un", the: "El" },
  { name: "risks", label: "Riesgos y molestias", one: "riesgo", many: "riesgos", a: "un", the: "El" },
  { name: "alternatives", label: "Alternativas", one: "alternativa", many: "alternativas", a: "una", the: "La" },
] as const

/** Las secciones que se guardan, tal como las escribió la clínica. */
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
 * Los mismos límites que la ruta y el servidor (≤20 elementos de ≤500
 * caracteres por lista y 20000 en total), dichos en la lista que hay que
 * corregir; si el total se pasa, en la sección más larga.
 */
const consentSchema = z
  .object({
    title: z.string().trim().min(1, "Escribe el título").max(200, "El título admite hasta 200 caracteres"),
    specialtyId: z.string(),
    procedure: z
      .string()
      .trim()
      .min(10, "Describe el procedimiento (al menos 10 caracteres)")
      .max(4000, "El procedimiento admite hasta 4000 caracteres"),
    benefits: z.string(),
    risks: z.string(),
    alternatives: z.string(),
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

function ConsentBuilder({
  initial,
  onDirtyChange,
  onClose,
  onDone,
}: {
  initial: ConsentTemplate | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onDone: () => void
}) {
  const canAdmin = usePermission("settings.write")
  const isNewVersion = Boolean(initial && initial.status !== "borrador")

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })
  const specialties = specialtiesQuery.data?.data ?? []

  const saveMutation = useMutation({
    mutationFn: (payload: Parameters<typeof createConsentTemplate>[0]) =>
      initial && !isNewVersion
        ? updateConsentTemplate(initial.id, payload)
        : // Una versión nueva conserva la clave de su plantilla; una plantilla nueva la recibe del servidor.
          createConsentTemplate({ ...payload, ...(initial ? { key: initial.key } : {}) }),
  })

  // Valores iniciales una sola vez, al abrir: `key` remonta el formulario en cada apertura.
  const [defaultValues] = useState<ConsentValues>(() => {
    const base = initial?.sections ?? null
    return {
      title: initial?.title ?? "",
      specialtyId: initial?.specialtyId ?? "",
      procedure: base?.procedure ?? "",
      benefits: (base?.benefits ?? []).join("\n"),
      risks: (base?.risks ?? []).join("\n"),
      alternatives: (base?.alternatives ?? []).join("\n"),
      consequences: base?.consequences ?? "",
      notes: base?.notes ?? "",
    }
  })
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: consentSchema },
    onSubmit: async ({ value }) => {
      const title = value.title.trim()
      await saveMutation.mutateAsync({
        title,
        sections: consentSectionsOf(value),
        specialtyId: value.specialtyId || null,
      })
      toast.success(`Borrador de «${title}» guardado`)
      onDone()
    },
  })
  // El servidor nombra las secciones como van en el cuerpo (`sections.risks[3]`); aquí cada lista es un campo.
  const surface = useFormSurface(form, {
    fieldMap: (key) => key.replace(/^sections\./, "").replace(/\[\d+\]$/, ""),
  })
  useReportDirty(surface.isDirty, onDirtyChange)

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={
        initial && !isNewVersion
          ? `Editar borrador · versión ${initial.version}`
          : initial
            ? `Nueva versión de «${initial.title}»`
            : "Nueva plantilla"
      }
      description="Se guarda como borrador; para usarla, publícala desde la lista. El diagnóstico se elige al generar el consentimiento (o se toma del tratamiento) y el profesional que informa firma con su perfil profesional."
      submitDisabled={!canAdmin}
    >
      <div className="flex flex-col gap-4">
        {isNewVersion && initial ? (
          <p className="rounded-xl border p-3 text-sm text-muted-foreground">
            La versión {initial.version} está publicada y no se edita: al guardar se crea el borrador de la
            siguiente.
          </p>
        ) : null}
        {initial && !initial.sections ? (
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
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{initial.body}</p>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <form.AppField name="title">
          {(field) => <field.TextField label="Título" aria-required="true" maxLength={200} disabled={!canAdmin} />}
        </form.AppField>
        <form.AppField name="specialtyId">
          {(field) => (
            <field.SelectField
              label="Especialidad"
              options={[
                { value: "", label: "Sin especialidad" },
                ...specialties.map((s) => ({ value: s.id, label: s.name })),
              ]}
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
        <form.AppField name="procedure">
          {(field) => (
            <field.TextareaField
              label="Procedimiento propuesto"
              aria-required="true"
              rows={3}
              maxLength={4000}
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
        {CONSENT_LISTS.map((list) => (
          <form.AppField key={list.name} name={list.name}>
            {(field) => (
              <field.TextareaField
                label={list.label}
                description="Uno por línea."
                aria-required="true"
                rows={4}
                disabled={!canAdmin}
              />
            )}
          </form.AppField>
        ))}
        <form.AppField name="consequences">
          {(field) => (
            <field.TextareaField
              label="Consecuencias de no tratarse"
              aria-required="true"
              rows={2}
              maxLength={4000}
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
        <form.AppField name="notes">
          {(field) => (
            <field.TextareaField
              label="Información adicional (opcional)"
              rows={2}
              maxLength={4000}
              disabled={!canAdmin}
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
