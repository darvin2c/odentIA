import { Button } from "@odentia/ui"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { EmptyState } from "../empty-state.js"
import { ErrorState } from "../error-state.js"
import { ExpandableText } from "../expandable-text.js"
import { useAppForm, useFormSubmit, useFormSubmitError } from "../form/app-form.js"
import { submitErrorMessage } from "../form/submit-error.js"
import { SkeletonRegion } from "../loading-state.js"
import { PageHeader } from "../page-header.js"
import { PageShell } from "../page-shell.js"
import { useAccount, useAccountFetch } from "./context.js"
import { AccountCaseSkeleton, AccountCasesSkeleton } from "./skeletons.js"

const supportStatus = z.enum(["abierto", "en_atencion", "esperando_clinica", "resuelto"])
type SupportStatus = z.infer<typeof supportStatus>

const STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

const accountCase = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  kind: z.enum(["pregunta", "problema", "acceso", "cobro"]),
  question: z.string(),
  status: supportStatus,
  updatedAt: z.string(),
})

const accountGrant = z.object({
  id: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  active: z.boolean(),
})
export type AccountGrant = z.infer<typeof accountGrant>

const accountCaseDetail = accountCase.extend({
  messages: z.array(
    z.object({
      id: z.string(),
      authorKind: z.enum(["cliente", "staff", "sistema"]),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  attachments: z.array(
    z.object({ id: z.string(), mimeType: z.string(), filename: z.string(), size: z.number() }),
  ),
  grants: z.array(accountGrant),
})
export type AccountCaseDetail = z.infer<typeof accountCaseDetail>

const casesEnvelope = z.object({ data: z.array(accountCase) })
const detailEnvelope = z.object({ data: accountCaseDetail })

// Los mismos límites que `accessInput` y `messageInput` de la API.
const caseSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Cuenta qué pasa con al menos 3 caracteres.")
    .max(500, "Escribe como mucho 500 caracteres."),
  detail: z.string().max(500, "Escribe como mucho 500 caracteres."),
})
const replySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Escribe tu respuesta.")
    .max(4000, "Escribe como mucho 4000 caracteres."),
})
/** Igual que `SUPPORT_ATTACHMENT_MAX_BYTES` de la API. */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const attachmentSchema = z.object({
  file: z
    .instanceof(File, { error: "Elige un archivo." })
    .refine((file) => file.size <= ATTACHMENT_MAX_BYTES, "El archivo no puede superar 10 MB"),
})
const ATTACHMENT_NOTICE_ID = "cuenta-adjunto-aviso"

/**
 * Lo que se hace con un caso abierto: responder y adjuntar; o reabrirlo si
 * está resuelto. Va con `key` del caso: cada caso conserva su borrador de
 * respuesta (`drafts`) y sus avisos no pasan a otro caso.
 */
function CaseComposer({
  kase,
  drafts,
  onChanged,
}: {
  kase: AccountCaseDetail
  drafts: Map<string, string>
  onChanged: () => void
}) {
  const caseId = kase.id
  const request = useAccountFetch()
  const reopen = useMutation({
    mutationFn: () => request(`/api/account/support/cases/${caseId}/reopen`, { method: "POST" }),
    onSuccess: onChanged,
  })

  const sendReply = useMutation({
    mutationFn: (body: string) =>
      request(`/api/account/support/cases/${caseId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    onSuccess: onChanged,
  })
  const replyForm = useAppForm({
    defaultValues: { body: drafts.get(caseId) ?? "" },
    validators: { onSubmit: replySchema },
    onSubmit: async ({ value, formApi }) => {
      await sendReply.mutateAsync(value.body.trim())
      drafts.delete(caseId)
      formApi.reset({ body: "" })
    },
  })
  const onReply = useFormSubmit(replyForm)
  const replyError = useFormSubmitError(replyForm)
  const replying = useStore(replyForm.store, (state) => state.isSubmitting)

  const fileRef = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append("file", file)
      // Multipart: el rechazo se lee igual (tamaño, tipo, caso resuelto).
      await request(`/api/account/support/cases/${caseId}/attachments`, { method: "POST", body })
    },
    onSuccess: onChanged,
  })
  const attachForm = useAppForm({
    defaultValues: { file: null as File | null },
    validators: { onSubmit: attachmentSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!value.file) return
      await upload.mutateAsync(value.file)
      formApi.reset()
    },
  })
  const onAttach = useFormSubmit(attachForm)
  const attachError = useFormSubmitError(attachForm)
  const uploading = useStore(attachForm.store, (state) => state.isSubmitting)

  if (kase.status === "resuelto") {
    return (
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start sm:min-h-9"
          disabled={reopen.isPending}
          onClick={() => reopen.mutate()}
        >
          Reabrir el caso
        </Button>
        {reopen.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(reopen.error)}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <form noValidate onSubmit={onReply} className="flex flex-col gap-2">
        <replyForm.AppField
          name="body"
          listeners={{ onChange: ({ value }) => drafts.set(caseId, value) }}
        >
          {(field) => (
            <field.TextareaField
              id="cuenta-respuesta"
              label="Tu respuesta"
              rows={2}
              maxLength={4000}
            />
          )}
        </replyForm.AppField>
        <Button type="submit" className="min-h-11 self-start sm:min-h-9" disabled={replying}>
          Enviar
        </Button>
        {replyError ? (
          <p role="alert" className="text-sm text-destructive">
            {replyError}
          </p>
        ) : null}
      </form>
      <form noValidate onSubmit={onAttach} className="flex flex-col gap-1.5">
        <attachForm.AppField name="file">
          {(field) => (
            <field.Control id="cuenta-adjunto" label="Adjuntar archivo al caso" hideLabel>
              {(control) => (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    id={control.id}
                    name={control.name}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(event) => {
                      const input = event.currentTarget
                      const file = input.files?.[0]
                      input.value = ""
                      if (!file) return
                      // Elegir el archivo es enviarlo: se valida y sube sin otro botón.
                      field.handleChange(file)
                      input.form?.requestSubmit()
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={uploading}
                    aria-busy={uploading}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={
                      [control.describedBy, attachError ? ATTACHMENT_NOTICE_ID : null]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? "Subiendo…" : "Adjuntar (JPG, PNG, WebP o PDF, máx. 10 MB)"}
                  </Button>
                </div>
              )}
            </field.Control>
          )}
        </attachForm.AppField>
        {attachError ? (
          <p id={ATTACHMENT_NOTICE_ID} role="alert" className="text-sm text-destructive">
            {attachError}
          </p>
        ) : null}
      </form>
    </>
  )
}

/** Lo que dice el formulario de pedir ayuda en cada app. */
export interface AccountSupportIntro {
  title: string
  description: string
  questionPlaceholder: string
  detailPlaceholder: string
}

export interface AccountSupportPageProps {
  /** El caso que abre el enlace del aviso por correo (`?caso=`). */
  linkedCase?: string | null
  intro: AccountSupportIntro
  /** Lo que va sobre el título (volver a la clínica o a la tienda). */
  back?: ReactNode
  /** Lo propio de cada app bajo la conversación (autorizar a soporte a mirar una clínica). */
  caseExtra?: (kase: AccountCaseDetail) => ReactNode
}

/** Soporte de la cuenta, el mismo en todas las apps: pedir ayuda, tus casos y su conversación. */
export function AccountSupportPage({
  linkedCase = null,
  intro,
  back,
  caseExtra,
}: AccountSupportPageProps) {
  const { apiUrl } = useAccount()
  const request = useAccountFetch()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(linkedCase)
  /** Borradores de respuesta por caso: sobreviven a volver a la lista y abrir otro caso. */
  const [replyDrafts] = useState(() => new Map<string, string>())

  const cases = useQuery({
    queryKey: ["account-support-cases"],
    queryFn: () =>
      request("/api/account/support/cases").then((body: unknown) => casesEnvelope.parse(body).data),
  })
  const detail = useQuery({
    queryKey: ["account-support-case", selectedId],
    queryFn: () =>
      request(`/api/account/support/cases/${selectedId}`).then(
        (body: unknown) => detailEnvelope.parse(body).data,
      ),
    enabled: selectedId !== null,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["account-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["account-support-case"] })
  }

  const create = useMutation({
    mutationFn: (body: { question: string; detail?: string }) =>
      request("/api/account/support/cases", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })
  const createForm = useAppForm({
    defaultValues: { question: "", detail: "" },
    validators: { onSubmit: caseSchema },
    onSubmit: async ({ value, formApi }) => {
      const detailText = value.detail.trim()
      await create.mutateAsync({
        question: value.question.trim(),
        detail: detailText === "" ? undefined : detailText,
      })
      formApi.reset()
    },
  })
  const onCreate = useFormSubmit(createForm)
  const createError = useFormSubmitError(createForm)
  const creating = useStore(createForm.store, (state) => state.isSubmitting)
  const markSeen = useMutation({
    mutationFn: (id: string) =>
      request(`/api/account/support/cases/${id}/seen`, { method: "POST" }),
    onSuccess: invalidate,
  })

  function openCase(id: string) {
    markedRef.current = null
    setSelectedId(id)
  }

  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedId !== null && detail.data !== undefined && markedRef.current !== selectedId) {
      markedRef.current = selectedId
      markSeen.mutate(selectedId)
    }
  }, [selectedId, detail.data, markSeen])

  const items = cases.data ?? []
  const kase = detail.data ?? null

  return (
    <PageShell className="flex flex-col gap-4">
      {back}
      <PageHeader
        title="Soporte"
        subtitle="Problemas para entrar a tu cuenta y seguimiento de tus casos."
      />

      {selectedId === null ? (
        <>
          <section
            aria-label="Pedir ayuda para entrar"
            className="flex flex-col gap-2 rounded-xl border px-3 py-3"
          >
            <h2 className="text-sm font-bold">{intro.title}</h2>
            <p className="text-sm text-muted-foreground">{intro.description}</p>
            <form noValidate onSubmit={onCreate} className="flex flex-col gap-2">
              <createForm.AppField name="question">
                {(field) => (
                  <field.TextareaField
                    id="cuenta-pregunta"
                    label="Qué pasa"
                    rows={3}
                    maxLength={500}
                    placeholder={intro.questionPlaceholder}
                  />
                )}
              </createForm.AppField>
              <createForm.AppField name="detail">
                {(field) => (
                  <field.TextField
                    id="cuenta-detalle"
                    label="Detalle (opcional)"
                    maxLength={500}
                    placeholder={intro.detailPlaceholder}
                  />
                )}
              </createForm.AppField>
              <Button type="submit" className="min-h-11 self-start sm:min-h-9" disabled={creating}>
                Enviar a soporte
              </Button>
              {createError ? (
                <p role="alert" className="text-sm text-destructive">
                  {createError}
                </p>
              ) : null}
            </form>
          </section>

          <section aria-label="Tus casos" className="flex flex-col gap-2">
            <h2 className="text-sm font-bold">Tus casos</h2>
            {cases.isPending ? (
              <SkeletonRegion message="Cargando tus casos…">
                <AccountCasesSkeleton />
              </SkeletonRegion>
            ) : cases.isError ? (
              <ErrorState
                message="No pude cargar tus casos."
                onRetry={() => void cases.refetch()}
              />
            ) : items.length === 0 ? (
              <EmptyState title="Sin casos" description="Aún no pediste ayuda desde tu cuenta." />
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5"
                  >
                    <span className="flex w-full flex-wrap items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                        {STATUS_LABEL[item.status]}
                      </span>
                      <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
                        {item.organizationName ?? "Acceso a la cuenta"}
                      </span>
                    </span>
                    <ExpandableText
                      text={`«${item.question}»`}
                      label="Consulta del caso"
                      className="min-w-0 text-sm [overflow-wrap:anywhere]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 self-start sm:min-h-9"
                      onClick={() => openCase(item.id)}
                      aria-label={`Abrir caso: ${item.question.slice(0, 80)}`}
                    >
                      Abrir caso
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : kase === null ? (
        <section aria-label="Ficha del caso" className="flex flex-col gap-3">
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0 text-sm"
            onClick={() => setSelectedId(null)}
          >
            ← Todos los casos
          </Button>
          {detail.isPending ? (
            <SkeletonRegion message="Cargando la conversación…" className="flex flex-col gap-3">
              <AccountCaseSkeleton />
            </SkeletonRegion>
          ) : (
            <ErrorState message="No pude cargar este caso." onRetry={() => void detail.refetch()} />
          )}
        </section>
      ) : (
        <section aria-label="Ficha del caso" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={() => setSelectedId(null)}
            >
              ← Todos los casos
            </Button>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
              {STATUS_LABEL[kase.status]}
            </span>
          </div>
          {detail.isPending ? (
            <SkeletonRegion message="Cargando la conversación…" className="flex flex-col gap-3">
              <AccountCaseSkeleton />
            </SkeletonRegion>
          ) : detail.isError ? (
            <ErrorState message="No pude cargar este caso." onRetry={() => void detail.refetch()} />
          ) : (
            <>
              <ExpandableText
                text={`«${kase.question}»`}
                label="Consulta inicial del caso"
                className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]"
              />
              <ol className="flex flex-col gap-2">
                {kase.messages.map((message) => (
                  <li
                    key={message.id}
                    className={
                      message.authorKind === "staff"
                        ? "max-w-[92%] self-start rounded-2xl rounded-bl-md border border-primary/20 bg-primary-soft px-3.5 py-2.5 text-sm"
                        : "max-w-[92%] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground"
                    }
                  >
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
                  </li>
                ))}
              </ol>

              {kase.attachments.length > 0 ? (
                <ul className="flex flex-col gap-1.5" aria-label="Adjuntos del caso">
                  {kase.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
                        href={`${apiUrl}/api/account/support/cases/${kase.id}/attachments/${attachment.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {attachment.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}

              <CaseComposer key={kase.id} kase={kase} drafts={replyDrafts} onChanged={invalidate} />

              {caseExtra?.(kase)}
            </>
          )}
        </section>
      )}
    </PageShell>
  )
}
