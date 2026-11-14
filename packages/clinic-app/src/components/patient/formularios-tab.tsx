import { canAttend } from "@odentia/auth/permissions"
import { Badge, Button, toast } from "@odentia/ui"
import {
  addSubmitErrors,
  applySubmitError,
  ConfirmDialog,
  clearSubmitErrors,
  focusFirstInvalid,
  FormDrawer,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useDraftSaved,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useStore } from "@tanstack/react-form"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import {
  addFormAddendum,
  createFormResponse,
  discardFormResponse,
  FORM_RESPONSE_STATUS_LABELS,
  type FormResponse,
  type FormSchemaDef,
  type FormTemplate,
  fetchFormAddenda,
  finalizeFormResponse,
  updateFormResponse,
} from "../../lib/clinical-forms"
import { useMemberName, useOrgMembers } from "../../lib/crm"
import { DeclaredResponse } from "./declared-response"
import type { PatientDocument } from "../../lib/patients"
import { imageTypeLabel } from "./document-labels"
import {
  AnswerAppField,
  type AttachmentOption,
  answersForServer,
  isFieldVisible,
  missingRequired,
} from "./form-fields"
import { activeOrgLocale } from "../../lib/locale"

const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium" }) : "—"

function statusOf(response: FormResponse): {
  label: string
  tone: "default" | "secondary" | "outline"
} {
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
  templateId: z.string().min(1, "Elige el formulario."),
  professionalUserId: z.string(),
})

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
  // Solo quien puede atender responde por un formulario; quien llevó la atención y ya no atiende no se propone.
  const responsibles = useOrgMembers().filter((member) => canAttend(member.role))
  const create = useMutation({
    mutationFn: (value: z.infer<typeof newResponseSchema>) =>
      createFormResponse({
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
      const result = await create.mutateAsync(value)
      form.reset()
      await onCreated(result.data.id)
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        form.reset()
        onClose()
      }}
      title="Nuevo formulario"
      description="Solo se ofrece la versión vigente de cada plantilla. La captura se guarda sola mientras la completas."
      submitLabel="Empezar"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="templateId">
          {(field) => (
            <field.SelectField
              label="Formulario"
              placeholder="Elige el formulario"
              options={templates.map((t) => ({ value: t.id, label: t.title }))}
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

/** `parcial`: se guardó todo menos las respuestas que no valen, que siguen marcadas en su pregunta. */
type SaveState = "guardado" | "pendiente" | "guardando" | "error" | "parcial"

/**
 * Lo que no se guardó, para cuando la pantalla ya no está para decirlo en su pregunta. Cada
 * motivo ya dice qué quedó guardado en su lugar (lo arma el servidor).
 */
function rejectedWords(rejected: Record<string, string>): string {
  return `${Object.values(rejected).join(" ")} Lo demás quedó guardado.`
}

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

/**
 * El detalle de una respuesta. Lo que respondió el paciente se lee y se corrige
 * aparte (`DeclaredResponse`): nunca se edita; lo del equipo se llena aquí.
 */
export function ResponseDetail({
  response,
  canWrite,
  sex,
  encounterId,
  onChanged,
}: {
  response: FormResponse
  canWrite: boolean
  /** El sexo registrado del paciente, para decir quién lo dijo. */
  sex?: string | null
  /** La atención en curso desde la que se abre: lo que se revise ahí queda ligado a ella. */
  encounterId?: string
  onChanged: () => Promise<void>
}) {
  if (response.source === "portal")
    return (
      <DeclaredResponse response={response} canWrite={canWrite} sex={sex} encounterId={encounterId} onChanged={onChanged} />
    )
  return <StaffResponseDetail response={response} canWrite={canWrite} onChanged={onChanged} />
}

function StaffResponseDetail({
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
  // Lo que el último guardado no aceptó (`answers.<id>` → por qué): sigue en pantalla, sin guardar.
  const rejected = useRef<Record<string, string>>({})
  // En la columna lateral, el aviso de «salir sin guardar» sigue a lo guardado de verdad.
  const draftSaved = useDraftSaved()
  useEffect(() => draftSaved(!editable || saveState === "guardado"), [draftSaved, editable, saveState])

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
      const unsaved = await persist()
      // Una respuesta que no vale no se finaliza a medias: se corrige antes, en su pregunta.
      if (Object.keys(unsaved).length > 0) throw new ApiError(400, { fields: unsaved })
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

  /**
   * Guarda lo pendiente; si el servidor lo rechaza, lanza su error. Devuelve las respuestas que
   * no valen (un «15» en una escala de 0 a 10): esas no se guardaron y las demás sí.
   */
  const persist = async (): Promise<Record<string, string>> => {
    clearTimeout(timer.current ?? undefined)
    // Si hay uno en curso se espera: el siguiente sale con la base al día.
    while (inFlight.current) await inFlight.current.catch(() => {})
    const target = version.current
    if (target === saved.current) return rejected.current
    setSaveState("guardando")
    const run = (async () => {
      try {
        const updated = await updateFormResponse(response.id, {
          answers: answersForServer(schema, form.state.values.answers),
          // De qué respuestas guardadas partió: si otra pestaña guardó otras, se avisa en vez de pisarlas.
          baseAnswers: savedAnswers.current,
        })
        const { rejected: unsaved = {}, ...row } = updated.data
        rejected.current = unsaved
        savedAnswers.current = row.answers ?? {}
        remember(row)
        saved.current = target
        saveFailed.current = false
        setSaveState(version.current !== target ? "pendiente" : Object.keys(unsaved).length > 0 ? "parcial" : "guardado")
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
    return rejected.current
  }
  // Guardado automático 1,2 s después del último cambio: lo que el servidor
  // rechaza se dice en su pregunta (`answers.<id>`) o junto a los botones.
  const autosave = () => {
    const failedBefore = saveFailed.current
    persist()
      .then((unsaved) => {
        // Lo que no vale se marca en su pregunta, sin borrar las marcas de lo que falta responder;
        // cada aviso se va solo al corregir su pregunta.
        if (Object.keys(unsaved).length > 0) addSubmitErrors(form, unsaved)
        else if (failedBefore) clearSubmitErrors(form)
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
      const title = response.templateTitle ?? "el formulario"
      // Primero termina el guardado en curso; después, si aún falta algo, sale con la base que dejó.
      void (async () => {
        while (inFlight.current) await inFlight.current.catch(() => {})
        // Lo que no valía se queda sin guardar: se dice al salir, ya sin su pregunta a la vista.
        const warn = (unsaved: Record<string, string>) => {
          if (Object.keys(unsaved).length > 0)
            toast.warning(`«${title}»: ${rejectedWords(unsaved)}`, { description: "Vuelve a abrirlo para corregirlas." })
        }
        if (version.current === saved.current) return warn(rejected.current)
        try {
          const updated = await updateFormResponse(response.id, {
            answers: answersForServer(schema, form.state.values.answers),
            baseAnswers: savedAnswers.current,
          })
          const { rejected: unsaved = {}, ...row } = updated.data
          remember(row)
          warn(unsaved)
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
        toast.success("Formulario finalizado")
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
      draftSaved(true)
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
            {response.templateTitle ?? "Formulario"} · versión {response.templateVersion}
          </h3>
          <p className="text-xs text-muted-foreground">
            {response.professionalUserId ? memberName(response.professionalUserId) : "Sin profesional asignado"}
            {response.finalizedAt
              ? ` · lo finalizó ${response.finalizedBy ? `${memberName(response.finalizedBy)} el ` : "el "}${when(response.finalizedAt)}`
              : ""}
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
                    : saveState === "parcial"
                      ? "Guardado, menos lo marcado"
                      : "Guardado"}
            </span>
          ) : null}
        </span>
      </header>
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
              <form.AppField key={field.id} name={`answers.${field.id}`}>
                {() => <AnswerAppField field={field} disabled={!editable} attachments={attachments} />}
              </form.AppField>
            ))}
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
        title="Finalizar formulario"
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
        {/* El motivo acompaña a «Descartar»: escribirlo no es un cambio del formulario que se pierda al salir. */}
        <div data-draft-ignore>
          <discardForm.AppField name="reason">
            {(field) => <field.TextareaField label="Motivo" aria-required="true" maxLength={2000} />}
          </discardForm.AppField>
        </div>
      </ConfirmDialog>
    </article>
  )
}
