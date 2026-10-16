import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
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
  Textarea,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, EmptyState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ChevronDown, Plus, X } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError } from "../../lib/api"
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

export const Route = createFileRoute("/_org/settings/forms")({
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

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/**
 * Formularios clínicos y consentimientos: plantillas por secciones y campos,
 * con versiones. Una versión publicada no se edita: se prepara la siguiente.
 */
function FormulariosPage() {
  const canRead = usePermission("settings.read")
  const [tab, setTab] = useState("formularios")
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
      toast.error(errorText(error, "No pudimos publicar la versión. Vuelve a intentarlo."))
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
      toast.error(errorText(error, "No pudimos archivar el borrador. Vuelve a intentarlo."))
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

/** Lo que se compara para saber si el borrador cambió. */
function formSnapshot(values: {
  title: string
  description: string
  specialtyId: string
  respondent: "staff" | "portal"
  sections: FormSectionDef[]
}): string {
  return JSON.stringify(values)
}

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
  const [title, setTitle] = useState(initial?.title ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [specialtyId, setSpecialtyId] = useState<string>(initial?.specialtyId ?? "")
  const [respondent, setRespondent] = useState<"staff" | "portal">(initial?.respondent ?? "staff")
  const [sections, setSections] = useState<FormSectionDef[]>(
    initial ? structuredClone(initial.schema.sections) : [{ id: "general", title: "General", fields: [] }],
  )
  const [formError, setFormError] = useState<string | null>(null)
  // Lo que había al abrir: con eso se sabe si hay algo sin guardar.
  const [opened] = useState(() => formSnapshot({ title, description, specialtyId, respondent, sections }))
  const isDirty = formSnapshot({ title, description, specialtyId, respondent, sections }) !== opened
  useReportDirty(isDirty, onDirtyChange)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })
  const specialties = specialtiesQuery.data?.data ?? []

  const saveMutation = useMutation({
    mutationFn: () => {
      // Pasar a los antecedentes es del cuestionario que responde el paciente.
      const schema: FormSchemaDef = {
        sections:
          respondent === "portal"
            ? sections
            : sections.map((section) => ({
                ...section,
                fields: section.fields.map(({ definition: _definition, ...field }) => field),
              })),
      }
      const body = {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        specialtyId: specialtyId ? specialtyId : null,
        respondent,
        schema,
      }
      if (initial && !isNewVersion) return updateFormTemplate(initial.id, body)
      // Una versión nueva conserva la clave de su plantilla; una plantilla nueva la recibe del servidor.
      return createFormTemplate({ ...body, ...(initial ? { key: initial.key } : {}) })
    },
    onSuccess: () => {
      toast.success(`Borrador de «${title.trim()}» guardado`)
      onDone()
    },
    onError: (error: unknown) => setFormError(errorText(error, "No pudimos guardar el borrador. Vuelve a intentarlo.")),
  })

  function missing(): string | null {
    if (!title.trim()) return "Escribe el título"
    if (sections.length === 0) return "Agrega al menos una sección"
    for (const section of sections) {
      if (!section.title.trim()) return "Cada sección necesita un título"
      if (section.fields.length === 0) return `«${section.title}» necesita al menos un campo`
    }
    return null
  }

  const patchSection = (id: string, patch: Partial<FormSectionDef>) =>
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const patchField = (sectionId: string, fieldId: string, patch: Partial<FormFieldDef>) =>
    setSections((prev) =>
      prev.map((s) =>
        s.id === sectionId
          ? { ...s, fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) }
          : s,
      ),
    )

  return (
    <FormDrawer
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
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const problem = missing()
        setFormError(problem)
        if (!problem) saveMutation.mutate()
      }}
      isSubmitting={saveMutation.isPending}
      isDirty={isDirty}
      error={formError}
      submitDisabled={!canAdmin}
    >
      <div className="flex flex-col gap-5">
        {isNewVersion && initial ? (
          <p className="rounded-xl border p-3 text-sm text-muted-foreground">
            La versión {initial.version} está publicada y no se edita: al guardar se crea el borrador de la
            siguiente.
          </p>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${ids}-titulo`}>Título</FieldLabel>
          <Input
            id={`${ids}-titulo`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            disabled={!canAdmin}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-descripcion`}>Descripción (opcional)</FieldLabel>
          <Textarea
            id={`${ids}-descripcion`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            maxLength={2000}
            disabled={!canAdmin}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-especialidad`}>Especialidad</FieldLabel>
          <Select
            items={Object.fromEntries([["ninguna", "Sin especialidad"], ...specialties.map((s) => [s.id, s.name])])}
            value={specialtyId || "ninguna"}
            onValueChange={(v: string | null) => setSpecialtyId(v === "ninguna" ? "" : (v ?? ""))}
            disabled={!canAdmin}
          >
            <SelectTrigger id={`${ids}-especialidad`}>
              <SelectValue placeholder="Sin especialidad" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ninguna">Sin especialidad</SelectItem>
              {specialties.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${ids}-responde`}>Quién lo responde</FieldLabel>
          <Select
            items={{ staff: "El equipo, desde la ficha", portal: "El paciente, desde el portal (cuestionario previo)" }}
            value={respondent}
            onValueChange={(v) => setRespondent(v === "portal" ? "portal" : "staff")}
            disabled={!canAdmin}
          >
            <SelectTrigger id={`${ids}-responde`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="staff">El equipo, desde la ficha</SelectItem>
              <SelectItem value="portal">El paciente, desde el portal (cuestionario previo)</SelectItem>
            </SelectContent>
          </Select>
          {respondent === "portal" ? (
            <FieldDescription>
              Lo que responde el paciente llega como «declarado»; el profesional lo revisa y lo
              finaliza. Al finalizarlo, las respuestas marcadas como alergias pasan a sus
              antecedentes sin confirmar y la receta avisa.
            </FieldDescription>
          ) : null}
        </Field>
        {sections.map((section, si) => (
          <section key={section.id} className="rounded-xl border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={section.title}
                onChange={(event) => patchSection(section.id, { title: event.target.value })}
                aria-label={`Título de la sección ${si + 1}`}
                maxLength={120}
                disabled={!canAdmin}
              />
              {canAdmin && sections.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={ROW_BUTTON}
                  onClick={() => setSections((prev) => prev.filter((s) => s.id !== section.id))}
                >
                  Quitar sección
                </Button>
              ) : null}
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {section.fields.map((field) => (
                <FieldEditor
                  key={field.id}
                  field={field}
                  declaresHealth={respondent === "portal"}
                  previousFields={sections
                    .flatMap((s) => s.fields)
                    .slice(
                      0,
                      sections.flatMap((s) => s.fields).findIndex((f) => f.id === field.id),
                    )
                    .filter((f) => f.type === "booleano" || f.type === "opcion_unica" || f.type === "opcion_multiple")}
                  disabled={!canAdmin}
                  onPatch={(patch) => patchField(section.id, field.id, patch)}
                  onRemove={() =>
                    setSections((prev) =>
                      prev.map((s) =>
                        s.id === section.id
                          ? { ...s, fields: s.fields.filter((f) => f.id !== field.id) }
                          : s,
                      ),
                    )
                  }
                />
              ))}
              {canAdmin ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={`self-start ${ROW_BUTTON}`}
                  onClick={() => {
                    const id = `campo_${sections.reduce((n, s) => n + s.fields.length, 0) + 1}`
                    setSections((prev) =>
                      prev.map((s) =>
                        s.id === section.id
                          ? {
                              ...s,
                              fields: [
                                ...s.fields,
                                { id, label: "Nuevo campo", type: "texto" as FormFieldType },
                              ],
                            }
                          : s,
                      ),
                    )
                  }}
                >
                  Agregar campo
                </Button>
              ) : null}
            </div>
          </section>
        ))}
        {canAdmin ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            onClick={() =>
              setSections((prev) => [
                ...prev,
                { id: `seccion_${prev.length + 1}`, title: "Nueva sección", fields: [] },
              ])
            }
          >
            Agregar sección
          </Button>
        ) : null}
      </div>
    </FormDrawer>
  )
}

function FieldEditor({
  field,
  declaresHealth,
  previousFields,
  disabled,
  onPatch,
  onRemove,
}: {
  field: FormFieldDef
  /** Lo responde el paciente: una respuesta de texto puede pasar a sus antecedentes. */
  declaresHealth: boolean
  /** Campos anteriores Sí/No u opciones: los únicos que pueden condicionar este. */
  previousFields: FormFieldDef[]
  disabled: boolean
  onPatch: (patch: Partial<FormFieldDef>) => void
  onRemove: () => void
}) {
  const ids = useId()
  const conditionSource = previousFields.find((f) => f.id === field.showIf?.field)
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${ids}-pregunta`}>Pregunta</FieldLabel>
          <Input
            id={`${ids}-pregunta`}
            value={field.label}
            onChange={(event) => {
              const label = event.target.value
              onPatch({
                label,
                id: field.id.startsWith("campo_") ? `${slugifyLabel(label) || field.id}` : field.id,
              })
            }}
            maxLength={200}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-tipo`}>Tipo de respuesta</FieldLabel>
          <Select
            items={FIELD_TYPE_LABELS}
            value={field.type}
            onValueChange={(value) =>
              onPatch({
                ...(value === "escala"
                  ? { type: "escala", min: field.min ?? 0, max: field.max ?? 10 }
                  : { type: value as FormFieldType }),
                // Solo una respuesta de texto pasa a los antecedentes.
                ...(value === "texto" || value === "texto_largo" ? {} : { definition: null }),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger id={`${ids}-tipo`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {FIELD_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
          <Checkbox
            id={`${ids}-obligatorio`}
            checked={Boolean(field.required)}
            disabled={disabled}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          <label htmlFor={`${ids}-obligatorio`}>Obligatorio</label>
        </div>
        {declaresHealth && (field.type === "texto" || field.type === "texto_largo") ? (
          <div className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <Checkbox
              id={`${ids}-alergias`}
              checked={field.definition === "AllergyIntolerance.code"}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onPatch({ definition: checked === true ? "AllergyIntolerance.code" : null })
              }
            />
            <label htmlFor={`${ids}-alergias`}>Son alergias: pasan a sus antecedentes</label>
          </div>
        ) : null}
        {(field.type === "texto" || field.type === "texto_largo") && (
          <Input
            className="w-32"
            placeholder="Unidad (opcional)"
            value={field.unit ?? ""}
            maxLength={20}
            disabled={disabled}
            onChange={(event) => onPatch({ unit: event.target.value || null })}
            aria-label="Unidad"
          />
        )}
        {field.type === "numero" && (
          <>
            <Input
              className="w-28"
              placeholder="Mín"
              type="number"
              value={field.min ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onPatch({ min: event.target.value === "" ? null : Number(event.target.value) })
              }
              aria-label="Mínimo"
            />
            <Input
              className="w-28"
              placeholder="Máx"
              type="number"
              value={field.max ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onPatch({ max: event.target.value === "" ? null : Number(event.target.value) })
              }
              aria-label="Máximo"
            />
            <Input
              className="w-32"
              placeholder="Unidad"
              value={field.unit ?? ""}
              maxLength={20}
              disabled={disabled}
              onChange={(event) => onPatch({ unit: event.target.value || null })}
              aria-label="Unidad"
            />
          </>
        )}
        {field.type === "escala" && (
          <>
            <Input
              className="w-24"
              type="number"
              step={1}
              value={field.min ?? 0}
              disabled={disabled}
              onChange={(event) => onPatch({ min: Number(event.target.value) })}
              aria-label="Extremo inferior de la escala"
            />
            <span className="text-sm">a</span>
            <Input
              className="w-24"
              type="number"
              step={1}
              value={field.max ?? 10}
              disabled={disabled}
              onChange={(event) => onPatch({ max: Number(event.target.value) })}
              aria-label="Extremo superior de la escala"
            />
          </>
        )}
        <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} disabled={disabled} onClick={onRemove}>
          Quitar campo
        </Button>
      </div>
      {previousFields.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>Mostrar si</span>
          <Select
            items={Object.fromEntries([
              ["siempre", "siempre"],
              ...previousFields.map((f) => [f.id, `«${f.label}»`]),
            ])}
            value={field.showIf?.field ?? "siempre"}
            disabled={disabled}
            onValueChange={(v) => {
              const source = previousFields.find((f) => f.id === v)
              onPatch({
                showIf: source
                  ? {
                      field: source.id,
                      equals: source.type === "booleano" ? true : (source.options?.[0] ?? ""),
                    }
                  : null,
              })
            }}
          >
            <SelectTrigger className="w-56" aria-label="Pregunta de la que depende">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="siempre">siempre</SelectItem>
              {previousFields.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  «{f.label}»
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
                value={String(field.showIf?.equals ?? "")}
                disabled={disabled}
                onValueChange={(v) =>
                  onPatch({
                    showIf: {
                      field: conditionSource.id,
                      equals: conditionSource.type === "booleano" ? v === "true" : (v ?? ""),
                    },
                  })
                }
              >
                <SelectTrigger className="w-40" aria-label="Respuesta que lo muestra">
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
      ) : null}
      {(field.type === "opcion_unica" || field.type === "opcion_multiple") && (
        <OptionsEditor
          options={field.options ?? []}
          disabled={disabled}
          onChange={(options) => onPatch({ options })}
        />
      )}
      <Input
        className="mt-2"
        placeholder="Texto de ayuda (opcional)"
        value={field.help ?? ""}
        maxLength={500}
        disabled={disabled}
        onChange={(event) => onPatch({ help: event.target.value || null })}
        aria-label="Texto de ayuda"
      />
    </div>
  )
}

function OptionsEditor({
  options,
  disabled,
  onChange,
}: {
  options: string[]
  disabled: boolean
  onChange: (options: string[]) => void
}) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const value = draft.trim()
    if (value && !options.includes(value)) onChange([...options, value])
    setDraft("")
  }
  return (
    <div className="mt-2">
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
        <div className="mt-2 flex gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
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
      toast.error(errorText(error, "No pudimos publicar la versión. Vuelve a intentarlo."))
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
      toast.error(errorText(error, "No pudimos archivar la plantilla. Vuelve a intentarlo."))
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
    onError: (error) => toast.error(errorText(error, "No pudimos agregar las plantillas sugeridas. Vuelve a intentarlo.")),
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

const toLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean)

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
  const ids = useId()
  const canAdmin = usePermission("settings.write")
  const isNewVersion = Boolean(initial && initial.status !== "borrador")
  const base = initial?.sections ?? null
  const [title, setTitle] = useState(initial?.title ?? "")
  const [procedure, setProcedure] = useState(base?.procedure ?? "")
  const [benefits, setBenefits] = useState((base?.benefits ?? []).join("\n"))
  const [risks, setRisks] = useState((base?.risks ?? []).join("\n"))
  const [alternatives, setAlternatives] = useState((base?.alternatives ?? []).join("\n"))
  const [consequences, setConsequences] = useState(base?.consequences ?? "")
  const [notes, setNotes] = useState(base?.notes ?? "")
  const [specialtyId, setSpecialtyId] = useState<string>(initial?.specialtyId ?? "")
  const [formError, setFormError] = useState<string | null>(null)
  const current = JSON.stringify({ title, procedure, benefits, risks, alternatives, consequences, notes, specialtyId })
  // Lo que había al abrir: con eso se sabe si hay algo sin guardar.
  const [opened] = useState(current)
  useReportDirty(current !== opened, onDirtyChange)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })
  const specialties = specialtiesQuery.data?.data ?? []

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        title: title.trim(),
        sections: {
          procedure: procedure.trim(),
          benefits: toLines(benefits),
          risks: toLines(risks),
          alternatives: toLines(alternatives),
          consequences: consequences.trim(),
          notes: notes.trim() || null,
        },
        specialtyId: specialtyId ? specialtyId : null,
      }
      if (initial && !isNewVersion) return updateConsentTemplate(initial.id, payload)
      // Una versión nueva conserva la clave de su plantilla; una plantilla nueva la recibe del servidor.
      return createConsentTemplate({ ...payload, ...(initial ? { key: initial.key } : {}) })
    },
    onSuccess: () => {
      toast.success(`Borrador de «${title.trim()}» guardado`)
      onDone()
    },
    onError: (error: unknown) => setFormError(errorText(error, "No pudimos guardar el borrador. Vuelve a intentarlo.")),
  })

  const missing = (): string | null => {
    if (!title.trim()) return "Escribe el título"
    if (procedure.trim().length < 10) return "Describe el procedimiento (al menos 10 caracteres)"
    if (toLines(benefits).length === 0) return "Indica al menos un beneficio"
    if (toLines(risks).length === 0) return "Indica al menos un riesgo"
    if (toLines(alternatives).length === 0) return "Indica al menos una alternativa"
    if (consequences.trim().length < 10) return "Describe las consecuencias de no tratarse"
    return null
  }

  const listHelp = "Uno por línea."
  return (
    <FormDrawer
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
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const problem = missing()
        setFormError(problem)
        if (!problem) saveMutation.mutate()
      }}
      isSubmitting={saveMutation.isPending}
      isDirty={current !== opened}
      error={formError}
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
        <Field>
          <FieldLabel htmlFor={`${ids}-title`}>Título</FieldLabel>
          <Input
            id={`${ids}-title`}
            aria-required="true"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            disabled={!canAdmin}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-specialty`}>Especialidad</FieldLabel>
          <Select
            items={Object.fromEntries([["ninguna", "Sin especialidad"], ...specialties.map((s) => [s.id, s.name])])}
            value={specialtyId || "ninguna"}
            onValueChange={(v: string | null) => setSpecialtyId(v === "ninguna" ? "" : (v ?? ""))}
            disabled={!canAdmin}
          >
            <SelectTrigger id={`${ids}-specialty`}>
              <SelectValue placeholder="Sin especialidad" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ninguna">Sin especialidad</SelectItem>
              {specialties.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-procedure`}>Procedimiento propuesto</FieldLabel>
          <Textarea
            id={`${ids}-procedure`}
            aria-required="true"
            value={procedure}
            onChange={(event) => setProcedure(event.target.value)}
            rows={3}
            maxLength={4000}
            disabled={!canAdmin}
          />
        </Field>
        {(
          [
            ["benefits", "Beneficios esperados", benefits, setBenefits],
            ["risks", "Riesgos y molestias", risks, setRisks],
            ["alternatives", "Alternativas", alternatives, setAlternatives],
          ] as const
        ).map(([id, label, value, set]) => (
          <Field key={id}>
            <FieldLabel htmlFor={`${ids}-${id}`}>{label}</FieldLabel>
            <Textarea
              id={`${ids}-${id}`}
              aria-required="true"
              aria-describedby={`${ids}-${id}-help`}
              value={value}
              onChange={(event) => set(event.target.value)}
              rows={4}
              disabled={!canAdmin}
            />
            <FieldDescription id={`${ids}-${id}-help`}>{listHelp}</FieldDescription>
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${ids}-consequences`}>Consecuencias de no tratarse</FieldLabel>
          <Textarea
            id={`${ids}-consequences`}
            aria-required="true"
            value={consequences}
            onChange={(event) => setConsequences(event.target.value)}
            rows={2}
            maxLength={4000}
            disabled={!canAdmin}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-notes`}>Información adicional (opcional)</FieldLabel>
          <Textarea
            id={`${ids}-notes`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={4000}
            disabled={!canAdmin}
          />
        </Field>
      </div>
    </FormDrawer>
  )
}
