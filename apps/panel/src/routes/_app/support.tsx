import { Button } from "@odentia/ui"
import {
  type ApiErrorShape,
  EmptyState,
  ErrorState,
  ExpandableText,
  LoadingState,
  PageHeader,
  PageShell,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { accountOrganizationsQuery } from "../../lib/account-organizations"
import { API_URL } from "../../lib/auth-client"

export const Route = createFileRoute("/_app/support")({
  // `?caso=<id>`: el enlace del aviso por correo abre ese caso.
  validateSearch: (search: Record<string, unknown>): { caso?: string } =>
    typeof search.caso === "string" && search.caso ? { caso: search.caso } : {},
  component: AccountSupportPage,
})

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
type AccountCase = z.infer<typeof accountCase>

const accountGrant = z.object({
  id: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  active: z.boolean(),
})
type AccountGrant = z.infer<typeof accountGrant>

const accountCaseDetail = accountCase.extend({
  messages: z.array(
    z.object({ id: z.string(), authorKind: z.enum(["cliente", "staff", "sistema"]), body: z.string(), createdAt: z.string() }),
  ),
  attachments: z.array(
    z.object({ id: z.string(), mimeType: z.string(), filename: z.string(), size: z.number() }),
  ),
  grants: z.array(accountGrant),
})
type AccountCaseDetail = z.infer<typeof accountCaseDetail>

const casesEnvelope = z.object({ data: z.array(accountCase) })
const detailEnvelope = z.object({ data: accountCaseDetail })

// Los mismos límites que `accessInput`, `messageInput` y `grantInput` de la API.
const caseSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Cuenta qué pasa con al menos 3 caracteres.")
    .max(500, "Escribe como mucho 500 caracteres."),
  detail: z.string().max(500, "Escribe como mucho 500 caracteres."),
})
const replySchema = z.object({
  body: z.string().trim().min(1, "Escribe tu respuesta.").max(4000, "Escribe como mucho 4000 caracteres."),
})
const DURATIONS = [
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "60", label: "1 hora" },
]
const grantSchema = z.object({ minutes: z.enum(["15", "30", "60"], { error: "Elige cuánto dura el acceso." }) })
/** Igual que `SUPPORT_ATTACHMENT_MAX_BYTES` de la API. */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const attachmentSchema = z.object({
  file: z
    .instanceof(File, { error: "Elige un archivo." })
    .refine((file) => file.size <= ATTACHMENT_MAX_BYTES, "El archivo no puede superar 10 MB"),
})
const ATTACHMENT_NOTICE_ID = "cuenta-adjunto-aviso"

/**
 * Consentimiento de acceso diagnóstico con la organización ya acotada por
 * narrowing en el llamador: aquí `organizationId` es siempre un string.
 */
function AccountGrantBox({
  caseId,
  organizationId,
  organizationName,
  grants,
}: {
  caseId: string
  organizationId: string
  organizationName: string | null
  grants: AccountGrant[]
}) {
  const queryClient = useQueryClient()
  const organizations = useQuery(accountOrganizationsQuery)
  const role = organizations.data?.find((item) => item.organizationId === organizationId)?.role
  const activeGrant = grants.find((item) => item.active) ?? null

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["account-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["account-support-case", caseId] })
  }

  const grant = useMutation({
    mutationFn: (minutes: number) =>
      apiFetch(`/api/account/support/cases/${caseId}/grants`, {
        method: "POST",
        body: JSON.stringify({ organizationId, minutes }),
      }),
    onSuccess: invalidate,
  })
  const grantForm = useAppForm({
    defaultValues: { minutes: "30" },
    validators: { onSubmit: grantSchema },
    onSubmit: async ({ value }) => {
      await grant.mutateAsync(Number(value.minutes))
    },
  })
  const onGrant = useFormSubmit(grantForm)
  const grantError = useFormSubmitError(grantForm)
  const granting = useStore(grantForm.store, (state) => state.isSubmitting)
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      apiFetch(`/api/account/support/cases/${caseId}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId }),
      }),
    onSuccess: invalidate,
  })
  if (role !== "owner" && role !== "admin") return <p className="text-sm text-muted-foreground">Solo quien administra la clínica puede autorizar acceso diagnóstico a soporte.</p>

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
      <p className="font-bold">Acceso diagnóstico de soporte</p>
      {activeGrant ? (
        <>
          <p>
            Soporte puede ver el diagnóstico de {organizationName ?? "tu clínica"} hasta el{" "}
            {new Date(activeGrant.expiresAt).toLocaleString()}.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 self-start sm:min-h-9"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(activeGrant.id)}
          >
            Revocar ahora
          </Button>
          {revoke.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(revoke.error)}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Solo quien es propietario o administra la clínica puede autorizarlo, máximo 1 hora.
          </p>
          <form noValidate onSubmit={onGrant} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <grantForm.AppField name="minutes">
                {(field) => <field.SelectField id="cuenta-minutos" label="Duración" options={DURATIONS} className="w-44" />}
              </grantForm.AppField>
              <Button type="submit" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={granting}>
                Autorizar acceso
              </Button>
            </div>
            {grantError ? (
              <p role="alert" className="text-sm text-destructive">
                {grantError}
              </p>
            ) : null}
          </form>
        </>
      )}
    </div>
  )
}

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
  const reopen = useMutation({
    mutationFn: () => apiFetch(`/api/account/support/cases/${caseId}/reopen`, { method: "POST" }),
    onSuccess: onChanged,
  })

  const sendReply = useMutation({
    mutationFn: (body: string) =>
      apiFetch(`/api/account/support/cases/${caseId}/messages`, {
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
      // Sin `apiFetch`: el cuerpo es multipart. El rechazo se lee igual (tamaño, tipo, caso resuelto).
      const response = await fetch(`${API_URL}/api/account/support/cases/${caseId}/attachments`, {
        method: "POST",
        credentials: "include",
        body,
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: ApiErrorShape } | null
        throw new ApiError(response.status, payload?.error ?? {})
      }
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
        <replyForm.AppField name="body" listeners={{ onChange: ({ value }) => drafts.set(caseId, value) }}>
          {(field) => <field.TextareaField id="cuenta-respuesta" label="Tu respuesta" rows={2} maxLength={4000} />}
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
                      [control.describedBy, attachError ? ATTACHMENT_NOTICE_ID : null].filter(Boolean).join(" ") ||
                      undefined
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

function AccountSupportPage() {
  const queryClient = useQueryClient()
  const linkedCase = Route.useSearch().caso ?? null
  const [selectedId, setSelectedId] = useState<string | null>(linkedCase)
  /** Borradores de respuesta por caso: sobreviven a volver a la lista y abrir otro caso. */
  const [replyDrafts] = useState(() => new Map<string, string>())

  const cases = useQuery({
    queryKey: ["account-support-cases"],
    queryFn: () => apiFetch("/api/account/support/cases").then((body: unknown) => casesEnvelope.parse(body).data),
  })
  const detail = useQuery({
    queryKey: ["account-support-case", selectedId],
    queryFn: () =>
      apiFetch(`/api/account/support/cases/${selectedId}`).then((body: unknown) => detailEnvelope.parse(body).data),
    enabled: selectedId !== null,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["account-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["account-support-case"] })
  }

  const create = useMutation({
    mutationFn: (body: { question: string; detail?: string }) =>
      apiFetch("/api/account/support/cases", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })
  const createForm = useAppForm({
    defaultValues: { question: "", detail: "" },
    validators: { onSubmit: caseSchema },
    onSubmit: async ({ value, formApi }) => {
      const detailText = value.detail.trim()
      await create.mutateAsync({ question: value.question.trim(), detail: detailText === "" ? undefined : detailText })
      formApi.reset()
    },
  })
  const onCreate = useFormSubmit(createForm)
  const createError = useFormSubmitError(createForm)
  const creating = useStore(createForm.store, (state) => state.isSubmitting)
  const markSeen = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/account/support/cases/${id}/seen`, { method: "POST" }),
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
      <PageHeader
        title="Soporte"
        subtitle="Problemas para entrar a tu cuenta y seguimiento de tus casos."
      />

      {selectedId === null ? (
        <>
          <section aria-label="Pedir ayuda para entrar" className="flex flex-col gap-2 rounded-xl border px-3 py-3">
            <h2 className="text-sm font-bold">¿No puedes entrar a una clínica?</h2>
            <p className="text-sm text-muted-foreground">
              Cuéntalo aquí aunque no tengas organización abierta. Solo te pedimos lo necesario para ayudarte.
            </p>
            <form noValidate onSubmit={onCreate} className="flex flex-col gap-2">
              <createForm.AppField name="question">
                {(field) => (
                  <field.TextareaField
                    id="cuenta-pregunta"
                    label="Qué pasa"
                    rows={3}
                    maxLength={500}
                    placeholder="Describe tu problema para entrar…"
                  />
                )}
              </createForm.AppField>
              <createForm.AppField name="detail">
                {(field) => (
                  <field.TextField
                    id="cuenta-detalle"
                    label="Detalle (opcional)"
                    maxLength={500}
                    placeholder="Código de error, correo, clínica…"
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
              <LoadingState message="Cargando tus casos…" />
            ) : cases.isError ? (
              <ErrorState message="No pude cargar tus casos." onRetry={() => void cases.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState title="Sin casos" description="Aún no pediste ayuda desde tu cuenta." />
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5">
                    <span className="flex w-full flex-wrap items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                        {STATUS_LABEL[item.status]}
                      </span>
                      <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{item.organizationName ?? "Acceso a la cuenta"}</span>
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
          <Button type="button" variant="link" className="h-auto self-start p-0 text-sm" onClick={() => setSelectedId(null)}>
            ← Todos los casos
          </Button>
          {detail.isPending ? (
            <LoadingState message="Cargando la conversación…" />
          ) : (
            <ErrorState message="No pude cargar este caso." onRetry={() => void detail.refetch()} />
          )}
        </section>
      ) : (
        <section aria-label="Ficha del caso" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => setSelectedId(null)}>
              ← Todos los casos
            </Button>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{STATUS_LABEL[kase.status]}</span>
          </div>
          {detail.isPending ? (
            <LoadingState message="Cargando la conversación…" />
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
                        href={`${API_URL}/api/account/support/cases/${kase.id}/attachments/${attachment.id}`}
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

              {kase.organizationId ? (
                <AccountGrantBox
                  caseId={kase.id}
                  organizationId={kase.organizationId}
                  organizationName={kase.organizationName}
                  grants={kase.grants}
                />
              ) : null}
            </>
          )}
        </section>
      )}
    </PageShell>
  )
}
