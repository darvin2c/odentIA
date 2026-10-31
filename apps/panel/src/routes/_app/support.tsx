import { Button, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, ErrorState, ExpandableText, PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { AccountCaseSkeleton, AccountCasesSkeleton, AccountSupportPageSkeleton } from "../../components/skeletons/support"
import { apiFetch } from "../../lib/api"
import { accountOrganizationsQuery } from "../../lib/account-organizations"
import { API_URL } from "../../lib/auth-client"

export const Route = createFileRoute("/_app/support")({
  // `?caso=<id>`: el enlace del aviso por correo abre ese caso.
  validateSearch: (search: Record<string, unknown>): { caso?: string } =>
    typeof search.caso === "string" && search.caso ? { caso: search.caso } : {},
  pendingComponent: AccountSupportPageSkeleton,
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
  const [minutes, setMinutes] = useState("30")
  const activeGrant = grants.find((item) => item.active) ?? null

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["account-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["account-support-case", caseId] })
  }

  const grant = useMutation({
    mutationFn: () => {
      const parsed = Number.parseInt(minutes, 10)
      const value = Number.isInteger(parsed) && parsed >= 5 && parsed <= 60 ? parsed : 30
      return apiFetch(`/api/account/support/cases/${caseId}/grants`, {
        method: "POST",
        body: JSON.stringify({ organizationId, minutes: value }),
      })
    },
    onSuccess: invalidate,
  })
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
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Solo quien es propietario o administra la clínica puede autorizarlo, máximo 1 hora.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel htmlFor="cuenta-minutos">Duración</FieldLabel>
            <Select
              value={minutes}
              items={{ 15: "15 minutos", 30: "30 minutos", 60: "1 hora" }}
              onValueChange={(value) => setMinutes(value ?? "30")}
            >
              <SelectTrigger id="cuenta-minutos" className="w-44">
                <SelectValue placeholder="30 minutos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutos</SelectItem>
                <SelectItem value="30">30 minutos</SelectItem>
                <SelectItem value="60">1 hora</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={grant.isPending}
              onClick={() => grant.mutate()}
            >
              Autorizar acceso
            </Button>
          </div>
        </>
      )}
      {grant.isError || revoke.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cambiar el permiso. Solo un propietario o administrador puede autorizarlo.
        </p>
      ) : null}
    </div>
  )
}

function AccountSupportPage() {
  const queryClient = useQueryClient()
  const linkedCase = Route.useSearch().caso ?? null
  const [selectedId, setSelectedId] = useState<string | null>(linkedCase)
  const [question, setQuestion] = useState("")
  const [detailText, setDetailText] = useState("")
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})

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
    mutationFn: () =>
      apiFetch("/api/account/support/cases", {
        method: "POST",
        body: JSON.stringify({ question: question.trim(), detail: detailText.trim() === "" ? undefined : detailText.trim() }),
      }),
    onSuccess: () => {
      setQuestion("")
      setDetailText("")
      invalidate()
    },
  })
  const sendReply = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      apiFetch(`/api/account/support/cases/${input.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: input.body }),
      }),
    onSuccess: (_data, input) => {
      setReplyDrafts((current) => ({ ...current, [input.id]: "" }))
      invalidate()
    },
  })
  const reopen = useMutation({
    mutationFn: () => apiFetch(`/api/account/support/cases/${selectedId}/reopen`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const markSeen = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/account/support/cases/${id}/seen`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append("file", file)
      const response = await fetch(`${API_URL}/api/account/support/cases/${selectedId}/attachments`, {
        method: "POST",
        credentials: "include",
        body: form,
      })
      if (!response.ok) throw new Error("No se pudo subir el archivo.")
    },
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
            <label className="flex flex-col gap-1 text-sm font-semibold" htmlFor="cuenta-pregunta">
              Qué pasa
              <textarea
                id="cuenta-pregunta"
                rows={3}
                maxLength={500}
                className="min-h-11 rounded-md border bg-card px-2 py-1.5 font-normal"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Describe tu problema para entrar…"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold" htmlFor="cuenta-detalle">
              Detalle (opcional)
              <input
                id="cuenta-detalle"
                maxLength={500}
                className="min-h-11 rounded-md border bg-card px-2 font-normal"
                value={detailText}
                onChange={(event) => setDetailText(event.target.value)}
                placeholder="Código de error, correo, clínica…"
              />
            </label>
            <Button
              type="button"
              className="min-h-11 self-start sm:min-h-9"
              disabled={question.trim().length < 3 || create.isPending}
              onClick={() => create.mutate()}
            >
              Enviar a soporte
            </Button>
            {create.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudo enviar. Vuelve a intentarlo.
              </p>
            ) : null}
          </section>

          <section aria-label="Tus casos" className="flex flex-col gap-2">
            <h2 className="text-sm font-bold">Tus casos</h2>
            {cases.isPending ? (
              <SkeletonRegion message="Cargando tus casos…">
                <AccountCasesSkeleton />
              </SkeletonRegion>
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
            <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => setSelectedId(null)}>
              ← Todos los casos
            </Button>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{STATUS_LABEL[kase.status]}</span>
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

              {kase.status === "resuelto" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start sm:min-h-9"
                  disabled={reopen.isPending}
                  onClick={() => reopen.mutate()}
                >
                  Reabrir el caso
                </Button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const body = (replyDrafts[kase.id] ?? "").trim()
                    if (body.length > 0 && !sendReply.isPending) sendReply.mutate({ id: kase.id, body })
                  }}
                  className="flex flex-col gap-2"
                >
                  <label className="flex flex-col gap-1 text-sm font-semibold" htmlFor="cuenta-respuesta">
                    Tu respuesta
                    <textarea
                      id="cuenta-respuesta"
                      rows={2}
                      maxLength={4000}
                      className="min-h-11 rounded-md border bg-card px-2 py-1.5 font-normal"
                      value={replyDrafts[kase.id] ?? ""}
                      onChange={(event) => {
                        const id = kase.id
                        setReplyDrafts((current) => ({ ...current, [id]: event.target.value }))
                      }}
                    />
                  </label>
                  <Button
                    type="submit"
                    className="min-h-11 self-start sm:min-h-9"
                    disabled={(replyDrafts[kase.id] ?? "").trim().length === 0 || sendReply.isPending}
                  >
                    Enviar
                  </Button>
                </form>
              )}
              {kase.status === "resuelto" ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    aria-label="Adjuntar archivo al caso"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) upload.mutate(file)
                      event.target.value = ""
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={upload.isPending}
                    aria-busy={upload.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    {upload.isPending ? "Subiendo…" : "Adjuntar (JPG, PNG, WebP o PDF, máx. 10 MB)"}
                  </Button>
                </div>
              )}
              {upload.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  No se pudo subir el archivo.
                </p>
              ) : null}

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
