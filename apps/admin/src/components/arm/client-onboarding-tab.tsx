/**
 * Ficha del cliente › Alta (ARM; ADR 0104, 0183 y 0185): de los archivos que
 * manda la clínica al informe que le llega. A la izquierda, los pasos: el
 * servidor los calcula de lo que ya pasó y guarda la primera vez de cada uno;
 * una persona solo marca «No aplica» (con su motivo) en los pasos que lo
 * admiten, y el servidor dice en cuáles puede quien lee. Al centro, el registro
 * de la carga (`OrgLoadRecord`): la carga y el informe los hace la skill en el
 * servidor, y aquí solo se ve lo que hizo, sin botones de cargar ni de enviar
 * (de un informe que no se sabe si salió, sus dos salidas). A la derecha, lo
 * que Kairós propone para este cliente: solo prepara, nunca abre los archivos,
 * carga ni envía.
 */
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  SkeletonRegion,
  submitErrorMessage,
} from "@odentia/ui-patterns"
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, Circle, MinusCircle } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { invitationDueWords } from "../../lib/invitation-words"
import { supportDay } from "../../lib/support-words"
import { OrgLoadRecord } from "../org-load-record"
import { ClientOnboardingSkeleton, ONBOARDING_GRID } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"
import { type ClientFileKind, ClientFileUploadDrawer } from "./client-files-tab"
import { invalidateClient } from "./client-model"
import { KairosItemCard, kairosItemsSchema } from "./kairos-items"
import { organizationAccountKey, useOrganizationAccount } from "./organization"

const stepSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(["hecho", "no_aplica", "falta"]).catch("falta"),
  doneAt: z.string().nullable(),
  detail: z.string(),
  waitingOn: z.string().nullable().optional(),
  notApplicable: z
    .object({ reason: z.string(), by: z.string().nullable(), at: z.string() })
    .optional(),
  canMarkNotApplicable: z.boolean().optional(),
  suggestedReason: z.string().optional(),
  lost: z.object({ at: z.string(), reason: z.string() }).optional(),
  // El código se lee como texto: uno nuevo del servidor no rompe la pestaña, solo no tiene botón.
  action: z.object({ code: z.string(), label: z.string(), adminOnly: z.boolean() }).optional(),
})
export type OnboardingStepRow = z.infer<typeof stepSchema>
type Step = OnboardingStepRow
export const onboardingSchema = z.object({
  clientId: z.string(),
  organizationId: z.string().nullable(),
  steps: z.array(stepSchema),
  done: z.number(),
  total: z.number(),
  notApplicable: z.number().optional(),
  next: z.string().nullable(),
})

/** Lo mismo que acepta el servidor para el motivo de «No aplica». */
export const NOT_APPLICABLE_MAX = 300

/** El motivo se puede confirmar: con algo escrito y sin pasar del tope. */
export function canConfirmNotApplicable(reason: string): boolean {
  const text = reason.trim()
  return text.length > 0 && text.length <= NOT_APPLICABLE_MAX
}

/** «No aplica: Trabaja sola · lo marcó Ada el 3 nov», o el detalle del servidor. */
export function stepDetailWords(step: Step): string {
  if (step.state !== "no_aplica" || !step.notApplicable) return step.detail
  const { reason, by, at } = step.notApplicable
  return `No aplica: ${reason} · lo marcó ${by ?? "alguien del equipo"} el ${supportDay(at)}`
}

/** Encabezado de los pasos: «Pasos del alta · 7 de 10 · 1 no aplica». */
export function onboardingHeading(data: {
  done: number
  total: number
  notApplicable?: number | undefined
}): string {
  const na = data.notApplicable ?? 0
  return `Pasos del alta · ${data.done} de ${data.total}${na > 0 ? ` · ${na} no aplica` : ""}`
}

/** Dónde vive el registro de la carga: «Revisar el informe» lleva el foco ahí. */
const RECORD_SECTION = "alta-registro"

/** Lleva el foco (y la vista) a una sección de la pestaña. */
function focusSection(id: string) {
  const target = document.getElementById(id)
  if (!target) return
  target.focus()
  target.scrollIntoView?.({ block: "start" })
}

export function ClientOnboardingTab({ clientId, organizationId, isAdmin }: ClientTabProps) {
  const queryClient = useQueryClient()
  const [upload, setUpload] = useState<ClientFileKind | null>(null)
  const [resending, setResending] = useState(false)
  // El paso que se está marcando «No aplica» y su motivo (empieza con el sugerido).
  const [marking, setMarking] = useState<Step | null>(null)
  const [reason, setReason] = useState("")
  const onboarding = useQuery({
    queryKey: ["admin", "client", clientId, "onboarding"],
    queryFn: async () =>
      onboardingSchema.parse(await api<unknown>(`/api/admin/clients/${clientId}/onboarding`)),
  })
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

  const onboardingKey = ["admin", "client", clientId, "onboarding"]
  const markNa = useMutation({
    mutationFn: async (input: { key: string; reason: string }) =>
      onboardingSchema.parse(
        await api<unknown>(
          `/api/admin/clients/${clientId}/onboarding/${input.key}/not-applicable`,
          {
            method: "POST",
            body: JSON.stringify({ reason: input.reason }),
          },
        ),
      ),
    onSuccess: (next, input) => {
      queryClient.setQueryData(onboardingKey, next)
      const label = next.steps.find((item) => item.key === input.key)?.label ?? "El paso"
      toast.success(`${label}: no aplica. Ya no cuenta entre los pasos.`)
      setMarking(null)
      refresh()
    },
  })
  const clearNa = useMutation({
    mutationFn: async (key: string) =>
      onboardingSchema.parse(
        await api<unknown>(`/api/admin/clients/${clientId}/onboarding/${key}/not-applicable`, {
          method: "DELETE",
        }),
      ),
    onSuccess: (next, key) => {
      queryClient.setQueryData(onboardingKey, next)
      const label = next.steps.find((item) => item.key === key)?.label ?? "El paso"
      toast.success(`${label}: vuelve a contar entre los pasos.`)
      refresh()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  function openNotApplicable(step: Step) {
    markNa.reset()
    setReason(step.suggestedReason ?? "")
    setMarking(step)
  }

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
      case "revisar_informe":
        focusSection(RECORD_SECTION)
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

  return (
    <div className="flex flex-col gap-4">
      <div className={ONBOARDING_GRID}>
        <section
          aria-labelledby="alta-pasos"
          className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 xl:self-start"
        >
          <h2 id="alta-pasos" className="text-base font-medium">
            {onboardingHeading(data)}
          </h2>
          <ol className="flex flex-col divide-y">
            {data.steps.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                isNext={step.key === data.next}
                onAction={runAction}
                actionDisabled={step.action?.code === "reenviar_invitacion" && !ownerInvitation}
                onNotApplicable={() => openNotApplicable(step)}
                onClearNotApplicable={() => clearNa.mutate(step.key)}
                clearing={clearNa.isPending && clearNa.variables === step.key}
              />
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Cada paso sale de un hecho y guarda la primera vez que pasó. Solo «No aplica» lo marca
            una persona.
          </p>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          {organizationId === null ? (
            <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              La carga se abre cuando la clínica tenga su cuenta: invítala o dale de alta desde
              Venta. Lo que mande antes (la carta, sus archivos) se guarda en Documentos.
            </section>
          ) : isAdmin ? (
            <div
              id={RECORD_SECTION}
              tabIndex={-1}
              className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <OrgLoadRecord organizationId={organizationId} />
            </div>
          ) : (
            <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              El registro de la carga y de los informes es de Administración. Aquí ves cómo va cada
              paso.
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
        open={marking !== null}
        title={marking ? `${marking.label}: no aplica` : "No aplica"}
        description="Deja de contar entre los pasos y como trabado. Si después pasa, el paso queda hecho solo."
        confirmLabel="Marcar «No aplica»"
        variant="default"
        pending={markNa.isPending}
        confirmDisabled={!canConfirmNotApplicable(reason)}
        error={markNa.isError ? submitErrorMessage(markNa.error) : null}
        onConfirm={() => {
          if (marking && canConfirmNotApplicable(reason))
            markNa.mutate({ key: marking.key, reason: reason.trim() })
        }}
        onClose={() => {
          markNa.reset()
          setMarking(null)
        }}
      >
        <Field data-invalid={!canConfirmNotApplicable(reason)}>
          <FieldLabel htmlFor="alta-no-aplica">Por qué no aplica</FieldLabel>
          <Textarea
            id="alta-no-aplica"
            value={reason}
            maxLength={NOT_APPLICABLE_MAX}
            rows={3}
            aria-invalid={!canConfirmNotApplicable(reason)}
            onChange={(event) => setReason(event.target.value)}
          />
          {reason.trim().length === 0 ? (
            <FieldError>Escribe por qué no aplica</FieldError>
          ) : (
            <FieldDescription>
              Puedes cambiar el motivo sugerido. Lo verá el equipo en el alta.
            </FieldDescription>
          )}
        </Field>
      </ConfirmDialog>
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
  onNotApplicable,
  onClearNotApplicable,
  clearing,
}: {
  step: Step
  isNext: boolean
  onAction: (code: string) => void
  actionDisabled: boolean
  onNotApplicable: () => void
  onClearNotApplicable: () => void
  clearing: boolean
}) {
  const done = step.state === "hecho"
  const notApplicable = step.state === "no_aplica"
  const showAction = !done && !notApplicable && step.action
  const showNa = !done && step.canMarkNotApplicable
  return (
    <li className="flex gap-2 py-2">
      {done ? (
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      ) : notApplicable ? (
        <MinusCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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
          <span className="sr-only">
            {done ? ": hecho" : notApplicable ? ": no aplica" : ": falta"}
          </span>
        </p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {done && step.doneAt ? `${supportDay(step.doneAt)} · ` : ""}
          {stepDetailWords(step)}
        </p>
        {showAction || showNa ? (
          <div className="flex flex-wrap gap-2">
            {showAction ? (
              <Button
                type="button"
                size="sm"
                variant={isNext ? "default" : "outline"}
                disabled={actionDisabled}
                onClick={() => onAction(step.action?.code ?? "")}
              >
                {step.action?.label}
              </Button>
            ) : null}
            {showNa && notApplicable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Quitar «No aplica» de “${step.label}”`}
                disabled={clearing}
                onClick={onClearNotApplicable}
              >
                Quitar «No aplica»
              </Button>
            ) : showNa ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Marcar “${step.label}” como no aplica`}
                onClick={onNotApplicable}
              >
                No aplica
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
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
        Lo que no hace: no abre los archivos, no carga y no envía nada sin tu sí. Avisa lo que hizo
        la skill y lo que falta.
      </p>
    </AgentSurface>
  )
}
