/**
 * Lo que el Resumen suma en la fase 6 de Reportes (ADR 0071) y lo que fija
 * Argos (ADR 0070): la meta de dos cifras (tablero 6), las respuestas fijadas
 * (tablero 1, «Fijadas») y el resumen del lunes, que cada persona prende para
 * sí (tablero A4). Las cifras y el avance los calcula el servidor.
 */
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Badge, Button, Input, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  applySubmitError,
  clearSubmitErrors,
  FormDrawer,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId } from "react"
import { z } from "zod"
import { ADMIN_NAME } from "../../lib/agent-names"
import { monthLabel } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { useOrgLocale } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"
import { dayText, type ReportQuery } from "../../lib/reports"
import {
  DIGEST_KEY,
  fetchDigest,
  fetchPins,
  type GoalProgress,
  PINS_KEY,
  type ReportGoalMetric,
  type ReportGoals,
  setDigest,
  setGoal,
  unpinAnswer,
} from "../../lib/reports-ask"
import { ArgosShownView } from "../argos/argos-panel"
import { MoneyInput } from "../finance/collect-drawer"
import { AnswerChart } from "./ask-argos"
import { ReportCard } from "./report-parts"

function monthOf(key: string, locale: string): string {
  const [year, month] = key.split("-").map(Number) as [number, number]
  return monthLabel({ year, month }, locale).toLocaleLowerCase(locale)
}

/** El tope de pacientes nuevos que acepta `setReportGoal`. */
const MAX_GOAL_PATIENTS = 100_000

/** Lo escrito como meta: el importe (unidad menor o pacientes) o por qué no vale. */
function goalAmount(
  metric: ReportGoalMetric | null,
  text: string,
  currency: string,
  locale: string,
): { amount: number } | { error: string } {
  if (!text.trim()) return { error: metric === "cobrado" ? "Escribe cuánto quieres cobrar cada mes." : "Escribe cuántos pacientes nuevos quieres cada mes." }
  if (metric === "cobrado") {
    let cents: number
    try {
      cents = parseMoney(text, currency, locale)
    } catch (failure) {
      return { error: failure instanceof Error ? `${failure.message}.` : "Escribe un importe válido." }
    }
    return cents > 0 ? { amount: cents } : { error: "La meta tiene que ser mayor que cero." }
  }
  const count = Number.parseInt(text.trim(), 10)
  if (!Number.isSafeInteger(count) || count <= 0) return { error: "La meta tiene que ser mayor que cero." }
  if (count > MAX_GOAL_PATIENTS)
    return { error: `La meta es demasiado grande: como mucho ${new Intl.NumberFormat(locale).format(MAX_GOAL_PATIENTS)} pacientes.` }
  return { amount: count }
}

// --- Metas -------------------------------------------------------------------------------

/**
 * La meta de una cifra del Resumen (tablero 6): sin meta, «Poner meta» en el
 * mes que corre; con ella, la barra y lo que falta. En el mes que corre una
 * raya marca cuánto del mes ya pasó: si la barra va por delante, se va bien.
 */
export function GoalLine({
  metric,
  goals,
  currency,
  locale,
  onEdit,
}: {
  metric: ReportGoalMetric
  goals: ReportGoals | null
  currency: string
  locale: string
  onEdit: (metric: ReportGoalMetric) => void
}) {
  const canSet = usePermission("reports.write")
  if (!goals?.month) return null
  const progress: GoalProgress | null = metric === "cobrado" ? goals.cobrado : goals.pacientesNuevos
  const amount = (value: number) => (metric === "cobrado" ? formatMoney(value, progress?.currency ?? currency, locale) : new Intl.NumberFormat(locale).format(value))
  if (!progress) {
    return goals.editable && canSet ? (
      <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 text-[13px] font-bold sm:min-h-8" onClick={() => onEdit(metric)}>
        + Poner meta
      </Button>
    ) : null
  }
  const reached = progress.percent >= 100
  const width = Math.min(100, progress.percent)
  const text = goals.editable
    ? reached
      ? `Ya llegaste a tu meta de ${amount(progress.amount)}`
      : `${progress.percent} % de la meta con el ${goals.elapsedPercent ?? 0} % del mes · faltan ${amount(progress.remaining)}${goals.daysLeft ? ` en ${goals.daysLeft} ${goals.daysLeft === 1 ? "día" : "días"}` : ""}`
    : reached
      ? `Llegaste a tu meta de ${amount(progress.amount)} (${progress.percent} %)`
      : `${progress.percent} % de tu meta de ${amount(progress.amount)} · faltaron ${amount(progress.remaining)}`
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-1.5">
      <div aria-hidden className="relative h-2 rounded-full bg-primary-soft">
        <div className="h-2 rounded-full bg-primary" style={{ width: `${width}%` }} />
        {goals.editable && goals.elapsedPercent !== null ? (
          <span className="absolute -top-1 h-4 w-0.5 rounded bg-foreground" style={{ left: `${Math.min(100, goals.elapsedPercent)}%` }} />
        ) : null}
      </div>
      <span className="text-[13px] text-foreground/80">
        {text}
        {goals.editable && canSet ? (
          <>
            {" · "}
            <Button type="button" variant="link" className="h-auto p-0 text-[13px] font-semibold" onClick={() => onEdit(metric)}>
              Cambiar
            </Button>
          </>
        ) : null}
      </span>
    </div>
  )
}

/** «Meta de cobrado por mes» (tablero 6, paso 2): vale desde este mes; los pasados conservan la suya. */
export function GoalDrawer({
  metric,
  goals,
  currency,
  locale,
  onClose,
}: {
  metric: ReportGoalMetric | null
  goals: ReportGoals | null
  currency: string
  locale: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const current = metric === "cobrado" ? goals?.cobrado : metric === "pacientes_nuevos" ? goals?.pacientesNuevos : null
  const initial = current ? (metric === "cobrado" ? formatMoneyInput(current.amount, currency, locale) : String(current.amount)) : ""
  const save = useMutation({
    retry: false,
    mutationFn: (amount: number | null) => setGoal(metric as ReportGoalMetric, amount),
    onSuccess: (_data, amount) => {
      toast.success(amount === null ? "Meta quitada desde este mes" : "Meta guardada: vale desde este mes")
      void queryClient.invalidateQueries({ queryKey: ["report", "summary"] })
      onClose()
    },
  })
  const form = useAppForm({
    defaultValues: { amount: initial },
    validators: {
      // Los mismos topes que `setReportGoal`: entero, mayor que cero y hasta 100 000 pacientes.
      onSubmit: z.object({
        amount: z.string().superRefine((value, ctx) => {
          const parsed = goalAmount(metric, value, currency, locale)
          if ("error" in parsed) ctx.addIssue({ code: "custom", message: parsed.error })
        }),
      }),
    },
    onSubmit: async ({ value }) => {
      const parsed = goalAmount(metric, value.amount, currency, locale)
      if ("amount" in parsed) await save.mutateAsync(parsed.amount)
    },
  })
  // Cada meta abre con lo suyo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de meta; lo que llegue después no pisa lo escrito.
  useEffect(() => {
    if (metric) form.reset({ amount: initial })
  }, [metric])
  const surface = useFormSurface(form)
  if (!metric) return null
  const best = metric === "cobrado" ? goals?.best.cobrado : goals?.best.pacientesNuevos
  const bestText = best
    ? metric === "cobrado"
      ? `Tu mejor mes del último año fue ${formatMoney((best as { cents: number }).cents, currency, locale)} (${monthOf(best.month, locale)}).`
      : `Tu mejor mes del último año tuvo ${(best as { count: number }).count} pacientes nuevos (${monthOf(best.month, locale)}).`
    : null
  return (
    <FormDrawer
      {...surface}
      isSubmitting={surface.isSubmitting || save.isPending}
      open
      onClose={onClose}
      title={metric === "cobrado" ? "Meta de cobrado por mes" : "Meta de pacientes nuevos por mes"}
      description="Es de toda la clínica y vale desde este mes."
      submitLabel="Guardar meta"
      {...(current
        ? {
            secondaryAction: {
              label: "Quitar la meta",
              // Quitarla no es un envío: si falla, se dice junto a los botones.
              onClick: () => {
                clearSubmitErrors(form)
                save.mutateAsync(null).catch((failure: unknown) => applySubmitError(form, failure))
              },
              disabled: save.isPending,
            },
          }
        : {})}
    >
      <form.AppField name="amount">
        {(field) => (
          <field.Control
            id={id}
            label={metric === "cobrado" ? "Cuánto quieres cobrar cada mes" : "Cuántos pacientes nuevos quieres cada mes"}
            description={`${bestText ? `${bestText} ` : ""}Si la cambias, los meses pasados conservan la que tenían.`}
          >
            {(control) =>
              metric === "cobrado" ? (
                <MoneyInput
                  id={control.id}
                  value={field.state.value}
                  onChange={(next) => field.handleChange(next)}
                  currency={currency}
                  locale={locale}
                  autoFocus
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                />
              ) : (
                <Input
                  {...control.props}
                  inputMode="numeric"
                  autoComplete="off"
                  value={field.state.value}
                  autoFocus
                  onChange={(event) => field.handleChange(event.target.value.replace(/\D/g, ""))}
                />
              )
            }
          </field.Control>
        )}
      </form.AppField>
    </FormDrawer>
  )
}

// --- Fijadas -------------------------------------------------------------------------------

/**
 * Las respuestas de Argos que alguien fijó (decisión 8): hasta cuatro, las ve
 * todo el que ve Reportes y cualquiera las quita. Se recalculan, no son una
 * foto: las de las 32 cifras siguen el periodo y la sede de arriba; las del
 * Argos de las vistas (D5) vuelven a correr su consulta, siempre al día.
 */
export function PinnedAnswers({ query, argosEnabled }: { query: ReportQuery; argosEnabled: boolean | undefined }) {
  const queryClient = useQueryClient()
  const locale = useOrgLocale() ?? "es"
  const pins = useQuery({ queryKey: [...PINS_KEY, query.period, query.branchId ?? null], queryFn: () => fetchPins(query), retry: false })
  const remove = useMutation({
    retry: false,
    mutationFn: (id: string) => unpinAnswer(id),
    onSuccess: () => {
      toast.success("Quitada del Resumen")
      void queryClient.invalidateQueries({ queryKey: PINS_KEY })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const list = pins.data?.data.pins ?? []
  const asked = pins.data?.data.argos ?? []
  // Sin Argos y sin nada fijado no hay nada que mostrar ni cómo fijar.
  if (pins.isSuccess && list.length + asked.length === 0 && argosEnabled !== true) return null
  const room = (pins.data?.data.limit ?? 4) - list.length - asked.length
  return (
    <section aria-labelledby="fijadas" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 id="fijadas" className="font-semibold">
          Fijadas
        </h3>
        <p className="text-sm text-muted-foreground">Respuestas de {ADMIN_NAME} que alguien fijó. Se vuelven a calcular cada vez que abres el Resumen.</p>
      </div>
      {pins.isPending ? (
        <LoadingState />
      ) : pins.isError ? (
        <QueryErrorState error={pins.error} onRetry={() => void pins.refetch()} />
      ) : (
        <div className="grid min-w-0 gap-3.5 @3xl:grid-cols-2">
          {list.map((pin) => (
            <ReportCard key={pin.id} title={pin.answer?.title ?? "Cifra que ya no está"}>
              {pin.answer ? (
                <>
                  <p className="text-sm">
                    {pin.answer.sentence.map((part, index) =>
                      // biome-ignore lint/suspicious/noArrayIndexKey: las partes de una frase no cambian de orden.
                      part.strong ? <strong key={index} className="font-bold tabular-nums">{part.text}</strong> : <span key={index}>{part.text}</span>,
                    )}
                  </p>
                  <AnswerChart answer={pin.answer} compact />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Esta respuesta ya no se puede calcular para ti.</p>
              )}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Fijada por {pin.pinnedBy} el {dayText(pin.pinnedOn, pin.answer?.locale ?? "es", { day: "numeric", month: "long" })}
                  {pin.answer ? ` · ${pin.answer.scope}` : ""}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-primary-soft-foreground sm:min-h-8"
                  aria-label={`Quitar «${pin.answer?.title ?? "Cifra que ya no está"}» del Resumen`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(pin.id)}
                >
                  Quitar
                </Button>
              </div>
            </ReportCard>
          ))}
          {asked.map((pin) => (
            <ReportCard key={pin.id} title={pin.title}>
              {pin.answer ? (
                <div className="flex min-w-0 flex-col gap-2 text-sm">
                  {/* Fijada sigue diciendo que respondió solo una parte, y cómo se calculó. */}
                  {pin.partial ? (
                    <Badge variant="outline" className="self-start">
                      Parcial
                    </Badge>
                  ) : null}
                  {/* Con el periodo y la sede de arriba (D11); lo que es a hoy lo dice. */}
                  {pin.period ? (
                    <p className="text-[13px] text-muted-foreground">
                      {pin.period.value === "a_hoy"
                        ? pin.period.label
                        : [pin.period.label, pin.period.other ? `contra ${pin.period.other.label}` : null, pin.period.compareLabel ? `comparado con ${pin.period.compareLabel}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                  ) : null}
                  <ArgosShownView shown={pin.answer} title={pin.title} />
                  {pin.missing ? <p className="text-[13px] text-muted-foreground">Falta: {pin.missing}</p> : null}
                  <Badge variant={pin.source === "oficial" ? "soft" : "outline"} className="self-start">
                    {pin.source === "oficial" ? "Cifra oficial · la misma cuenta de Reportes" : "Cálculo de Argos"}
                  </Badge>
                  {pin.how ? (
                    <p className="text-[13px] text-muted-foreground">
                      <span className="font-bold text-foreground">Así lo calculé:</span> {pin.how}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Esta respuesta ya no se puede calcular para ti.</p>
              )}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Fijada por {pin.pinnedBy} el {dayText(pin.pinnedOn, locale, { day: "numeric", month: "long" })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-primary-soft-foreground sm:min-h-8"
                  aria-label={`Quitar «${pin.title}» del Resumen`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(pin.id)}
                >
                  Quitar
                </Button>
              </div>
            </ReportCard>
          ))}
          {room > 0 && argosEnabled ? (
            <div className="flex min-h-28 items-center justify-center rounded-xl border-[1.5px] border-dashed p-4 text-center text-sm text-muted-foreground">
              Pregunta algo arriba y toca «Fijar en Resumen». {room === 1 ? "Cabe 1 más." : `Caben ${room} más.`}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

// --- El resumen del lunes ----------------------------------------------------------------

/** El interruptor de cada persona: guarda al momento y nace apagado (decisión 10). */
export function MondayDigestCard() {
  const queryClient = useQueryClient()
  const id = useId()
  const digest = useQuery({ queryKey: DIGEST_KEY, queryFn: fetchDigest, retry: false })
  const change = useMutation({
    retry: false,
    mutationFn: (enabled: boolean) => setDigest(enabled),
    onSuccess: (response) => {
      queryClient.setQueryData(DIGEST_KEY, response)
      toast.success(response.data.enabled ? "Listo: el lunes a las 8:00 te llega tu resumen" : "Ya no te llega el resumen del lunes")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const enabled = digest.data?.data.enabled ?? false
  return (
    <ReportCard title="El resumen del lunes">
      <div className="flex min-w-0 items-start gap-3">
        <p id={`${id}-que`} className="min-w-0 flex-1 text-sm text-foreground/80">
          Cada lunes a las 8:00, hora de la clínica, te llega un correo con cuatro cifras de la semana, lo que cambió y lo que recomienda {ADMIN_NAME}. Usa las mismas
          cifras de Reportes y frases fijas; no lleva datos de pacientes.
        </p>
        {digest.isError ? null : (
          <Switch
            id={id}
            aria-label="Recibir el resumen del lunes por correo"
            aria-describedby={`${id}-que`}
            checked={enabled}
            disabled={digest.isPending || change.isPending}
            onCheckedChange={(checked: boolean) => change.mutate(checked)}
          />
        )}
      </div>
      {digest.isError ? <QueryErrorState error={digest.error} onRetry={() => void digest.refetch()} /> : null}
    </ReportCard>
  )
}

