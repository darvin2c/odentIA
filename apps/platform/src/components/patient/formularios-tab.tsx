import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  addFormAddendum,
  createFormResponse,
  discardFormResponse,
  FORM_RESPONSE_STATUS_LABELS,
  type FormResponse,
  type FormTemplate,
  fetchFormAddenda,
  fetchFormResponses,
  fetchFormTemplates,
  fetchSpecialties,
  finalizeFormResponse,
  updateFormResponse,
} from "../../lib/clinical-forms"
import { useMemberName, useOrgMembers, usePermission } from "../../lib/crm"
import type { PatientDocument } from "../../lib/patients"
import { imageTypeLabel } from "./document-labels"
import {
  AnswerInput,
  type AttachmentOption,
  answersForServer,
  isFieldVisible,
  missingRequired,
} from "./form-fields"
import { activeOrgLocale } from "../../lib/locale"

const errorMessage = (e: unknown) =>
  e instanceof ApiError
    ? (e.shape.message ?? "No se pudo completar la acción")
    : "No se pudo completar la acción"

const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium" }) : "—"

function statusOf(response: FormResponse): {
  label: string
  tone: "default" | "secondary" | "outline"
} {
  if (response.status === "borrador" && response.submittedAt)
    return { label: "Declarado por el paciente", tone: "secondary" }
  return {
    label: FORM_RESPONSE_STATUS_LABELS[response.status],
    tone:
      response.status === "finalizado"
        ? "default"
        : response.status === "descartado"
          ? "outline"
          : "secondary",
  }
}

/**
 * Formularios clínicos del paciente: lista con fecha, atención y profesional y
 * el detalle al lado. El borrador se guarda solo; «Finalizar» guarda, valida
 * lo obligatorio y confirma (después, solo adendas). Un borrador se descarta
 * con motivo. Lo enviado desde el portal llega como «declarado» y se revisa.
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
  const ids = useId()
  const [specialtyId, setSpecialtyId] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const memberName = useMemberName()

  // Desde la atención, primero los de las especialidades de quien atiende.
  const templatesQuery = useQuery({
    queryKey: ["form-templates-published", encounterId ? "mine-first" : "all"],
    queryFn: () => fetchFormTemplates({ status: "publicado", ...(encounterId ? { forUser: "me" } : {}) }),
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
  const templates = useMemo(() => templatesQuery.data?.data ?? [], [templatesQuery.data])
  const templateById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates])
  const responses = useMemo(() => {
    const all = responsesQuery.data?.data ?? []
    return all.filter((r) => {
      if (statusFilter === "declarado") return r.status === "borrador" && r.submittedAt
      if (statusFilter && r.status !== statusFilter) return false
      if (specialtyId) {
        const t = templateById.get(r.templateId)
        if (!t || t.specialtyId !== specialtyId) return false
      }
      return true
    })
  }, [responsesQuery.data, statusFilter, specialtyId, templateById])
  const selected = (responsesQuery.data?.data ?? []).find((r) => r.id === selectedId) ?? null
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["form-responses", patientId] })
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id={`${ids}-title`} className="text-base font-semibold">
            Formularios clínicos
          </h2>
          <p className="text-sm text-muted-foreground">
            Evaluaciones estructuradas por especialidad y cuestionarios del paciente.
          </p>
        </div>
        {canWrite ? (
          <Button
            type="button"
            disabled={templates.length === 0}
            onClick={() => setDrawerOpen(true)}
          >
            Nuevo formulario
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select
          items={Object.fromEntries([
            ["", "Todas las especialidades"],
            ...(specialtiesQuery.data?.data ?? []).map((s) => [s.id, s.name]),
          ])}
          value={specialtyId}
          onValueChange={(v) => setSpecialtyId(v ?? "")}
        >
          <SelectTrigger className="w-56" aria-label="Especialidad">
            <SelectValue placeholder="Todas las especialidades" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todas las especialidades</SelectItem>
            {(specialtiesQuery.data?.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={{
            "": "Todos los estados",
            borrador: "Borrador",
            declarado: "Declarado por el paciente",
            finalizado: "Finalizado",
            descartado: "Descartado",
          }}
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v ?? "")}
        >
          <SelectTrigger className="w-56" aria-label="Estado">
            <SelectValue placeholder="Todos los estados" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los estados</SelectItem>
            <SelectItem value="borrador">Borrador</SelectItem>
            <SelectItem value="declarado">Declarado por el paciente</SelectItem>
            <SelectItem value="finalizado">Finalizado</SelectItem>
            <SelectItem value="descartado">Descartado</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {responsesQuery.isPending ? (
        <LoadingState message="Cargando formularios…" />
      ) : responsesQuery.isError ? (
        <ErrorState
          message="No se pudieron cargar los formularios"
          onRetry={() => void responsesQuery.refetch()}
        />
      ) : responses.length === 0 ? (
        <EmptyState
          title="Sin formularios"
          description={
            templates.length === 0
              ? "No hay plantillas publicadas. Se diseñan en Configuración → Formularios y consentimientos."
              : (responsesQuery.data?.data ?? []).length > 0
                ? "Ningún formulario coincide con los filtros."
                : "Inicia el primero con «Nuevo formulario»."
          }
        />
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <ul aria-label="Formularios del paciente" className="flex flex-col gap-2">
            {responses.map((response) => {
              const status = statusOf(response)
              const active = response.id === selectedId
              return (
                <li key={response.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:border-primary ${active ? "border-primary bg-primary/5" : ""}`}
                    onClick={() => setSelectedId(response.id)}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {response.templateTitle ??
                          templateById.get(response.templateId)?.title ??
                          "Formulario"}{" "}
                        <span className="text-muted-foreground">
                          · versión {response.templateVersion}
                        </span>
                      </span>
                      <Badge variant={status.tone}>{status.label}</Badge>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {response.source === "portal"
                        ? "Respondido desde el portal"
                        : response.professionalUserId
                          ? memberName(response.professionalUserId)
                          : "Sin profesional asignado"}
                      {response.encounterId ? " · en atención" : ""} · actualizado{" "}
                      {when(response.updatedAt)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="min-w-0">
            {selected ? (
              <ResponseDetail
                key={selected.id}
                response={selected}
                canWrite={canWrite}
                onChanged={invalidate}
              />
            ) : (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                Elige un formulario para ver o continuar su captura.
              </p>
            )}
          </div>
        </div>
      )}
      <NewResponseDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        templates={templates.filter((t) => t.respondent !== "portal")}
        patientId={patientId}
        encounterId={encounterId}
        onCreated={async (id) => {
          setDrawerOpen(false)
          setSelectedId(id)
          await invalidate()
        }}
      />
    </section>
  )
}

export function NewResponseDrawer({
  open,
  onClose,
  templates,
  patientId,
  encounterId,
  defaultProfessionalUserId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** En el orden en que se ofrecen: desde la atención, primero los de su especialidad. */
  templates: FormTemplate[]
  patientId: string
  encounterId?: string
  /** Desde la atención, el responsable por defecto es quien atiende. */
  defaultProfessionalUserId?: string
  onCreated: (id: string) => Promise<void>
}) {
  const ids = useId()
  const members = useOrgMembers()
  const [templateId, setTemplateId] = useState("")
  const [professionalUserId, setProfessionalUserId] = useState(defaultProfessionalUserId ?? "")
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      createFormResponse({
        templateId,
        patientId,
        encounterId: encounterId ?? null,
        professionalUserId: professionalUserId || null,
        answers: {},
      }),
    onSuccess: async (result) => {
      setTemplateId("")
      await onCreated(result.data.id)
    },
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title="Nuevo formulario"
      description="Solo se ofrece la versión vigente de cada plantilla. La captura se guarda sola mientras la completas."
      onSubmit={(event) => {
        event.preventDefault()
        if (!templateId) {
          setError("Elige el formulario")
          return
        }
        setError(null)
        create.mutate()
      }}
      isSubmitting={create.isPending}
      error={error}
      submitLabel="Empezar"
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-template`}>Formulario</FieldLabel>
          <Select
            items={Object.fromEntries(templates.map((t) => [t.id, t.title]))}
            value={templateId}
            onValueChange={(v) => setTemplateId(v ?? "")}
          >
            <SelectTrigger id={`${ids}-template`} aria-required="true">
              <SelectValue placeholder="Elige el formulario" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-pro`}>Profesional responsable</FieldLabel>
          <Select
            items={Object.fromEntries([
              ["", "Sin asignar"],
              ...members.map((m) => [m.userId, m.user.name]),
            ])}
            value={professionalUserId}
            onValueChange={(v) => setProfessionalUserId(v ?? "")}
          >
            <SelectTrigger id={`${ids}-pro`}>
              <SelectValue placeholder="Sin asignar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Sin asignar</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </FormDrawer>
  )
}

type SaveState = "guardado" | "pendiente" | "guardando" | "error"

export function ResponseDetail({
  response,
  canWrite,
  onChanged,
}: {
  response: FormResponse
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const queryClient = useQueryClient()
  const memberName = useMemberName()
  const schema = response.templateSnapshot
  const editable = response.status === "borrador" && canWrite
  const [answers, setAnswers] = useState<Record<string, unknown>>({ ...response.answers })
  const [saveState, setSaveState] = useState<SaveState>("guardado")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discardReason, setDiscardReason] = useState("")
  const [addendum, setAddendum] = useState("")
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const documentsQuery = useQuery({
    queryKey: ["patient-documents", response.patientId, "activos"],
    queryFn: () =>
      apiFetch<{ data: PatientDocument[] }>(`/api/patients/${response.patientId}/documents`),
    enabled: editable && schema.sections.some((s) => s.fields.some((f) => f.type === "adjunto")),
  })
  const attachments: AttachmentOption[] = (documentsQuery.data?.data ?? []).map((d) => ({
    id: d.id,
    label: `${d.label} · ${imageTypeLabel(d.imageType) ?? d.category}`,
  }))

  const save = async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    if (!dirty.current) return true
    setSaveState("guardando")
    try {
      await updateFormResponse(response.id, { answers: answersForServer(schema, answers) })
      dirty.current = false
      setSaveState("guardado")
      setSaveError(null)
      return true
    } catch (e) {
      setSaveState("error")
      setSaveError(errorMessage(e))
      return false
    }
  }
  // Guardado automático 1,2 s después del último cambio.
  useEffect(() => {
    if (!dirty.current || !editable) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), 1200)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: guarda al cambiar respuestas
  }, [answers])
  // Al cambiar de formulario o salir, se guarda lo pendiente.
  useEffect(
    () => () => {
      if (dirty.current)
        void updateFormResponse(response.id, {
          answers: answersForServer(schema, answersRef.current),
        })
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: solo al desmontar
    [],
  )
  const answersRef = useRef(answers)
  answersRef.current = answers

  const finalize = useMutation({
    mutationFn: () => finalizeFormResponse(response.id),
    onSuccess: async () => {
      setFinalizeOpen(false)
      toast.success("Formulario finalizado")
      await onChanged()
    },
    onError: (e) => {
      setFinalizeOpen(false)
      setSaveError(errorMessage(e))
    },
  })
  const discard = useMutation({
    mutationFn: () => discardFormResponse(response.id, discardReason.trim()),
    onSuccess: async () => {
      setDiscardOpen(false)
      toast.success("Borrador descartado")
      await onChanged()
    },
    onError: (e) => setSaveError(errorMessage(e)),
  })
  const addendaQuery = useQuery({
    queryKey: ["form-addenda", response.id],
    queryFn: () => fetchFormAddenda(response.id),
    enabled: response.status === "finalizado",
  })
  const addAddendum = useMutation({
    mutationFn: () => addFormAddendum(response.id, addendum.trim()),
    onSuccess: async () => {
      setAddendum("")
      await queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Adenda registrada")
    },
    onError: (e) => setSaveError(errorMessage(e)),
  })
  const status = statusOf(response)

  return (
    <article aria-labelledby={`${ids}-title`} className="flex flex-col gap-4 rounded-md border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={`${ids}-title`} className="text-base font-semibold">
            {response.templateTitle ?? "Formulario"} · versión {response.templateVersion}
          </h3>
          <p className="text-xs text-muted-foreground">
            {response.source === "portal"
              ? `Respondido por el paciente desde el portal${response.submittedAt ? ` el ${when(response.submittedAt)}` : " (en curso)"}`
              : response.professionalUserId
                ? memberName(response.professionalUserId)
                : "Sin profesional asignado"}
            {response.finalizedAt ? ` · finalizado ${when(response.finalizedAt)}` : ""}
          </p>
        </div>
        <span className="flex items-center gap-2">
          <Badge variant={status.tone}>{status.label}</Badge>
          {editable ? (
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {saveState === "guardando"
                ? "Guardando…"
                : saveState === "pendiente"
                  ? "Cambios sin guardar"
                  : saveState === "error"
                    ? "No se guardó"
                    : "Guardado"}
            </span>
          ) : null}
        </span>
      </header>
      {response.source === "portal" && response.status === "borrador" && response.submittedAt ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          Respuestas declaradas por el paciente. Revísalas con él en la consulta y finaliza para
          incorporarlas a la historia.
        </p>
      ) : null}
      {response.status === "descartado" ? (
        <p className="rounded-md bg-muted p-3 text-sm">
          Descartado {when(response.discardedAt)} · {response.discardReason}
        </p>
      ) : null}
      {schema.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">{section.title}</h4>
          {section.fields
            .filter((field) => isFieldVisible(field, answers))
            .map((field) => (
              <AnswerInput
                key={field.id}
                field={field}
                value={answers[field.id]}
                disabled={!editable}
                attachments={attachments}
                onChange={(value) => {
                  dirty.current = true
                  setSaveState("pendiente")
                  setAnswers((prev) => ({ ...prev, [field.id]: value }))
                }}
              />
            ))}
        </section>
      ))}
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDiscardReason("")
              setDiscardOpen(true)
            }}
          >
            Descartar borrador…
          </Button>
          <Button
            type="button"
            onClick={async () => {
              const pending = missingRequired(schema, answers)
              setMissing(pending.map((f) => f.label))
              if (pending.length > 0) {
                setSaveError(
                  `Completa antes de finalizar: ${pending.map((f) => f.label).join(", ")}`,
                )
                return
              }
              if (await save()) setFinalizeOpen(true)
            }}
          >
            Finalizar…
          </Button>
        </div>
      ) : null}
      {response.status === "finalizado" ? (
        <section aria-label="Adendas" className="flex flex-col gap-2 border-t pt-3">
          <h4 className="text-sm font-semibold">Adendas</h4>
          {(addendaQuery.data?.data ?? []).length === 0 && !addendaQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Sin adendas.</p>
          ) : null}
          {(addendaQuery.data?.data ?? []).map((item) => (
            <div key={item.id} className="rounded-md border p-2 text-sm">
              <p className="text-xs text-muted-foreground">
                {item.createdBy ? memberName(item.createdBy) : "—"} ·{" "}
                {new Date(item.createdAt).toLocaleString(activeOrgLocale(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
              <p className="whitespace-pre-wrap">{item.text}</p>
            </div>
          ))}
          {canWrite ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-addendum`}>Nueva adenda</FieldLabel>
              <Textarea
                id={`${ids}-addendum`}
                value={addendum}
                onChange={(event) => setAddendum(event.target.value)}
                rows={2}
                maxLength={5000}
                placeholder="Corrección o alcance posterior; no modifica lo finalizado"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={!addendum.trim() || addAddendum.isPending}
                onClick={() => addAddendum.mutate()}
              >
                Agregar adenda
              </Button>
            </Field>
          ) : null}
        </section>
      ) : null}
      <ConfirmDialog
        open={finalizeOpen}
        variant="default"
        title="Finalizar formulario"
        description="Quedará inmutable en la historia clínica. Las correcciones posteriores se hacen con adendas."
        confirmLabel="Finalizar"
        pending={finalize.isPending}
        confirmDisabled={missing.length > 0}
        onClose={() => setFinalizeOpen(false)}
        onConfirm={() => finalize.mutate()}
      />
      <ConfirmDialog
        open={discardOpen}
        title="Descartar borrador"
        description="No cuenta como registro clínico y ya no se podrá editar. Queda la traza con el motivo."
        confirmLabel="Descartar"
        pending={discard.isPending}
        confirmDisabled={!discardReason.trim()}
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => discard.mutate()}
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-discard`}>Motivo</FieldLabel>
          <Textarea
            id={`${ids}-discard`}
            aria-required="true"
            value={discardReason}
            maxLength={2000}
            onChange={(event) => setDiscardReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </article>
  )
}
