import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@odentia/ui"
import {
  LoadingState,
  SubmitButton,
  submitForm,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { AlertTriangle, ChevronDown, Info } from "lucide-react"
import { useId, useRef } from "react"
import { ApiError } from "../../lib/api"
import { formatDate, formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  type EncounterVoidBlock,
  type EncounterVoidBudget,
  fetchEncounterVoidPreview,
  voidEncounterApi,
} from "../../lib/encounters"

/** «Resina · 16 y Limpieza»: lo de esta atención, como lo nombra el presupuesto. */
function joinNames(names: readonly string[]): string {
  // Entre comillas: un nombre como «3/4 de corona» no se lee como una parte de lo cobrado.
  const quoted = names.map((name) => `«${name}»`)
  if (quoted.length <= 1) return quoted[0] ?? ""
  return `${quoted.slice(0, -1).join(", ")} y ${quoted[quoted.length - 1]}`
}

/** Lo que puede hacer quien no puede anular: firmar la atención contando lo que pasó. */
const SIGN_INSTEAD = "Si esta atención no va, fírmala dejando en la evolución lo que pasó."

/** Lo que ya respondió, para decirlo junto al presupuesto entregado. */
function answeredWords(budget: EncounterVoidBudget): string {
  const when = budget.decidedAt ? ` el ${formatDate(budget.decidedAt)}` : ""
  switch (budget.status) {
    case "aceptado":
      return ` y lo aceptó${when}`
    case "parcial":
      return ` y aceptó una parte${when}`
    case "pospuesto":
      return ` y lo está pensando`
    default:
      return ""
  }
}

/** Qué pasa con un presupuesto que se anula o pierde lo de esta atención, en una línea. */
function budgetLine(budget: EncounterVoidBudget): string {
  const which = `el presupuesto N.º ${budget.budgetNumber}`
  if (budget.effect === "quita") {
    return `Del presupuesto N.º ${budget.budgetNumber}, que no se le entregó, se quita ${joinNames(budget.treatments)}; lo demás sigue en él.`
  }
  if (!budget.delivered) return `También se anula ${which}, que no se le entregó.`
  const others =
    budget.others > 0
      ? ` Lleva además ${budget.others === 1 ? "otro tratamiento, que vuelve" : `otros ${budget.others} tratamientos, que vuelven`} al plan para presupuestarlo de nuevo.`
      : ""
  // Lo tiene en la mano (o en su enlace): verá «Anulado» y conviene decírselo.
  return `Ya se le entregó ${which}${answeredWords(budget)}: se anula también y, si lo consulta, verá «Anulado»; avísale.${others}`
}

/** Por qué no se puede anular todavía y, si existe, el lugar donde se resuelve. */
function blockWords(budget: EncounterVoidBudget, block: EncounterVoidBlock): string {
  const which = `el presupuesto N.º ${budget.budgetNumber}`
  switch (block.kind) {
    case "cobro":
      return `Caja ya cobró ${block.treatments.length > 0 ? joinNames(block.treatments) : "un tratamiento"} del presupuesto N.º ${budget.budgetNumber}. Primero hay que anular ese cobro.`
    case "hecho":
      return `${joinNames(block.treatments)}, del presupuesto N.º ${budget.budgetNumber}, ya se hizo en otra atención, así que ese presupuesto no se anula. ${SIGN_INSTEAD}`
    case "firma":
      return `${block.signerName ?? "Quien decide"} firmó el ${formatDate(block.signedAt)} que acepta ${which}: una aceptación firmada no se anula. ${SIGN_INSTEAD}`
    case "otros":
      return `${which.charAt(0).toUpperCase()}${which.slice(1)} ya tiene respuesta y lleva ${block.others === 1 ? "otro tratamiento" : `otros ${block.others} tratamientos`}: haz una revisión sin lo de esta atención.`
    case "ajeno":
      return `${which.charAt(0).toUpperCase()}${which.slice(1)} lleva tratamientos de otros profesionales: pídele a quien lo preparó que lo anule.`
    case "revision":
      return `${which.charAt(0).toUpperCase()}${which.slice(1)} tiene una revisión por enviar: envíala o anúlala primero.`
  }
}

export interface EncounterVoidDialogProps {
  open: boolean
  patientId: string
  encounterId: string
  onClose: () => void
  /** Antes de anular (detener el autoguardado). */
  onBeforeVoid?: () => void
  onVoided: () => Promise<void>
}

/**
 * «¿Anular esta atención?»: lo esencial arriba (queda anulada con el motivo y,
 * si hay, qué pasa con su presupuesto), lo demás plegado. Lo dice el servidor
 * (`void-preview`) con la misma regla que aplica al anular: si algo cambió
 * mientras tanto, el rechazo vuelve a leerlo y el motivo escrito se conserva.
 */
export function EncounterVoidDialog({
  open,
  patientId,
  encounterId,
  onClose,
  onBeforeVoid,
  onVoided,
}: EncounterVoidDialogProps) {
  const uid = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const canSeeAccount = usePermission("finance.read")
  const preview = useQuery({
    queryKey: ["encounter-void-preview", patientId, encounterId],
    queryFn: () => fetchEncounterVoidPreview(patientId, encounterId).then((res) => res.data),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  })
  const data = preview.data
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: {
      onSubmit: ({ value }) =>
        value.reason.trim() ? undefined : { fields: { reason: "Escribe por qué se anula" } },
    },
    onSubmit: async ({ value }) => {
      onBeforeVoid?.()
      try {
        await voidEncounterApi(patientId, encounterId, value.reason.trim(), data?.confirm ?? [])
      } catch (error) {
        // Alguien respondió, cobró o entregó mientras tanto: se vuelve a mostrar lo que hay.
        if (
          error instanceof ApiError &&
          ["VOID_BUDGETS_CHANGED", "VOID_BLOCKED"].includes(error.shape.code ?? "")
        ) {
          await preview.refetch()
        }
        throw error
      }
      await onVoided()
    },
  })
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const error = useFormSubmitError(form)
  const close = () => {
    if (pending) return
    form.reset()
    onClose()
  }
  const go = (search: { tab: string; budgetId?: string }) => {
    close()
    void navigate({ to: "/patients/$patientId", params: { patientId }, search })
  }
  const blocked = data?.blocked ?? false
  const withDelivered = (data?.confirm.length ?? 0) > 0
  const confirmLabel = withDelivered ? "Anular atención y presupuesto" : "Anular atención"
  const notices = (data?.budgets ?? []).filter((budget) => budget.effect !== "frena")
  const stops = (data?.budgets ?? []).filter((budget) => budget.effect === "frena")
  const appointments = (data?.budgets ?? []).flatMap((budget) => budget.appointments)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>¿Anular esta atención?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "Todavía no se puede: hay algo que no se deshace desde aquí."
              : "Queda como anulada con tu nombre y el motivo; lo indicado en ella se anula también."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div ref={bodyRef} className="flex min-w-0 flex-col gap-3">
          {preview.isPending ? (
            <LoadingState message="Revisando lo que se anula…" />
          ) : preview.isError ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <p role="alert" className="text-destructive">
                No se pudo revisar lo que se anula.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void preview.refetch()}
              >
                Reintentar
              </Button>
            </div>
          ) : (
            <>
              {stops.flatMap((budget) =>
                budget.blocks.map((block) => (
                  <Alert key={`${budget.id}-${block.kind}`} variant="destructive">
                    <AlertTriangle aria-hidden />
                    <AlertDescription className="flex flex-col items-start gap-2 text-foreground">
                      <span>{blockWords(budget, block)}</span>
                      {block.kind === "cobro" && !canSeeAccount ? (
                        <span className="text-muted-foreground">
                          Pídeselo a caja y vuelve a anular la atención.
                        </span>
                      ) : null}
                      {block.kind === "cobro" && canSeeAccount ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => go({ tab: "cuenta" })}
                        >
                          Ir a la cuenta
                        </Button>
                      ) : null}
                      {block.kind === "otros" || block.kind === "revision" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => go({ tab: "plan", budgetId: budget.id })}
                        >
                          Abrir el presupuesto N.º {budget.budgetNumber}
                        </Button>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                )),
              )}
              {!blocked && notices.length > 0 ? (
                <ul className="flex flex-col gap-2 text-sm">
                  {notices.map((budget) => (
                    <li key={budget.id}>
                      {budget.delivered ? (
                        <Alert>
                          <Info aria-hidden />
                          <AlertDescription className="text-foreground">
                            {budgetLine(budget)}
                          </AlertDescription>
                        </Alert>
                      ) : (
                        budgetLine(budget)
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {!blocked && appointments.length > 0 ? (
                <p className="text-sm">
                  {appointments.length === 1
                    ? `La cita del ${formatDateTime(appointments[0]!.startsAt)} traía este tratamiento: sigue en la agenda; avisa a recepción si ya no viene.`
                    : `Sus citas del ${joinNames(appointments.map((a) => formatDateTime(a.startsAt)))} traían estos tratamientos: siguen en la agenda; avisa a recepción si ya no vienen.`}
                </p>
              ) : null}
              {!blocked ? (
                <Collapsible className="text-sm">
                  <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-1 font-medium text-muted-foreground hover:text-foreground sm:min-h-8">
                    <ChevronDown
                      className="size-4 transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                      aria-hidden
                    />
                    Qué más se anula
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                      <li>Sus diagnósticos, procedimientos y lo registrado en ella.</li>
                      <li>
                        Recetas, descansos, órdenes sin resultado, controles y consentimientos sin
                        firmar.
                      </li>
                      <li>Lo que se dio por hecho aquí vuelve a quedar pendiente, sin cargos.</li>
                      <li>
                        Un papel que ya entregaste dirá «Anulado» al comprobarlo; lo que la persona
                        firmó no cambia.
                      </li>
                      <li>La cita, si la hay, puede volver a atenderse.</li>
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
              {!blocked ? (
                <form.AppField name="reason">
                  {(field) => (
                    <field.TextareaField
                      label="Motivo"
                      id={`${uid}-void`}
                      rows={2}
                      maxLength={2000}
                      placeholder="Ej.: se abrió para el paciente equivocado"
                    />
                  )}
                </form.AppField>
              ) : null}
            </>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {blocked ? "Cerrar" : "Cancelar"}
          </AlertDialogCancel>
          {!blocked ? (
            <SubmitButton
              variant="destructive"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90"
              pending={pending}
              disabled={!data || preview.isFetching || preview.isError}
              onClick={() => void submitForm(form, { root: bodyRef.current })}
            >
              {confirmLabel}
            </SubmitButton>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
