import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  archiveFormTemplate,
  createConsentTemplate,
  createFormTemplate,
  fetchConsentTemplates,
  fetchFormTemplates,
  fetchSpecialties,
  archiveConsentTemplate,
  createSuggestedConsentTemplates,
  publishConsentTemplate,
  publishFormTemplate,
  updateConsentTemplate,
  updateFormTemplate,
  FIELD_TYPE_LABELS,
  type ConsentTemplate,
  type FormFieldDef,
  type FormFieldType,
  type FormSchemaDef,
  type FormSectionDef,
  type FormTemplate,
} from "../../lib/clinical-forms"

export const Route = createFileRoute("/_org/settings/forms")({
  component: FormulariosPage,
})

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]

/**
 * Formularios clínicos y consentimientos: diseñador tipado por secciones y
 * campos (sin JSON crudo), versionado con publicación inmutable.
 */
function FormulariosPage() {
  const [tab, setTab] = useState("formularios")
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Formularios y consentimientos"
        subtitle="Plantillas versionadas por especialidad: se diseñan en borrador y se publican sin alterar registros previos."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Plantillas">
          <TabsTrigger value="formularios">Formularios clínicos</TabsTrigger>
          <TabsTrigger value="consentimientos">Consentimientos</TabsTrigger>
        </TabsList>
        <TabsContent value="formularios" className="pt-4">
          <FormTemplatesPanel />
        </TabsContent>
        <TabsContent value="consentimientos" className="pt-4">
          <ConsentTemplatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formularios clínicos
// ---------------------------------------------------------------------------

function slugifyLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
  return base || "campo"
}

function FormTemplatesPanel() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("settings.write")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<FormTemplate | null>(null)
  const [publishing, setPublishing] = useState<FormTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<() => void>(() => {})

  const listQuery = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => fetchFormTemplates(),
  })
  const templates = listQuery.data?.data ?? []

  const grouped = useMemo(() => {
    const byKey = new Map<string, FormTemplate[]>()
    for (const item of templates) {
      const list = byKey.get(item.key) ?? []
      list.push(item)
      byKey.set(item.key, list)
    }
    return [...byKey.values()].map((versions) =>
      versions.sort((a, b) => b.version - a.version),
    )
  }, [templates])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["form-templates"] })
  }
  const fail = (e: unknown) => {
    const message =
      e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación"
    setError(message)
    toast.error(message)
  }

  const publishMutation = useMutation({
    mutationFn: (id: string) => publishFormTemplate(id),
    onSuccess: () => {
      setPublishing(null)
      invalidate()
      toast.success("Versión publicada")
    },
    onError: fail,
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveFormTemplate(id),
    onSuccess: () => {
      invalidate()
      toast.success("Plantilla archivada")
    },
    onError: fail,
  })

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorState message={error} onRetry={() => setError(null)} /> : null}
      <div className="flex justify-end">
        {canAdmin ? (
          <Button
            type="button"
            onClick={() => {
              setEditing(null)
              setDrawerOpen(true)
            }}
          >
            Nueva plantilla
          </Button>
        ) : null}
      </div>
      {listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : listQuery.isError ? (
        <ErrorState
          message="No se pudieron cargar las plantillas"
          onRetry={() => void listQuery.refetch()}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="Sin plantillas"
          description="Diseña la primera con secciones y campos tipados, luego publícala para usarla en la ficha del paciente."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {grouped.map((versions) => {
            const latest = versions[0]!
            return (
              <li key={latest.key} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{latest.title}</p>
                    <p className="text-sm text-muted-foreground">
                      Clave «{latest.key}» · {versions.length}{" "}
                      {versions.length === 1 ? "versión" : "versiones"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {versions.map((version) => (
                      <Badge
                        key={version.id}
                        variant={version.status === "publicado" ? "default" : "secondary"}
                      >
                        v{version.version} · {FORM_TEMPLATE_STATUS_LABELS[version.status]}
                      </Badge>
                    ))}
                    {latest.respondent === "portal" ? (
                      <Badge variant="outline">Lo responde el paciente</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {versions
                    .filter((v) => v.status === "borrador")
                    .map((draft) => (
                      <div key={draft.id} className="flex gap-2">
                        {canAdmin ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditing(draft)
                                setDrawerOpen(true)
                              }}
                            >
                              Editar borrador v{draft.version}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setPublishing(draft)}
                            >
                              Publicar versión {draft.version}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => archiveMutation.mutate(draft.id)}
                            >
                              Archivar
                            </Button>
                          </>
                        ) : null}
                      </div>
                    ))}
                  {canAdmin && latest.status !== "borrador" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing({ ...latest })
                        setDrawerOpen(true)
                      }}
                    >
                      Nueva versión desde la {latest.version}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing && editing.id ? "Editar plantilla" : "Nueva plantilla"}
        onSubmit={() => submitRef.current()}
        submitLabel="Guardar borrador"
      >
        <TemplateBuilder
          key={editing?.id ?? "nueva"}
          initial={editing}
          registerSubmit={(fn) => {
            submitRef.current = fn
          }}
          onDone={() => {
            setDrawerOpen(false)
            setEditing(null)
            invalidate()
          }}
          onError={fail}
        />
      </FormDrawer>
      <ConfirmDialog
        open={publishing !== null}
        onClose={() => setPublishing(null)}
        title={publishing ? `Publicar la versión ${publishing.version}` : "Publicar"}
        description={(() => {
          const current = publishing
            ? templates.find((t) => t.key === publishing.key && t.status === "publicado")
            : undefined
          return current
            ? `La versión ${current.version} se archiva y «Nuevo formulario» ofrecerá la ${publishing?.version}. Las capturas previas conservan su título y esquema.`
            : "Quedará disponible para capturar en la ficha. Las capturas conservan su título y esquema."
        })()}
        confirmLabel="Publicar"
        variant="default"
        pending={publishMutation.isPending}
        onConfirm={() => {
          if (publishing) publishMutation.mutate(publishing.id)
        }}
      />
    </div>
  )
}

function TemplateBuilder({
  initial,
  registerSubmit,
  onDone,
  onError,
}: {
  initial: FormTemplate | null
  registerSubmit: (fn: () => void) => void
  onDone: () => void
  onError: (e: unknown) => void
}) {
  const canAdmin = usePermission("settings.write")
  const isNewVersion = Boolean(initial && initial.status !== "borrador")
  const [title, setTitle] = useState(initial?.title ?? "")
  const [key, setKey] = useState(initial?.key ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [specialtyId, setSpecialtyId] = useState<string>(initial?.specialtyId ?? "")
  const [respondent, setRespondent] = useState<"staff" | "portal">(initial?.respondent ?? "staff")
  const [sections, setSections] = useState<FormSectionDef[]>(
    initial ? structuredClone(initial.schema.sections) : [{ id: "general", title: "General", fields: [] }],
  )
  const [formError, setFormError] = useState<string | null>(null)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })
  const specialties = specialtiesQuery.data?.data ?? []

  const saveMutation = useMutation({
    mutationFn: () => {
      const schema: FormSchemaDef = { sections }
      const body = {
        title: title.trim(),
        ...(key.trim() ? { key: key.trim().toLowerCase() } : {}),
        description: description.trim() ? description.trim() : null,
        specialtyId: specialtyId ? specialtyId : null,
        respondent,
        schema,
      }
      if (initial && !isNewVersion) return updateFormTemplate(initial.id, body)
      return createFormTemplate(body)
    },
    onSuccess: () => {
      toast.success("Plantilla guardada como borrador")
      onDone()
    },
    onError: (e: unknown) => {
      const message =
        e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación"
      setFormError(message)
      onError(e)
    },
  })

  useEffect(() => {
    registerSubmit(() => {
      if (!title.trim()) {
        setFormError("Ingresa el título")
        return
      }
      if (sections.length === 0) {
        setFormError("Agrega al menos una sección")
        return
      }
      for (const section of sections) {
        if (!section.title.trim()) {
          setFormError("Cada sección necesita un título")
          return
        }
        if (section.fields.length === 0) {
          setFormError(`«${section.title}» necesita al menos un campo`)
          return
        }
      }
      setFormError(null)
      saveMutation.mutate()
    })
  })

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
    <div className="flex flex-col gap-5">
      {isNewVersion ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          La v{initial!.version} está publicada e inmutable: al guardar se crea un borrador nuevo
          con la misma clave.
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor="tpl-title">Título</FieldLabel>
        <Input
          id="tpl-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          disabled={!canAdmin}
        />
      </Field>
      {(!initial || isNewVersion) && (
        <Field>
          <FieldLabel htmlFor="tpl-key">Clave (opcional)</FieldLabel>
          <Input
            id="tpl-key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="evaluacion-endodoncia"
            maxLength={40}
            disabled={!canAdmin || (isNewVersion ? true : false)}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="tpl-description">Descripción</FieldLabel>
        <Textarea
          id="tpl-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          maxLength={2000}
          disabled={!canAdmin}
        />
      </Field>
      <Field>
        <FieldLabel>Especialidad</FieldLabel>
        <Select value={specialtyId || "ninguna"} onValueChange={(v: string | null) => setSpecialtyId(v === "ninguna" ? "" : (v ?? ""))} disabled={!canAdmin}>
          <SelectTrigger aria-label="Especialidad">
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
        <FieldLabel htmlFor="tpl-respondent">Quién lo responde</FieldLabel>
        <Select
          items={{ staff: "El equipo, desde la ficha o la atención", portal: "El paciente, desde el portal (cuestionario previo)" }}
          value={respondent}
          onValueChange={(v) => setRespondent(v === "portal" ? "portal" : "staff")}
          disabled={!canAdmin}
        >
          <SelectTrigger id="tpl-respondent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="staff">El equipo, desde la ficha o la atención</SelectItem>
            <SelectItem value="portal">El paciente, desde el portal (cuestionario previo)</SelectItem>
          </SelectContent>
        </Select>
        {respondent === "portal" ? (
          <p className="text-xs text-muted-foreground">
            Lo que responde el paciente llega como «declarado»; el profesional lo revisa y lo
            finaliza.
          </p>
        ) : null}
      </Field>
      {sections.map((section, si) => (
        <section key={section.id} className="rounded-md border p-3">
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
                onClick={() => setSections((prev) => prev.filter((s) => s.id !== section.id))}
              >
                Quitar
              </Button>
            ) : null}
          </div>
          <div className="mt-3 flex flex-col gap-3">
            {section.fields.map((field) => (
              <FieldEditor
                key={field.id}
                field={field}
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
      {formError ? <FieldError>{formError}</FieldError> : null}
      {saveMutation.isPending ? (
        <p className="text-sm text-muted-foreground">Guardando…</p>
      ) : null}
    </div>
  )
}

function FieldEditor({
  field,
  previousFields,
  disabled,
  onPatch,
  onRemove,
}: {
  field: FormFieldDef
  /** Campos anteriores Sí/No u opciones: los únicos que pueden condicionar este. */
  previousFields: FormFieldDef[]
  disabled: boolean
  onPatch: (patch: Partial<FormFieldDef>) => void
  onRemove: () => void
}) {
  const conditionSource = previousFields.find((f) => f.id === field.showIf?.field)
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field>
          <FieldLabel>Etiqueta</FieldLabel>
          <Input
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
          <FieldLabel>Tipo</FieldLabel>
          <Select
            value={field.type}
            onValueChange={(value) =>
              onPatch(
                value === "escala"
                  ? { type: "escala", min: field.min ?? 0, max: field.max ?? 10 }
                  : { type: value as FormFieldType },
              )
            }
            disabled={disabled}
          >
            <SelectTrigger aria-label="Tipo de campo">
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
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={Boolean(field.required)}
            disabled={disabled}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          Obligatorio
        </label>
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
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
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
            <SelectTrigger className="w-56" aria-label="Campo que condiciona">
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
                <SelectTrigger className="w-40" aria-label="Valor que muestra el campo">
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
        aria-label="Ayuda"
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
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <Badge key={option} variant="secondary" className="gap-1">
            {option}
            {!disabled ? (
              <button
                type="button"
                aria-label={`Quitar ${option}`}
                onClick={() => onChange(options.filter((o) => o !== option))}
              >
                ×
              </button>
            ) : null}
          </Badge>
        ))}
      </div>
      {!disabled ? (
        <div className="mt-2 flex gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Nueva opción"
            maxLength={120}
            aria-label="Nueva opción"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const value = draft.trim()
              if (value && !options.includes(value)) onChange([...options, value])
              setDraft("")
            }}
          >
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

const FORM_TEMPLATE_STATUS_LABELS: Record<FormTemplate["status"], string> = {
  borrador: "borrador",
  publicado: "vigente",
  archivado: "archivada",
}

function ConsentTemplatesPanel() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("settings.write")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<ConsentTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<
    | { kind: "publish"; draft: ConsentTemplate; current: ConsentTemplate | undefined }
    | { kind: "archive"; template: ConsentTemplate }
    | null
  >(null)

  const listQuery = useQuery({
    queryKey: ["consent-templates"],
    queryFn: () => fetchConsentTemplates(),
  })
  const templates = listQuery.data?.data ?? []
  const grouped = useMemo(() => {
    const byKey = new Map<string, ConsentTemplate[]>()
    for (const item of templates) {
      const list = byKey.get(item.key) ?? []
      list.push(item)
      byKey.set(item.key, list)
    }
    return [...byKey.values()]
      .map((versions) => versions.sort((a, b) => b.version - a.version))
      .sort((a, b) => a[0]!.title.localeCompare(b[0]!.title, "es"))
  }, [templates])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["consent-templates"] })
    void queryClient.invalidateQueries({ queryKey: ["consent-templates-published"] })
  }
  const fail = (e: unknown) => {
    const message =
      e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación"
    setError(message)
  }

  const publishMutation = useMutation({
    mutationFn: (id: string) => publishConsentTemplate(id),
    onSuccess: (result) => {
      setConfirm(null)
      invalidate()
      toast.success(`Publicada la versión ${result.data.version}`)
    },
    onError: (e) => {
      setConfirm(null)
      fail(e)
    },
  })
  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveConsentTemplate(id),
    onSuccess: () => {
      setConfirm(null)
      invalidate()
      toast.success("Plantilla archivada")
    },
    onError: (e) => {
      setConfirm(null)
      fail(e)
    },
  })
  const suggestedMutation = useMutation({
    mutationFn: () => createSuggestedConsentTemplates(),
    onSuccess: (result) => {
      invalidate()
      toast.success(
        result.data.length > 0
          ? `${result.data.length} plantilla(s) sugerida(s) creadas como borrador: revísalas antes de publicar`
          : "Ya tienes todas las plantillas sugeridas",
      )
    },
    onError: fail,
  })

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {canAdmin ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={suggestedMutation.isPending}
            onClick={() => suggestedMutation.mutate()}
          >
            Añadir plantillas sugeridas
          </Button>
          <Button
            type="button"
            onClick={() => {
              setEditing(null)
              setDrawerOpen(true)
            }}
          >
            Nueva plantilla
          </Button>
        </div>
      ) : null}
      {listQuery.isPending ? (
        <LoadingState message="Cargando consentimientos…" />
      ) : listQuery.isError ? (
        <ErrorState
          message="No se pudieron cargar los consentimientos"
          onRetry={() => void listQuery.refetch()}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="Sin plantillas de consentimiento"
          description="Empieza con las plantillas sugeridas por procedimiento o redacta una: procedimiento, beneficios, riesgos, alternativas y consecuencias de no tratarse."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {grouped.map((versions) => {
            const latest = versions[0]!
            const draft = versions.find((v) => v.status === "borrador")
            const current = versions.find((v) => v.status === "publicado")
            return (
              <li key={latest.key} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{latest.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {current ? `Vigente: versión ${current.version}` : "Sin versión vigente"}
                      {draft ? ` · borrador de la versión ${draft.version}` : ""}
                      {latest.sections ? "" : " · texto libre (anterior a las secciones)"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {versions.map((version) => (
                      <Badge
                        key={version.id}
                        variant={version.status === "publicado" ? "default" : "secondary"}
                      >
                        v{version.version} · {CONSENT_TEMPLATE_STATUS_LABELS[version.status]}
                      </Badge>
                    ))}
                  </div>
                </div>
                {canAdmin ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {draft ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(draft)
                            setDrawerOpen(true)
                          }}
                        >
                          Editar borrador
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => setConfirm({ kind: "publish", draft, current })}
                        >
                          Publicar versión {draft.version}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing({ ...latest })
                          setDrawerOpen(true)
                        }}
                      >
                        Nueva versión desde la {latest.version}
                      </Button>
                    )}
                    {current ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm({ kind: "archive", template: current })}
                      >
                        Archivar…
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <ConsentBuilder
        key={editing?.id ?? "nuevo"}
        open={drawerOpen}
        initial={editing}
        onClose={() => setDrawerOpen(false)}
        onDone={() => {
          setDrawerOpen(false)
          setEditing(null)
          invalidate()
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "publish"}
        variant="default"
        title={
          confirm?.kind === "publish" ? `Publicar la versión ${confirm.draft.version}` : "Publicar"
        }
        description={
          confirm?.kind === "publish"
            ? confirm.current
              ? `La versión ${confirm.current.version} se archiva: los consentimientos nuevos usarán la ${confirm.draft.version}. Los ya generados conservan su texto.`
              : "Quedará disponible para generar consentimientos en la ficha."
            : ""
        }
        confirmLabel="Publicar"
        pending={publishMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "publish" && publishMutation.mutate(confirm.draft.id)}
      />
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        title="Archivar plantilla"
        description="Deja de ofrecerse para consentimientos nuevos. Los documentos ya generados no cambian."
        confirmLabel="Archivar"
        pending={archiveMutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "archive" && archiveMutation.mutate(confirm.template.id)}
      />
    </div>
  )
}

const CONSENT_TEMPLATE_STATUS_LABELS: Record<ConsentTemplate["status"], string> = {
  borrador: "borrador",
  publicado: "vigente",
  archivado: "archivada",
}

const toLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean)

function ConsentBuilder({
  open,
  initial,
  onClose,
  onDone,
}: {
  open: boolean
  initial: ConsentTemplate | null
  onClose: () => void
  onDone: () => void
}) {
  const ids = useId()
  const canAdmin = usePermission("settings.write")
  const isNewVersion = Boolean(initial && initial.status !== "borrador")
  const base = initial?.sections ?? null
  const [title, setTitle] = useState(initial?.title ?? "")
  const [key, setKey] = useState(isNewVersion ? (initial?.key ?? "") : "")
  const [procedure, setProcedure] = useState(base?.procedure ?? "")
  const [benefits, setBenefits] = useState((base?.benefits ?? []).join("\n"))
  const [risks, setRisks] = useState((base?.risks ?? []).join("\n"))
  const [alternatives, setAlternatives] = useState((base?.alternatives ?? []).join("\n"))
  const [consequences, setConsequences] = useState(base?.consequences ?? "")
  const [notes, setNotes] = useState(base?.notes ?? "")
  const [specialtyId, setSpecialtyId] = useState<string>(initial?.specialtyId ?? "")
  const [formError, setFormError] = useState<string | null>(null)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
    enabled: open,
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        title: title.trim(),
        ...(key.trim() ? { key: key.trim().toLowerCase() } : {}),
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
      return createConsentTemplate(payload)
    },
    onSuccess: () => {
      toast.success("Plantilla guardada como borrador")
      onDone()
    },
    onError: (e: unknown) =>
      setFormError(
        e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación",
      ),
  })

  const missing = (): string | null => {
    if (!title.trim()) return "Ingresa el título"
    if (procedure.trim().length < 10) return "Describe el procedimiento (mín. 10 caracteres)"
    if (toLines(benefits).length === 0) return "Indica al menos un beneficio"
    if (toLines(risks).length === 0) return "Indica al menos un riesgo"
    if (toLines(alternatives).length === 0) return "Indica al menos una alternativa"
    if (consequences.trim().length < 10) return "Describe las consecuencias de no tratarse"
    return null
  }

  const listHelp = "Uno por línea."
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title={
        initial && !isNewVersion
          ? `Editar borrador · versión ${initial.version}`
          : initial
            ? `Nueva versión de «${initial.title}»`
            : "Nueva plantilla"
      }
      description="Secciones fijas del consentimiento informado. El diagnóstico y el profesional que informa se toman de la atención al generarlo."
      onSubmit={(event) => {
        event.preventDefault()
        const problem = missing()
        setFormError(problem)
        if (!problem) saveMutation.mutate()
      }}
      isSubmitting={saveMutation.isPending}
      isDirty
      error={formError}
      submitLabel="Guardar borrador"
      submitDisabled={!canAdmin}
    >
      <div className="flex flex-col gap-4">
        {isNewVersion ? (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            La versión {initial!.version} es inmutable: al guardar se crea un borrador de la
            siguiente versión.
          </p>
        ) : null}
        {initial && !initial.sections ? (
          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Texto anterior (referencia)</summary>
            <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{initial.body}</p>
          </details>
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
        {!initial ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-key`}>Clave (opcional)</FieldLabel>
            <Input
              id={`${ids}-key`}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              maxLength={40}
              disabled={!canAdmin}
            />
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${ids}-specialty`}>Especialidad</FieldLabel>
          <Select
            items={Object.fromEntries([
              ["ninguna", "Sin especialidad"],
              ...(specialtiesQuery.data?.data ?? []).map((s) => [s.id, s.name]),
            ])}
            value={specialtyId || "ninguna"}
            onValueChange={(v: string | null) => setSpecialtyId(v === "ninguna" ? "" : (v ?? ""))}
            disabled={!canAdmin}
          >
            <SelectTrigger id={`${ids}-specialty`}>
              <SelectValue placeholder="Sin especialidad" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ninguna">Sin especialidad</SelectItem>
              {(specialtiesQuery.data?.data ?? []).map((s) => (
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
            <p id={`${ids}-${id}-help`} className="text-xs text-muted-foreground">
              {listHelp}
            </p>
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
