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
  Textarea,
  toast,
} from "@odentia/ui"
import { EmptyState, ErrorState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  addFormAddendum,
  createFormResponse,
  fetchFormAddenda,
  fetchFormResponses,
  fetchFormTemplates,
  fetchSpecialties,
  finalizeFormResponse,
  updateFormResponse,
  type FormFieldDef,
  type FormResponse,
  type FormSchemaDef,
  type FormTemplate,
} from "../../lib/clinical-forms"
import { useOrgMembers, usePermission } from "../../lib/crm"
import { FirmaPad, FirmaView } from "./firma-pad"

/**
 * Formularios clínicos del paciente: captura por plantilla publicada con
 * profesional responsable, estados borrador/finalizado y adendas.
 * Publicar una versión nueva no altera estas capturas (guardan snapshot).
 */
export function FormulariosTab({
  patientId,
  encounterId,
}: {
  patientId: string
  encounterId?: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  const [templateId, setTemplateId] = useState("")
  const [specialtyId, setSpecialtyId] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const submitRef = useRef<() => void>(() => {})

  const templatesQuery = useQuery({
    queryKey: ["form-templates-published"],
    queryFn: () => fetchFormTemplates({ status: "publicado" }),
    enabled: canRead,
  })
  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
    enabled: canRead,
  })
  const responsesQuery = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: canRead,
  })

  const templates = useMemo(() => {
    const all = templatesQuery.data?.data ?? []
    return specialtyId ? all.filter((t) => t.specialtyId === specialtyId) : all
  }, [templatesQuery.data, specialtyId])
  const responses = responsesQuery.data?.data ?? []
  const selected = responses.find((r) => r.id === selectedId) ?? null
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["form-responses", patientId] })
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Formularios clínicos"
        subtitle="Captura estructurada por especialidad, con validación y cierre."
        actions={
          canWrite && templates.length > 0 ? (
            <Button type="button" onClick={() => setDrawerOpen(true)}>
              Nuevo formulario
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select value={specialtyId || "todas"} onValueChange={(v: string | null) => setSpecialtyId(v === "todas" ? "" : (v ?? ""))}>
          <SelectTrigger className="w-56" aria-label="Filtrar por especialidad">
            <SelectValue placeholder="Todas las especialidades" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas las especialidades</SelectItem>
            {(specialtiesQuery.data?.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {responsesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : responsesQuery.isError ? (
        <ErrorState message="No se pudieron cargar los formularios" onRetry={() => void responsesQuery.refetch()} />
      ) : responses.length === 0 ? (
        <EmptyState
          title="Sin formularios capturados"
          description={
            templates.length === 0
              ? "Aún no hay plantillas publicadas para esta especialidad."
              : "Inicia el primero con el botón Nuevo formulario."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {responses.map((response) => (
            <li key={response.id} className="rounded-md border p-3">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                onClick={() => setSelectedId(response.id)}
              >
                <span className="text-sm font-medium">{templateTitle(templates, response)}</span>
                <span className="flex items-center gap-2">
                  <Badge variant={response.status === "finalizado" ? "default" : "secondary"}>
                    {response.status} · v{response.templateVersion}
                  </Badge>
                </span>
              </button>
              {selected?.id === response.id ? (
                <ResponseDetail response={selected} canWrite={canWrite} onChanged={invalidate} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo formulario"
        onSubmit={() => submitRef.current()}
        submitLabel="Crear borrador"
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Plantilla publicada</FieldLabel>
            <Select value={templateId} onValueChange={(v: string | null) => setTemplateId(v ?? "")}>
              <SelectTrigger aria-label="Plantilla">
                <SelectValue placeholder="Elige una plantilla" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title} (v{t.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {templateId ? (
            <NewResponseForm
              patientId={patientId}
              encounterId={encounterId}
              template={templates.find((t) => t.id === templateId)!}
              registerSubmit={(fn) => {
                submitRef.current = fn
              }}
              onDone={(id) => {
                setDrawerOpen(false)
                setTemplateId("")
                setSelectedId(id)
                invalidate()
              }}
            />
          ) : null}
        </div>
      </FormDrawer>
    </div>
  )
}

function templateTitle(templates: FormTemplate[], response: FormResponse): string {
  const found = templates.find((t) => t.id === response.templateId)
  return found ? found.title : `Formulario v${response.templateVersion}`
}

function snapshotOf(response: FormResponse): FormSchemaDef {
  return response.templateSnapshot
}

function ResponseDetail({
  response,
  canWrite,
  onChanged,
}: {
  response: FormResponse
  canWrite: boolean
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, unknown>>({ ...response.answers })
  const [professionalUserId, setProfessionalUserId] = useState<string>(
    response.professionalUserId ?? "",
  )
  const [addendum, setAddendum] = useState("")
  const members = useOrgMembers()
  const schema = snapshotOf(response)
  const fields = useMemo(() => schema.sections.flatMap((s) => s.fields), [schema])


  const addendaQuery = useQuery({
    queryKey: ["form-addenda", response.id],
    queryFn: () => fetchFormAddenda(response.id),
    enabled: response.status === "finalizado",
  })

  const fail = (e: unknown) =>
    toast.error(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")

  const saveMutation = useMutation({
    mutationFn: () =>
      updateFormResponse(response.id, {
        answers,
        professionalUserId: professionalUserId ? professionalUserId : null,
      }),
    onSuccess: () => {
      onChanged()
      toast.success("Borrador guardado")
    },
    onError: fail,
  })

  const finalizeMutation = useMutation({
    mutationFn: () => finalizeFormResponse(response.id),
    onSuccess: () => {
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Formulario finalizado")
    },
    onError: fail,
  })

  const addendumMutation = useMutation({
    mutationFn: () => addFormAddendum(response.id, addendum),
    onSuccess: () => {
      setAddendum("")
      void queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Adenda registrada")
    },
    onError: fail,
  })

  const readOnly = response.status === "finalizado" || !canWrite

  return (
    <div className="mt-3 flex flex-col gap-4 border-t pt-3">
      {schema.sections.map((section) => (
        <section key={section.id}>
          <h4 className="text-sm font-semibold">{section.title}</h4>
          <div className="mt-2 grid gap-3">
            {section.fields.map((field) => (
              <AnswerInput
                key={field.id}
                field={field}
                value={answers[field.id]}
                disabled={readOnly}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [field.id]: value }))}
              />
            ))}
          </div>
        </section>
      ))}
      {readOnly ? (
        <ProfessionalLine userId={response.professionalUserId} members={members} />
      ) : (
        <Field>
          <FieldLabel>Profesional responsable</FieldLabel>
          <Select
            value={professionalUserId || "ninguno"}
            onValueChange={(v: string | null) => setProfessionalUserId(v === "ninguno" ? "" : (v ?? ""))}
          >
            <SelectTrigger aria-label="Profesional responsable">
              <SelectValue placeholder="Sin asignar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ninguno">Sin asignar</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            Guardar borrador
          </Button>
          <Button type="button" disabled={finalizeMutation.isPending} onClick={() => finalizeMutation.mutate()}>
            Finalizar
          </Button>
        </div>
      ) : null}
      {response.status === "finalizado" ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Adendas</h4>
          {(addendaQuery.data?.data ?? []).map((item) => (
            <p key={item.id} className="rounded-md border p-2 text-sm">
              {item.text}
            </p>
          ))}
          {(addendaQuery.data?.data ?? []).length === 0 && !addendaQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Sin adendas.</p>
          ) : null}
          {canWrite ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={addendum}
                onChange={(event) => setAddendum(event.target.value)}
                rows={2}
                maxLength={5000}
                placeholder="Corrección o alcance posterior (no modifica lo finalizado)"
                aria-label="Nueva adenda"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!addendum.trim() || addendumMutation.isPending}
                onClick={() => addendumMutation.mutate()}
              >
                Agregar adenda
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {fields.length === 0 ? <p className="text-sm text-muted-foreground">Sin campos.</p> : null}
    </div>
  )
}

function ProfessionalLine({
  userId,
  members,
}: {
  userId: string | null
  members: Array<{ userId: string; user: { name: string } }>
}) {
  if (!userId) return <p className="text-sm text-muted-foreground">Sin profesional asignado.</p>
  const found = members.find((m) => m.userId === userId)
  return (
    <p className="text-sm text-muted-foreground">
      Profesional: {found ? found.user.name : userId}
    </p>
  )
}

function NewResponseForm({
  patientId,
  encounterId,
  template,
  registerSubmit,
  onDone,
}: {
  patientId: string
  encounterId?: string
  template: FormTemplate
  registerSubmit: (fn: () => void) => void
  onDone: (id: string) => void
}) {
  const members = useOrgMembers()
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [professionalUserId, setProfessionalUserId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const createMutation = useMutation({
    mutationFn: () =>
      createFormResponse({
        templateId: template.id,
        patientId,
        encounterId: encounterId ?? null,
        professionalUserId: professionalUserId ? professionalUserId : null,
        answers,
      }),
    onSuccess: (result) => {
      toast.success("Formulario creado como borrador")
      onDone(result.data.id)
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  useEffect(() => {
    registerSubmit(() => {
      setError(null)
      createMutation.mutate()
    })
  })

  return (
    <div className="flex flex-col gap-4">
      {template.schema.sections.map((section) => (
        <section key={section.id}>
          <h4 className="text-sm font-semibold">{section.title}</h4>
          <div className="mt-2 grid gap-3">
            {section.fields.map((field) => (
              <AnswerInput
                key={field.id}
                field={field}
                value={answers[field.id]}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [field.id]: value }))}
              />
            ))}
          </div>
        </section>
      ))}
      <Field>
        <FieldLabel>Profesional responsable</FieldLabel>
        <Select
          value={professionalUserId || "ninguno"}
          onValueChange={(v: string | null) => setProfessionalUserId(v === "ninguno" ? "" : (v ?? ""))}
        >
          <SelectTrigger aria-label="Profesional responsable">
            <SelectValue placeholder="Sin asignar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ninguno">Sin asignar</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                {m.user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      {createMutation.isPending ? (
        <p className="text-sm text-muted-foreground">Creando…</p>
      ) : null}
    </div>
  )
}

function isStrokes(raw: unknown): raw is number[][][] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (stroke: unknown) =>
        Array.isArray(stroke) &&
        stroke.every(
          (point: unknown) =>
            Array.isArray(point) && point.every((n: unknown) => typeof n === "number"),
        ),
    )
  )
}

export function AnswerInput({
  field,
  value,
  disabled = false,
  onChange,
}: {
  field: FormFieldDef
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const label = `${field.label}${field.required ? " *" : ""}${field.unit ? ` (${field.unit})` : ""}`
  switch (field.type) {
    case "texto":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Input
            value={typeof value === "string" ? value : ""}
            maxLength={500}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </Field>
      )
    case "texto_largo":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Textarea
            value={typeof value === "string" ? value : ""}
            rows={3}
            maxLength={5000}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </Field>
      )
    case "numero":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Input
            type="number"
            value={typeof value === "number" ? value : ""}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            disabled={disabled}
            onChange={(event) =>
              onChange(event.target.value === "" ? null : Number(event.target.value))
            }
          />
        </Field>
      )
    case "booleano":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          {label}
        </label>
      )
    case "opcion_unica":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Select
            value={typeof value === "string" ? value : ""}
            onValueChange={onChange}
            disabled={disabled}
          >
            <SelectTrigger aria-label={field.label}>
              <SelectValue placeholder="Elige una opción" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )
    case "opcion_multiple": {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <fieldset>
          <legend className="text-sm font-medium">{label}</legend>
          <div className="mt-1 flex flex-col gap-1">
            {(field.options ?? []).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.includes(option)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...selected, option]
                        : selected.filter((v) => v !== option),
                    )
                  }
                />
                {option}
              </label>
            ))}
          </div>
        </fieldset>
      )
    }
    case "fecha":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Input
            type="date"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
          />
        </Field>
      )
    case "firma": {
      const rawStrokes: unknown =
        value && typeof value === "object" && "strokes" in value ? value.strokes : undefined
      const strokes: number[][][] = isStrokes(rawStrokes) ? rawStrokes : []
      return (
        <div>
          <p className="text-sm font-medium">{label}</p>
          {disabled ? (
            strokes.length > 0 ? (
              <FirmaView strokes={strokes} />
            ) : (
              <p className="text-sm text-muted-foreground">Sin firma registrada.</p>
            )
          ) : (
            <FirmaPad onChange={(next) => onChange({ strokes: next })} />
          )}
        </div>
      )
    }
  }
}
