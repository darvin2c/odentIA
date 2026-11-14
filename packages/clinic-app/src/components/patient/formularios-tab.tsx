import { canAttend } from "@odentia/auth/permissions"
import { Badge, Button, toast } from "@odentia/ui"
import {
  applySubmitError,
  ConfirmDialog,
  clearSubmitErrors,
  DetailDrawer,
  focusFirstInvalid,
  FormDrawer,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useStore } from "@tanstack/react-form"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import {
  addFormAddendum,
  discardFormResponse,
  FORM_RESPONSE_STATUS_LABELS,
  type FormResponse,
  type FormSchemaDef,
  type FormTemplate,
  fetchFormAddenda,
  finalizedWords,
  finalizeFormResponse,
  startFormResponse,
  updateFormResponse,
} from "../../lib/clinical-forms"
import { useMemberName, useOrgMembers, usePermission } from "../../lib/crm"
import { appWords } from "../../lib/product-words"
import type { PatientDocument } from "../../lib/patients"
import { imageTypeLabel } from "./document-labels"
import {
  AnswerAppField,
  type AttachmentOption,
  answersForServer,
  isFieldVisible,
  missingRequired,
} from "./form-fields"
import { templateOptionLabel } from "../../lib/form-templates"
import { answerWords, draftOf, reusableAnswer } from "../../lib/consultation-forms"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium" }) : "—"

/** «13 nov 2026, 9:51 p. m.», en la hora de la clínica. */
const whenAt = (value: string) =>
  new Date(value).toLocaleString(activeOrgLocale(), { dateStyle: "medium", timeStyle: "short", timeZone: activeOrgTimeZone() })

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

const newResponseSchema = z.object({
  templateId: z.string().min(1, "Elige la ficha."),
  professionalUserId: z.string(),
})

export function NewResponseDrawer({
  open,
  onClose,
  templates,
  patientId,
  encounterId,
  defaultProfessionalUserId,
  loading = false,
  drafts = [],
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
  /** Mientras llegan las fichas en uso: sin ellas todavía no se dice que no hay ninguna. */
  loading?: boolean
  /** Las fichas a medias de esta atención: elegir una de ellas la abre, en vez de empezar otra igual. */
  drafts?: ReadonlyArray<Pick<FormResponse, "id" | "templateId" | "templateTitle" | "status" | "source">>
  onCreated: (id: string) => Promise<void>
}) {
  // Solo quien puede atender responde por un formulario; quien llevó la atención y ya no atiende no se propone.
  const responsibles = useOrgMembers().filter((member) => canAttend(member.role))
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (value: z.infer<typeof newResponseSchema>) =>
      // Si la atención ya no está en curso, se empieza igual sin unirlo a ella (`detached`).
      startFormResponse({
        templateId: value.templateId,
        patientId,
        encounterId: encounterId ?? null,
        professionalUserId: value.professionalUserId || null,
        answers: {},
      }),
  })
  const form = useAppForm({
    defaultValues: {
      templateId: "",
      professionalUserId: responsibles.some((member) => member.userId === defaultProfessionalUserId) ? (defaultProfessionalUserId ?? "") : "",
    },
    validators: { onSubmit: newResponseSchema },
    onSubmit: async ({ value }) => {
      // La que ya está a medias se abre: una ficha a medias se ve una sola vez.
      const chosen = templates.find((template) => template.id === value.templateId)
      const open = chosen ? draftOf(chosen, drafts) : null
      if (open) {
        form.reset()
        await onCreated(open)
        return
      }
      const result = await create.mutateAsync(value)
      form.reset()
      if (result.detached) {
        // La pantalla tenía un dato viejo (la atención se firmó o se anuló en otra pestaña): se
        // dice lo que pasó y se vuelve a pedir todo, para que deje de ofrecer esa atención.
        toast.info(
          "La atención ya no está en curso: la ficha de consulta se empezó suelta y quedó en Documentos, en la página del paciente.",
          { duration: 10_000 },
        )
        void queryClient.invalidateQueries()
      }
      await onCreated(result.data.id)
    },
  })
  const surface = useFormSurface(form)
  // Sin ninguna ficha en uso no se abre una lista vacía: se dice dónde se crean.
  if (open && !loading && templates.length === 0) return <NoFormsDrawer onClose={onClose} />
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        form.reset()
        onClose()
      }}
      title="Nueva ficha"
      description="Se ofrece la versión en uso de cada ficha. Se guarda sola mientras la llenas."
      submitLabel="Empezar"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="templateId">
          {(field) => (
            <field.SelectField
              label="Ficha"
              placeholder="Elige la ficha"
              // Dos formularios con el mismo título llevan lo que los distingue: preguntas y fecha.
              options={templates.map((t) => ({
                value: t.id,
                label: `${templateOptionLabel(t, templates, whenAt)}${draftOf(t, drafts) ? " · a medias: se abre la que empezaste" : ""}`,
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="professionalUserId">
          {(field) => (
            <field.SelectField
              label="Profesional responsable"
              options={[
                { value: "", label: "Sin asignar" },
                ...responsibles.map((m) => ({ value: m.userId, label: m.user.name })),
              ]}
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

/** «Nuevo › Ficha» sin ninguna en uso: dónde se crean, y el camino si se puede abrir Configuración. */
function NoFormsDrawer({ onClose }: { onClose: () => void }) {
  const canSettings = usePermission("settings.read")
  return (
    <DetailDrawer open title="Nueva ficha" description="Aún no tienes fichas en uso." onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Las fichas se crean y se ajustan en Configuración › Fichas de consulta. Ahí también están las que vienen con{" "}
          {appWords().name}, si las dejaste de usar.
        </p>
        {canSettings ? (
          <Link
            to="/settings/consultation-forms"
            className="w-fit font-medium text-primary underline-offset-4 hover:underline"
          >
            Ir a Fichas de consulta
          </Link>
        ) : (
          <p className="text-muted-foreground">Pídeselo a quien administra la clínica.</p>
        )}
      </div>
    </DetailDrawer>
  )
}

/** La pregunta de la anterior con la misma clave, si la tenía. */
function previousField(previous: FormResponse, id: string) {
  for (const section of previous.templateSnapshot.sections) {
    const field = section.fields.find((item) => item.id === id)
    if (field) return field
  }
  return null
}

type SaveState = "guardado" | "pendiente" | "guardando" | "error"

/**
 * Para finalizar, cada obligatoria visible tiene respuesta: lo que falta se
 * dice en su pregunta (la misma regla que el servidor al cerrar).
 */
function finalizeSchema(schema: FormSchemaDef) {
  return z.object({ answers: z.record(z.string(), z.unknown()) }).superRefine((value, ctx) => {
    for (const field of missingRequired(schema, value.answers)) {
      ctx.addIssue({
        code: "custom",
        path: ["answers", field.id],
        message: "Responde esta pregunta para finalizar.",
      })
    }
  })
}

const discardSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Indica el motivo del descarte.")
    .max(2000, "El motivo admite hasta 2000 caracteres."),
})

const addendumSchema = z.object({
  text: z.string().trim().min(1, "Escribe la adenda.").max(5000, "La adenda admite hasta 5000 caracteres."),
})

export function ResponseDetail({
  response,
  previous: latest = null,
  first = null,
  canWrite,
  onChanged,
}: {
  response: FormResponse
  /** La anterior del mismo tipo, ya finalizada: su respuesta va debajo de cada pregunta de la de hoy. */
  previous?: FormResponse | null
  /** La de inicio, si no es la anterior: «Comparar con: Anterior · Inicio». */
  first?: FormResponse | null
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const queryClient = useQueryClient()
  // Con qué se compara: la anterior, o la de inicio en un tratamiento largo.
  const [against, setAgainst] = useState<"anterior" | "inicio">("anterior")
  const previous = against === "inicio" && first ? first : latest
  const memberName = useMemberName()
  const schema = response.templateSnapshot
  const editable = response.status === "borrador" && canWrite
  const articleRef = useRef<HTMLElement | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("guardado")
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  // Cambios sin guardar: `version` cuenta cada cambio y `saved` el último guardado.
  const version = useRef(0)
  const saved = useRef(0)
  // Las respuestas como quedaron guardadas: viajan como base del próximo guardado.
  const savedAnswers = useRef<Record<string, unknown>>(response.answers ?? {})
  // Un solo guardado a la vez: el siguiente sale con la base que dejó el anterior.
  const inFlight = useRef<Promise<void> | null>(null)
  /** Lo guardado deja al día la lista: al reabrir el formulario se parte de lo último. */
  const remember = (updated: FormResponse) =>
    queryClient.setQueryData<{ data: FormResponse[] }>(["form-responses", response.patientId], (old) =>
      old ? { ...old, data: old.data.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)) } : old,
    )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Si el último guardado falló: el autoguardado corre con el estado de su render, que
  // ya dice «pendiente» por el cambio que lo disparó, así que el fallo se recuerda aquí.
  const saveFailed = useRef(false)

  const validators = useMemo(() => ({ onSubmit: finalizeSchema(schema) }), [schema])
  const form = useAppForm({
    defaultValues: { answers: { ...response.answers } as Record<string, unknown> },
    validators,
    listeners: {
      onChange: () => {
        version.current += 1
        setSaveState("pendiente")
      },
    },
    // «Finalizar…»: con todo respondido y guardado, se pide la confirmación.
    onSubmit: async () => {
      await persist()
      setFinalizeOpen(true)
    },
  })
  const answers = useStore(form.store, (state) => state.values.answers)
  const formError = useFormSubmitError(form)

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

  /** Guarda lo pendiente; si el servidor lo rechaza, lanza su error. */
  const persist = async (): Promise<void> => {
    clearTimeout(timer.current ?? undefined)
    // Si hay uno en curso se espera: el siguiente sale con la base al día.
    while (inFlight.current) await inFlight.current.catch(() => {})
    const target = version.current
    if (target === saved.current) return
    setSaveState("guardando")
    const run = (async () => {
      try {
        const updated = await updateFormResponse(response.id, {
          answers: answersForServer(schema, form.state.values.answers),
          // De qué respuestas guardadas partió: si otra pestaña guardó otras, se avisa en vez de pisarlas.
          baseAnswers: savedAnswers.current,
        })
        savedAnswers.current = updated.data.answers ?? {}
        remember(updated.data)
        saved.current = target
        saveFailed.current = false
        setSaveState(version.current === target ? "guardado" : "pendiente")
      } catch (error) {
        setSaveState("error")
        saveFailed.current = true
        throw error
      }
    })()
    inFlight.current = run
    try {
      await run
    } finally {
      if (inFlight.current === run) inFlight.current = null
    }
  }
  // Guardado automático 1,2 s después del último cambio: lo que el servidor
  // rechaza se dice en su pregunta (`answers.<id>`) o junto a los botones.
  const autosave = () => {
    const failedBefore = saveFailed.current
    persist()
      .then(() => {
        if (failedBefore) clearSubmitErrors(form)
      })
      .catch((error: unknown) => applySubmitError(form, error))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: guarda al cambiar respuestas; `autosave` se rehace en cada render.
  useEffect(() => {
    if (version.current === saved.current || !editable) return
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(autosave, 1200)
    return () => {
      clearTimeout(timer.current ?? undefined)
    }
  }, [answers])
  // Al cambiar de formulario o salir, se guarda lo pendiente; si falla, se avisa
  // (la pantalla ya no está para decirlo junto a la pregunta).
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al desmontar; lee el borrador vigente al salir.
  useEffect(
    () => () => {
      const title = response.templateTitle ?? "la ficha"
      // Primero termina el guardado en curso; después, si aún falta algo, sale con la base que dejó.
      void (async () => {
        while (inFlight.current) await inFlight.current.catch(() => {})
        if (version.current === saved.current) return
        try {
          const updated = await updateFormResponse(response.id, {
            answers: answersForServer(schema, form.state.values.answers),
            baseAnswers: savedAnswers.current,
          })
          remember(updated.data)
        } catch (error) {
          toast.error(`No se guardaron los últimos cambios de «${title}». ${submitErrorMessage(error)}`, {
            description: "Vuelve a abrirlo y revisa las respuestas.",
          })
        }
      })()
    },
    [],
  )

  const finalize = useMutation({ mutationFn: () => finalizeFormResponse(response.id) })
  const confirmFinalize = () => {
    finalize
      .mutateAsync()
      .then(async () => {
        setFinalizeOpen(false)
        toast.success("Ficha finalizada")
        await onChanged()
      })
      .catch((error: unknown) => {
        // Lo que falte o esté mal se dice en su pregunta, ya sin el diálogo delante.
        setFinalizeOpen(false)
        applySubmitError(form, error)
        focusFirstInvalid(articleRef.current)
      })
  }

  const discard = useMutation({
    mutationFn: (reason: string) => discardFormResponse(response.id, reason),
  })
  const discardForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: discardSchema },
    onSubmit: async ({ value }) => {
      await discard.mutateAsync(value.reason.trim())
      setDiscardOpen(false)
      toast.success("Borrador descartado")
      await onChanged()
    },
  })
  const discardError = useFormSubmitError(discardForm)
  const discarding = useStore(discardForm.store, (state) => state.isSubmitting)

  const addendaQuery = useQuery({
    queryKey: ["form-addenda", response.id],
    queryFn: () => fetchFormAddenda(response.id),
    enabled: response.status === "finalizado",
  })
  const addAddendum = useMutation({
    mutationFn: (text: string) => addFormAddendum(response.id, text),
  })
  const addendumRef = useRef<HTMLDivElement | null>(null)
  const addendumForm = useAppForm({
    defaultValues: { text: "" },
    validators: { onSubmit: addendumSchema },
    onSubmit: async ({ value }) => {
      await addAddendum.mutateAsync(value.text.trim())
      addendumForm.reset()
      await queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Adenda registrada")
    },
  })
  const addendumError = useFormSubmitError(addendumForm)
  const addingAddendum = useStore(addendumForm.store, (state) => state.isSubmitting)
  const status = statusOf(response)

  return (
    <article
      ref={articleRef}
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-md border p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={`${ids}-title`} className="text-base font-semibold">
            {response.templateTitle ?? "Ficha"} · versión {response.templateVersion}
          </h3>
          <p className="text-xs text-muted-foreground">
            {response.source === "portal"
              ? `Respondido por el paciente desde el portal${response.submittedAt ? ` el ${when(response.submittedAt)}` : " (en curso)"}`
              : response.professionalUserId
                ? memberName(response.professionalUserId)
                : "Sin profesional asignado"}
            {/* Con fecha y hora: lo terminado después de firmar la atención lleva la suya, y se ve. */}
            {response.finalizedAt ? ` · ${finalizedWords(response, whenAt)}` : ""}
            {response.encounterStatus === "anulada" ? " · de una atención anulada" : ""}
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
      {first && latest ? (
        <div role="group" aria-label="Comparar con" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Comparar con:</span>
          {(["anterior", "inicio"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={against === option ? "default" : "outline"}
              className="min-h-11 sm:min-h-8"
              aria-pressed={against === option}
              onClick={() => setAgainst(option)}
            >
              {option === "anterior" ? `Anterior · ${when(latest.finalizedAt)}` : `Inicio · ${when(first.finalizedAt)}`}
            </Button>
          ))}
        </div>
      ) : null}
      {previous ? (
        <p className="rounded-md bg-muted p-3 text-sm">
          Debajo de cada pregunta, {against === "inicio" && first ? "lo de la de inicio" : "lo de la anterior"}:{" "}
          {when(previous.finalizedAt)}
          {previous.professionalUserId ? ` · ${memberName(previous.professionalUserId)}` : " · sin profesional asignado"}.
        </p>
      ) : null}
      {schema.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">{section.title}</h4>
          {section.fields
            .filter((field) => isFieldVisible(field, answers))
            .map((field) => {
              // Por la clave de la pregunta: una versión nueva de la ficha conserva las que no cambió.
              const before = previous ? previousField(previous, field.id) : null
              return (
                <form.AppField key={field.id} name={`answers.${field.id}`}>
                  {(answerField) => {
                    const earlier = previous?.answers?.[field.id]
                    // «Usar»: copia la respuesta anterior a la de hoy con un clic (la pieza, la clase…); nada se copia solo.
                    const reusable = editable && before ? reusableAnswer(field, before, earlier) : undefined
                    const beforeId = `${ids}-antes-${field.id}`
                    return (
                      <div className="flex flex-col gap-1">
                        <AnswerAppField
                          field={field}
                          disabled={!editable}
                          attachments={attachments}
                          // La respuesta anterior se oye al llegar a la pregunta, no solo se ve.
                          describedBy={previous && before ? beforeId : undefined}
                        />
                        {previous && before ? (
                          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span id={beforeId}>
                              {when(previous.finalizedAt)}: {answerWords(before, earlier)}
                            </span>
                            {reusable !== undefined ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="link"
                                className="h-auto min-h-8 p-0 text-xs"
                                aria-label={`Usar la respuesta anterior en «${field.label}»: ${answerWords(before, earlier)}`}
                                onClick={() => answerField.handleChange(reusable)}
                              >
                                Usar
                              </Button>
                            ) : null}
                          </p>
                        ) : null}
                      </div>
                    )
                  }}
                </form.AppField>
              )
            })}
        </section>
      ))}
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              discardForm.reset()
              setDiscardOpen(true)
            }}
          >
            Descartar borrador…
          </Button>
          <Button type="button" onClick={() => void submitForm(form, { root: articleRef.current })}>
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
            <div ref={addendumRef} className="flex flex-col gap-2">
              <addendumForm.AppField name="text">
                {(field) => (
                  <field.TextareaField
                    label="Nueva adenda"
                    rows={2}
                    maxLength={5000}
                    placeholder="Corrección o alcance posterior; no modifica lo finalizado"
                  />
                )}
              </addendumForm.AppField>
              {addendumError ? (
                <p role="alert" className="text-sm text-destructive">
                  {addendumError}
                </p>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={addingAddendum}
                onClick={() => void submitForm(addendumForm, { root: addendumRef.current })}
              >
                Agregar adenda
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      <ConfirmDialog
        open={finalizeOpen}
        variant="default"
        title="Finalizar ficha"
        description="Quedará inmutable en la historia clínica. Las correcciones posteriores se hacen con adendas."
        confirmLabel="Finalizar"
        pending={finalize.isPending}
        onClose={() => setFinalizeOpen(false)}
        onConfirm={confirmFinalize}
      />
      <ConfirmDialog
        open={discardOpen}
        title="Descartar borrador"
        description="No cuenta como registro clínico y ya no se podrá editar. Queda la traza con el motivo."
        confirmLabel="Descartar"
        pending={discarding}
        error={discardError}
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => void submitForm(discardForm)}
      >
        <discardForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" aria-required="true" maxLength={2000} />}
        </discardForm.AppField>
      </ConfirmDialog>
    </article>
  )
}
