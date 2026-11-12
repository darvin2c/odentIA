/**
 * Ficha del cliente › Alta (ARM, tablero 6 del lienzo; ADR 0104 y 0183): de
 * los archivos que manda la clínica al informe que le llega. Arriba, lo que
 * dejó la skill de carga, con Aprobar y Devolver (Administración). A la
 * izquierda, los pasos: nadie los marca, el servidor los calcula de lo que ya
 * pasó. Al centro, las tres tarjetas de «Cargar datos» (#598) tal como son,
 * que además pueden tomar el plan o el informe aprobado que dejó la skill. A
 * la derecha, lo que Kairós propone para este cliente: solo prepara, nunca
 * abre los archivos, aprueba, carga ni envía.
 */
import { Badge, Button, toast } from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  SkeletonRegion,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, Circle } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { invitationDueWords } from "../../lib/invitation-words"
import { supportDay } from "../../lib/support-words"
import { OrgImport } from "../org-import"
import { OrgReport } from "../org-report"
import { OrgSetup } from "../org-setup"
import { ClientOnboardingSkeleton, ONBOARDING_GRID } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"
import { type ClientFileKind, ClientFileUploadDrawer, clientFileHref } from "./client-files-tab"
import { invalidateClient } from "./client-model"
import {
  approvedDraftOf,
  DRAFT_GONE_WORDS,
  DRAFT_KIND_WORDS,
  draftSourceOf,
  draftSummaryWords,
  type ImportDraft,
  useImportDrafts,
} from "./import-drafts"
import { KairosItemCard, kairosItemsSchema } from "./kairos-items"
import { organizationAccountKey, useOrganizationAccount } from "./organization"

const stepSchema = z.object({
  key: z.string(),
  label: z.string(),
  doneAt: z.string().nullable(),
  detail: z.string(),
  // El código se lee como texto: uno nuevo del servidor no rompe la pestaña, solo no tiene botón.
  action: z.object({ code: z.string(), label: z.string(), adminOnly: z.boolean() }).optional(),
})
type Step = z.infer<typeof stepSchema>
const onboardingSchema = z.object({
  clientId: z.string(),
  organizationId: z.string().nullable(),
  steps: z.array(stepSchema),
  done: z.number(),
  total: z.number(),
  next: z.string().nullable(),
})

/** Dónde vive cada tarjeta: las acciones de un paso llevan el foco ahí. */
const SECTION = {
  skill: "alta-skill",
  configuracion: "alta-configuracion",
  pacientes: "alta-pacientes",
  informe: "alta-informe",
} as const

const CARD_OF_DRAFT: Record<ImportDraft["kind"], string> = {
  plan_configuracion: SECTION.configuracion,
  plan_pacientes: SECTION.pacientes,
  informe: SECTION.informe,
}

const STATUS_WORDS: Record<
  ImportDraft["status"],
  { text: string; tone: "warning" | "success" | "outline" | "secondary" }
> = {
  lista: { text: "Espera tu sí", tone: "warning" },
  aprobada: { text: "Aprobado", tone: "success" },
  devuelta: { text: "Devuelto", tone: "outline" },
  usada: { text: "Ya se usó", tone: "secondary" },
}

/** Lleva el foco (y la vista) a una sección de la pestaña. */
function focusSection(id: string) {
  const target = document.getElementById(id)
  if (!target) return
  target.focus()
  target.scrollIntoView?.({ block: "start" })
}

export function ClientOnboardingTab({
  clientId,
  organizationId,
  organizationName,
  isAdmin,
}: ClientTabProps) {
  const queryClient = useQueryClient()
  const [upload, setUpload] = useState<ClientFileKind | null>(null)
  const [resending, setResending] = useState(false)
  const onboarding = useQuery({
    queryKey: ["admin", "client", clientId, "onboarding"],
    queryFn: async () =>
      onboardingSchema.parse(await api<unknown>(`/api/admin/clients/${clientId}/onboarding`)),
  })
  // Lo de la skill y la carga son de Administración: a Soporte ni se le pide (la API se lo niega).
  const drafts = useImportDrafts(clientId, isAdmin)
  const kairos = useQuery({
    queryKey: ["admin", "kairos", "items", "alta", clientId],
    queryFn: async () =>
      kairosItemsSchema.parse(
        await api<unknown>(
          `/api/admin/kairos/items?status=espera&clientId=${encodeURIComponent(clientId)}&limit=20`,
        ),
      ),
  })
  const account = useOrganizationAccount(organizationId)
  const refresh = () => {
    invalidateClient(queryClient, clientId)
    if (organizationId)
      void queryClient.invalidateQueries({ queryKey: organizationAccountKey(organizationId) })
  }

  // «Reenviar la invitación» manda el mismo enlace a la propietaria, que vuelve a valer 7 días.
  const ownerInvitation =
    account.data?.invitations.find((item) => item.role === "owner" && item.status === "pending") ??
    null
  const resend = useMutation({
    mutationFn: async (invitationId: string) =>
      z.object({ expiresAt: z.string() }).parse(
        await api<unknown>(`/api/admin/organizations/invitations/${invitationId}/resend`, {
          method: "POST",
        }),
      ),
    onSuccess: (resent) => {
      toast.success(
        `Reenviada a ${ownerInvitation?.email ?? "la propietaria"} · ${invitationDueWords(resent.expiresAt).text}`,
      )
      setResending(false)
      refresh()
    },
  })

  function runAction(code: string) {
    switch (code) {
      case "reenviar_invitacion":
        setResending(true)
        return
      case "subir_carta":
        setUpload("carta")
        return
      case "subir_archivos":
        setUpload("archivo_clinica")
        return
      case "revisar_plan":
        focusSection(SECTION.skill)
        return
      case "cargar_configuracion":
        focusSection(SECTION.configuracion)
        return
      case "cargar_pacientes":
        focusSection(SECTION.pacientes)
        return
      case "enviar_informe":
      case "revisar_informe":
        focusSection(SECTION.informe)
        return
    }
  }

  if (onboarding.isPending)
    return (
      <SkeletonRegion message="Cargando el alta…">
        <ClientOnboardingSkeleton hasAccount={organizationId !== null} />
      </SkeletonRegion>
    )
  if (onboarding.isError)
    return (
      <ErrorState
        title="No se pudo cargar el alta"
        message={submitErrorMessage(onboarding.error)}
        onRetry={() => void onboarding.refetch()}
      />
    )

  const data = onboarding.data
  const setupDraft = approvedDraftOf(drafts.data, "plan_configuracion")
  const patientsDraft = approvedDraftOf(drafts.data, "plan_pacientes")
  const reportDraft = approvedDraftOf(drafts.data, "informe")

  return (
    <div className="flex flex-col gap-4">
      {isAdmin ? <SkillDrafts clientId={clientId} drafts={drafts} onChanged={refresh} /> : null}
      <div className={ONBOARDING_GRID}>
        <section
          aria-labelledby="alta-pasos"
          className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 xl:self-start"
        >
          <h2 id="alta-pasos" className="text-base font-medium">
            Pasos del alta · {data.done} de {data.total}
          </h2>
          <ol className="flex flex-col divide-y">
            {data.steps.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                isNext={step.key === data.next}
                onAction={runAction}
                actionDisabled={step.action?.code === "reenviar_invitacion" && !ownerInvitation}
              />
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Cada paso sale de un hecho que ya se guarda. Nadie lo marca a mano.
          </p>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          {organizationId === null ? (
            <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              La carga se abre cuando la clínica tenga su cuenta: invítala o dale de alta desde
              Venta. Lo que mande antes (la carta, sus archivos) se guarda en Documentos.
            </section>
          ) : isAdmin ? (
            <>
              <div
                id={SECTION.configuracion}
                tabIndex={-1}
                className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <OrgSetup
                  organizationId={organizationId}
                  organizationName={organizationName}
                  draft={draftSourceOf(setupDraft, refresh)}
                />
              </div>
              <div
                id={SECTION.pacientes}
                tabIndex={-1}
                className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <OrgImport
                  organizationId={organizationId}
                  organizationName={organizationName}
                  draft={draftSourceOf(patientsDraft, refresh)}
                />
              </div>
              <div
                id={SECTION.informe}
                tabIndex={-1}
                className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <OrgReport
                  organizationId={organizationId}
                  draft={draftSourceOf(reportDraft, refresh)}
                />
              </div>
            </>
          ) : (
            <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              Aprobar el plan, cargar y enviar el informe es de Administración. Aquí ves cómo va
              cada paso.
            </section>
          )}
        </div>

        <KairosProposes items={kairos} isAdmin={isAdmin} />
      </div>

      {upload ? (
        <ClientFileUploadDrawer
          clientId={clientId}
          isAdmin={isAdmin}
          kind={upload}
          onClose={() => setUpload(null)}
        />
      ) : null}
      <ConfirmDialog
        open={resending}
        title="Reenviar la invitación"
        description={
          ownerInvitation
            ? `Le llega otra vez a ${ownerInvitation.email} con el mismo enlace, que vuelve a valer 7 días desde hoy.`
            : "No hay una invitación pendiente de la propietaria."
        }
        confirmLabel="Reenviar"
        variant="default"
        pending={resend.isPending}
        confirmDisabled={!ownerInvitation}
        error={resend.isError ? submitErrorMessage(resend.error) : null}
        onConfirm={() => {
          if (ownerInvitation) resend.mutate(ownerInvitation.id)
        }}
        onClose={() => {
          resend.reset()
          setResending(false)
        }}
      />
    </div>
  )
}

function StepRow({
  step,
  isNext,
  onAction,
  actionDisabled,
}: {
  step: Step
  isNext: boolean
  onAction: (code: string) => void
  actionDisabled: boolean
}) {
  const done = step.doneAt !== null
  return (
    <li className="flex gap-2 py-2">
      {done ? (
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm">
          <span
            className={
              done ? "font-medium" : isNext ? "font-semibold" : "font-medium text-muted-foreground"
            }
          >
            {step.label}
          </span>
          <span className="sr-only">{done ? ": hecho" : ": falta"}</span>
        </p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {done && step.doneAt ? `${supportDay(step.doneAt)} · ` : ""}
          {step.detail}
        </p>
        {!done && step.action ? (
          <Button
            type="button"
            size="sm"
            variant={isNext ? "default" : "outline"}
            className="self-start"
            disabled={actionDisabled}
            onClick={() => onAction(step.action?.code ?? "")}
          >
            {step.action.label}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/* ---------- La skill dejó ---------- */

function SkillDrafts({
  clientId,
  drafts,
  onChanged,
}: {
  clientId: string
  drafts: UseQueryResult<ImportDraft[]>
  onChanged: () => void
}) {
  const [returning, setReturning] = useState<ImportDraft | null>(null)
  const approve = useMutation({
    mutationFn: (draft: ImportDraft) =>
      api(`/api/admin/clients/import-drafts/${draft.id}/approve`, { method: "POST" }),
    onSuccess: (_, draft) => {
      toast.success(
        `${DRAFT_KIND_WORDS[draft.kind]} N.º ${draft.number} aprobado: ya se puede ensayar en su tarjeta`,
      )
      onChanged()
    },
    onError: (error) => {
      toast.error(submitErrorMessage(error))
      onChanged()
    },
  })
  // Lo ya usado no espera nada: queda en el historial y en Documentos.
  const shown = (drafts.data ?? []).filter((draft) => draft.status !== "usada")
  return (
    <section
      id={SECTION.skill}
      tabIndex={-1}
      aria-labelledby="alta-skill-title"
      className="flex scroll-mt-4 flex-col gap-3 rounded-xl border bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <h2 id="alta-skill-title" className="text-base font-medium">
        La skill dejó
      </h2>
      {drafts.isPending ? (
        <LoadingState message="Cargando lo que dejó la skill…" />
      ) : drafts.isError ? (
        <ErrorState
          title="No se pudo cargar lo que dejó la skill"
          message={submitErrorMessage(drafts.error)}
          onRetry={() => void drafts.refetch()}
        />
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nada por revisar. Cuando quien acompaña el alta termine el plan o el informe con la skill
          de carga, aparece aquí para que lo apruebes. La skill entra con su llave (Equipo › Llaves
          de la skill) y solo deja borradores.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {shown.map((draft) => {
            const status = STATUS_WORDS[draft.status]
            const summary = draftSummaryWords(draft.summary)
            const gone = Boolean(draft.payloadDeletedAt)
            return (
              <li key={draft.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {DRAFT_KIND_WORDS[draft.kind]} N.º {draft.number}
                    <Badge variant={status.tone}>{status.text}</Badge>
                  </p>
                  {summary ? <p className="text-sm">{summary}</p> : null}
                  <p className="text-xs text-muted-foreground">
                    {draft.viaSkill ? "Lo dejó la skill" : "Lo subió"} de {draft.uploadedBy.name} el{" "}
                    {supportDay(draft.createdAt)}
                    {draft.approvedBy && draft.approvedAt
                      ? ` · aprobado por ${draft.approvedBy.name} el ${supportDay(draft.approvedAt)}`
                      : ""}
                    {draft.pdfFileId ? (
                      <>
                        {" · "}
                        <a
                          href={clientFileHref(draft.pdfFileId)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-4"
                        >
                          Ver el PDF
                        </a>
                      </>
                    ) : null}
                  </p>
                  {draft.status === "devuelta" && draft.returnedNote ? (
                    <p className="text-sm [overflow-wrap:anywhere]">
                      <span className="text-muted-foreground">Se devolvió: </span>
                      {draft.returnedNote}. Espera el que lo corrige, con el mismo número.
                    </p>
                  ) : null}
                  {gone && draft.status !== "devuelta" ? (
                    <p className="text-sm text-muted-foreground">
                      {DRAFT_GONE_WORDS}: pide a la skill que deje otro con el mismo número.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {draft.status === "lista" && !gone ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(draft)}
                    >
                      Aprobar
                    </Button>
                  ) : null}
                  {draft.status === "aprobada" && !gone ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => focusSection(CARD_OF_DRAFT[draft.kind])}
                    >
                      {draft.kind === "informe" ? "Verlo y enviarlo" : "Ensayarlo y cargarlo"}
                    </Button>
                  ) : null}
                  {draft.status === "lista" || draft.status === "aprobada" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setReturning(draft)}
                    >
                      Devolver
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <ReturnDraftDialog
        clientId={clientId}
        draft={returning}
        onDone={() => {
          setReturning(null)
          onChanged()
        }}
        onClose={() => setReturning(null)}
      />
    </section>
  )
}

const returnSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, "Di qué hay que corregir")
    .max(1000, "La nota, 1000 caracteres como mucho"),
})

/** «Devolver con nota»: la skill lo lee y deja otro con el mismo número. No se borra nada. */
function ReturnDraftDialog({
  clientId,
  draft,
  onDone,
  onClose,
}: {
  clientId: string
  draft: ImportDraft | null
  onDone: () => void
  onClose: () => void
}) {
  const form = useAppForm({
    defaultValues: { note: "" },
    validators: { onSubmit: returnSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!draft) return
      await api(`/api/admin/clients/import-drafts/${draft.id}/return`, {
        method: "POST",
        body: JSON.stringify({ note: value.note.trim() }),
      })
      toast.success(`${DRAFT_KIND_WORDS[draft.kind]} N.º ${draft.number} devuelto a la skill`)
      formApi.reset()
      onDone()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  return (
    <ConfirmDialog
      open={draft !== null}
      title={
        draft
          ? `Devolver el ${DRAFT_KIND_WORDS[draft.kind].toLowerCase()} N.º ${draft.number}`
          : "Devolver"
      }
      description="Queda devuelto con tu nota y no se carga. Quien corre la skill lo corrige y deja otro con el mismo número."
      confirmLabel="Devolver"
      variant="default"
      pending={pending}
      error={error}
      onConfirm={() => void submitForm(form)}
      onClose={() => {
        form.reset()
        onClose()
      }}
    >
      <form.AppField name="note">
        {(field) => (
          <field.TextareaField
            id={`devolver-${clientId}`}
            label="Qué hay que corregir"
            placeholder="Por ejemplo: faltan los precios de ortodoncia"
            maxLength={1000}
          />
        )}
      </form.AppField>
    </ConfirmDialog>
  )
}

/* ---------- Kairós propone ---------- */

function KairosProposes({
  items,
  isAdmin,
}: {
  items: UseQueryResult<z.infer<typeof kairosItemsSchema>>
  isAdmin: boolean
}) {
  const now = new Date()
  return (
    <AgentSurface
      aria-labelledby="alta-kairos"
      className="flex min-w-0 flex-col gap-3 p-4 xl:self-start"
    >
      <h2 id="alta-kairos" className="flex items-center gap-2 text-base font-medium">
        <AgentMark size="sm" />
        Kairós propone
      </h2>
      {items.isPending ? (
        <LoadingState message="Cargando lo que propone Kairós…" />
      ) : items.isError ? (
        <ErrorState
          title="No se pudo cargar lo de Kairós"
          message={submitErrorMessage(items.error)}
          onRetry={() => void items.refetch()}
        />
      ) : items.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada espera tu sí para este cliente.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.data.items.map((item) => (
            <KairosItemCard key={item.id} item={item} isAdmin={isAdmin} now={now} />
          ))}
        </ul>
      )}
      {items.data && items.data.total > items.data.items.length ? (
        <Link to="/kairos" className="text-sm underline underline-offset-4">
          Ver todo en Kairós
        </Link>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Lo que no hace: no abre los archivos, no aprueba el plan ni el informe, no carga y no envía
        sin tu sí.
      </p>
    </AgentSurface>
  )
}
