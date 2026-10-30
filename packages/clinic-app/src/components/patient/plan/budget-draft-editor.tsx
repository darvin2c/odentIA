/**
 * El borrador de una opción del presupuesto: precios, promociones, visitas
 * previstas y los tratamientos que entran. Se arma aquí, donde se ven los
 * precios; el dictado sigue agregando tratamientos al plan.
 */
import { formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Button, Checkbox, cn, FieldGroup, FieldLabel } from "@odentia/ui"
import {
  applySubmitError,
  clearSubmitErrors,
  FormDrawer,
  focusFirstInvalid,
  SubmitButton,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { z } from "zod"
import type { AdjustBudgetLineBody, BudgetLine, BudgetOption, BudgetWithTotals } from "../../../lib/budgets"
import type { PlanItem } from "../../../lib/patients"
import type { Promotion } from "../../../lib/promotions"
import {
  BudgetTotals,
  billingNote,
  hasFixedPromotion,
  isBelowTariff,
  isSessionLine,
  type Money,
  sessionExplanation,
  treatmentSiteLabel,
} from "./budget-parts"

/** Lo escrito de una línea, con el nombre que tiene en el cuerpo de `…/lines`. */
interface DraftRow {
  planItemId: string
  priceCents: string
  sessionsPlanned: string
}

interface DraftValues {
  lines: DraftRow[]
  /** Motivo común del ajuste de precio. */
  reason: string
}

interface DraftIssue {
  path: Array<string | number>
  message: string
}

/** Lo que se guarda (`lines`), la fila del formulario de cada uno (`at`) y lo que falta corregir. */
interface DraftPatch {
  lines: AdjustBudgetLineBody[]
  at: number[]
  issues: DraftIssue[]
}

const draftShape = z.object({
  lines: z.array(z.object({ planItemId: z.string(), priceCents: z.string(), sessionsPlanned: z.string() })),
  reason: z.string(),
})

const discountSchema = z.object({
  percent: z
    .string()
    .trim()
    .refine((text) => /^\d{1,3}$/.test(text) && Number(text) >= 1 && Number(text) <= 100, "Escribe un porcentaje del 1 al 100."),
  reason: z.string().trim().min(1, "Escribe el motivo del descuento.").max(500, "Escribe como mucho 500 caracteres."),
})

/**
 * Precio de referencia de una línea: su tarifa o, con promoción «desde», el
 * mínimo anunciado. `undefined` cuando esa promoción ya no está entre las
 * vigentes: entonces solo el servidor sabe si hace falta motivo.
 */
function lineReference(line: BudgetLine, promotions: Promotion[]): number | null | undefined {
  if (line.promotionId != null && line.promotionMode === "from") {
    const item = promotions
      .find((promo) => promo.id === line.promotionId)
      ?.items.find((entry) => entry.serviceId === line.serviceId)
    return item ? item.priceCents : undefined
  }
  return line.tariffPriceCents
}

/**
 * Borrador de una opción del presupuesto (tableros 6, 13b y 22; decisión 13):
 * precio acordado por línea, visitas previstas de lo que se cobra por sesión,
 * promociones ofrecidas y un motivo común para lo que baja de su referencia.
 * Lo escrito se conserva hasta guardar; aplicar o quitar una promoción se
 * guarda en el momento. Con varias opciones, cada una se edita aparte: sus
 * líneas, su total y sus tratamientos. Cada error se dice en la línea y el
 * dato que hay que corregir, también los del servidor (`lines[i].priceCents`).
 */
export function BudgetDraftEditor({
  budget,
  option,
  lines,
  promotions,
  promotionsFailed,
  onRetryPromotions,
  locale,
  money,
  disabled,
  delivering,
  saveLines,
  addable,
  addItems,
  removeItems,
  onDeliver,
  actionAlert,
  sendAction,
  secondaryActions,
}: {
  budget: BudgetWithTotals
  /** La opción que se edita y sus líneas. */
  option: BudgetOption
  lines: BudgetLine[]
  promotions: Promotion[]
  promotionsFailed: boolean
  onRetryPromotions: () => void
  locale: string
  money: Money
  disabled: boolean
  delivering: boolean
  saveLines: (lines: AdjustBudgetLineBody[]) => Promise<unknown>
  addable: PlanItem[]
  addItems: (itemIds: string[]) => Promise<unknown>
  removeItems: (itemIds: string[]) => Promise<unknown>
  /** Guarda lo pendiente y entrega; rechaza si lo pendiente no se pudo guardar (se dice en cada línea). */
  onDeliver: (pendingLines: AdjustBudgetLineBody[]) => Promise<void>
  actionAlert: ReactNode
  /** «Enviar por WhatsApp»: recibe cómo guardar antes lo escrito. */
  sendAction?: (beforeSend: () => Promise<void>) => ReactNode
  secondaryActions: ReactNode
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** Aplicar o quitar una promoción, incluir o quitar un tratamiento: la acción en curso. */
  const [pending, setPending] = useState<string | null>(null)
  /** El rechazo de una acción suelta, junto a su línea (`planItemId`) o a «Otros tratamientos» (`add`). */
  const [actionError, setActionError] = useState<{ at: string; message: string } | null>(null)
  const [discountOpen, setDiscountOpen] = useState(false)

  const inputValue = (cents: number | null, currency: string): string => {
    if (cents == null) return ""
    try {
      return formatMoneyInput(cents, currency, locale)
    } catch {
      return ""
    }
  }
  const savedVisits = (line: BudgetLine): string => (line.sessionsPlanned == null ? "" : String(line.sessionsPlanned))
  const savedReason = lines.find((line) => line.priceReason)?.priceReason ?? ""
  /** Lo guardado, como se escribe en el formulario. */
  const saved: DraftValues = {
    lines: lines.map((line) => ({
      planItemId: line.planItemId,
      priceCents: inputValue(line.priceCents, line.currency),
      sessionsPlanned: savedVisits(line),
    })),
    reason: savedReason,
  }

  /** Lo que cambió frente a lo guardado y lo que aún impide guardarlo, cada cosa en su campo. */
  const analyze = (values: DraftValues): DraftPatch => {
    const reasonValue = values.reason.trim()
    const reasonTouched = values.reason !== savedReason
    const changes: AdjustBudgetLineBody[] = []
    const at: number[] = []
    const issues: DraftIssue[] = []
    if (reasonValue.length > 500) issues.push({ path: ["reason"], message: "Escribe como mucho 500 caracteres." })
    for (const line of lines) {
      const index = values.lines.findIndex((row) => row.planItemId === line.planItemId)
      const row = values.lines[index]
      if (!row) continue
      const body: AdjustBudgetLineBody = { planItemId: line.planItemId, optionId: option.id }
      let changed = false
      let price = line.priceCents
      const visitsText = row.sessionsPlanned.trim()
      const visitsEdited = isSessionLine(line) && visitsText !== savedVisits(line)

      if (!hasFixedPromotion(line)) {
        const text = row.priceCents.trim()
        if (text === "") {
          // Sin precio no se guarda nada de la línea: tampoco sus visitas.
          if (line.priceCents != null || visitsEdited) {
            issues.push({ path: ["lines", index, "priceCents"], message: "Escribe el precio acordado." })
          }
        } else if (text !== inputValue(line.priceCents, line.currency)) {
          try {
            const parsed = parseMoney(text, line.currency, locale)
            if (parsed !== line.priceCents) {
              body.priceCents = parsed
              changed = true
            }
            price = parsed
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Importe inválido"
            issues.push({ path: ["lines", index, "priceCents"], message: `${detail}.` })
          }
        }
      }

      if (visitsEdited) {
        const visits = /^\d{1,3}$/.test(visitsText) ? Number(visitsText) : Number.NaN
        if (!Number.isInteger(visits) || visits < 1 || visits > 200) {
          issues.push({ path: ["lines", index, "sessionsPlanned"], message: "Escribe de 1 a 200 visitas." })
        } else if (visits !== line.sessionsPlanned) {
          body.sessionsPlanned = visits
          changed = true
        }
      }

      // Motivo: solo cuando el precio baja de su referencia, y solo si aquí se
      // tocó el precio o el motivo. La regla la aplica el servidor; esto evita
      // enviar un borrador al que le va a faltar.
      const priceChanged = body.priceCents !== undefined
      if (!hasFixedPromotion(line) && (priceChanged || reasonTouched)) {
        const reference = lineReference(line, promotions)
        if (reference === undefined) {
          if (priceChanged && reasonValue && reasonValue !== (line.priceReason ?? "")) {
            body.reason = reasonValue
          }
        } else if (reference != null && price != null && price < reference) {
          const wanted = reasonTouched ? reasonValue : (line.priceReason ?? reasonValue)
          if (!wanted) {
            const floor = line.promotionId ? "del mínimo de la promoción" : "del precio normal"
            if (!issues.some((issue) => issue.path[0] === "reason")) {
              issues.push({
                path: ["reason"],
                message: `Escribe el motivo del ajuste: «${line.title}» queda por debajo ${floor}.`,
              })
            }
          } else if (wanted !== (line.priceReason ?? "")) {
            body.reason = wanted
            changed = true
          }
        } else if (priceChanged && line.priceReason) {
          // Volvió a su referencia: el motivo anterior ya no describe nada.
          body.reason = null
        }
      }

      if (changed) {
        changes.push(body)
        at.push(index)
      }
    }
    return { lines: changes, at, issues }
  }

  /** La fila del formulario de cada línea del último envío: el servidor la nombra por su lugar en el cuerpo. */
  const sentAt = useRef<number[]>([])
  const fieldMap = (key: string): string | undefined => {
    const match = /^lines\[(\d+)\]\.(\w+)$/.exec(key)
    if (!match) return undefined
    if (match[2] === "reason") return "reason"
    const index = sentAt.current[Number(match[1])]
    if (index === undefined) return ""
    if (match[2] === "priceCents" || match[2] === "promotionFinalPriceCents") return `lines[${index}].priceCents`
    if (match[2] === "sessionsPlanned") return `lines[${index}].sessionsPlanned`
    return ""
  }

  // Los valores de partida se fijan una vez; lo que cambia en el servidor entra por `rebase`.
  const [initial] = useState<DraftValues>(saved)
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: draftShape.superRefine((value, ctx) => {
        for (const issue of analyze(value).issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
      }),
    },
    onSubmit: async ({ value }) => {
      const patch = analyze(value)
      if (patch.lines.length === 0) return
      sentAt.current = patch.at
      await saveLines(patch.lines)
    },
  })
  const values = useStore(form.store, (state) => state.values)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const formError = useFormSubmitError(form)

  // Al cambiar lo guardado (guardar, promoción, descuento, otra línea), cada
  // campo toma el valor nuevo salvo lo que se escribió aquí sobre un valor
  // que no cambió en el servidor.
  const savedKey = JSON.stringify(saved)
  const lastSaved = useRef(saved)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` se rehace en cada render; reaplica lo guardado solo cuando cambia su contenido (`savedKey`), no en cada render.
  useEffect(() => {
    const before = lastSaved.current
    lastSaved.current = saved
    const current = form.state.values
    const keep = (now: string | undefined, was: string | undefined, next: string): string =>
      now !== undefined && was !== undefined && now !== was && was === next ? now : next
    const rows = saved.lines.map((row) => {
      const was = before.lines.find((entry) => entry.planItemId === row.planItemId)
      const now = current.lines.find((entry) => entry.planItemId === row.planItemId)
      return {
        planItemId: row.planItemId,
        priceCents: keep(now?.priceCents, was?.priceCents, row.priceCents),
        sessionsPlanned: keep(now?.sessionsPlanned, was?.sessionsPlanned, row.sessionsPlanned),
      }
    })
    const quiet = { dontUpdateMeta: true, dontValidate: true }
    form.setFieldValue("lines", rows, quiet)
    form.setFieldValue("reason", keep(current.reason, before.reason, saved.reason), quiet)
  }, [savedKey])

  const patch = analyze(values)
  const dirty = patch.issues.length > 0 || patch.lines.length > 0

  const [discountDefaults, setDiscountDefaults] = useState({ percent: "", reason: "" })
  const discountForm = useAppForm({
    defaultValues: discountDefaults,
    validators: { onSubmit: discountSchema },
    onSubmit: async ({ value }) => {
      const percent = Number(value.percent.trim())
      const motive = value.reason.trim()
      // El porcentaje se reparte aquí, sobre la tarifa de cada línea y en enteros
      // de la unidad menor de la moneda; el servidor guarda ese precio con el
      // motivo común y devuelve los totales.
      const discounted: AdjustBudgetLineBody[] = lines.flatMap((line) => {
        const base = line.tariffPriceCents ?? line.priceCents
        if (line.promotionId != null || base == null) return []
        return [
          {
            planItemId: line.planItemId,
            optionId: option.id,
            priceCents: Math.round((base * (100 - percent)) / 100),
            reason: motive,
          },
        ]
      })
      if (discounted.length === 0) {
        throw new Error("Ningún tratamiento admite el descuento: todos tienen una promoción o les falta el precio.")
      }
      await saveLines(discounted)
      setDiscountOpen(false)
    },
  })
  // Del descuento solo el motivo es un campo: lo demás del servidor se dice junto a los botones.
  const discountSurface = useFormSurface(discountForm, {
    fieldMap: (key) => (/^lines\[\d+\]\.reason$/.test(key) ? "reason" : ""),
  })

  const blocked = disabled || pending != null || saving || discountSurface.isSubmitting
  // En una revisión los tratamientos se eligen al crearla (misma regla del servidor).
  const canChangeItems = !budget.supersedesBudgetId

  /**
   * Imprimir y entregar: si algo de lo escrito no vale, se dice en su campo y
   * no se entrega. La pestaña del PDF se abre dentro del clic (después, el
   * navegador la bloquea), por eso lo escrito se comprueba aquí sin esperar.
   */
  const handleDeliver = () => {
    const current = analyze(form.state.values)
    if (current.issues.length > 0) {
      void submitForm(form, { fieldMap, root: rootRef.current })
      return
    }
    clearSubmitErrors(form)
    sentAt.current = current.at
    onDeliver(current.lines).catch((err: unknown) => {
      applySubmitError(form, err, { fieldMap })
      focusFirstInvalid(rootRef.current)
    })
  }

  /** Antes de enviar se guarda lo escrito; si algo no se puede guardar, se dice en su campo y no se envía. */
  const saveBeforeSend = async () => {
    const ok = await submitForm(form, { fieldMap, root: rootRef.current })
    if (!ok) throw new Error("Corrige lo marcado en el borrador antes de enviarlo.")
  }

  /** Una acción que se guarda en el momento; su rechazo se dice junto a ella. */
  const runAction = async (key: string, at: string, action: () => Promise<unknown>) => {
    setActionError(null)
    setPending(key)
    try {
      await action()
    } catch (err) {
      setActionError({ at, message: submitErrorMessage(err) })
    } finally {
      setPending(null)
    }
  }

  const openDiscount = () => {
    const next = { percent: "", reason: form.state.values.reason }
    setDiscountDefaults(next)
    discountForm.reset(next)
    setDiscountOpen(true)
  }

  const note = sessionExplanation(lines, money)

  return (
    <div ref={rootRef} className="contents">
      <div className="flex flex-col rounded-xl border">
        <div
          aria-hidden="true"
          className="hidden items-center gap-3 rounded-t-xl bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_8rem]"
        >
          <span>Tratamiento</span>
          <span className="text-right">Precio normal</span>
          <span className="text-right">Precio acordado</span>
        </div>
        <ul aria-label="Tratamientos del presupuesto" className="flex flex-col divide-y">
          {lines.map((line) => {
            const index = values.lines.findIndex((row) => row.planItemId === line.planItemId)
            const fixed = hasFixedPromotion(line)
            const session = isSessionLine(line)
            const below = isBelowTariff(line)
            const reference = lineReference(line, promotions)
            const offers =
              line.promotionId != null || line.serviceId == null
                ? []
                : promotions.flatMap((promo) => {
                    const item = promo.items.find(
                      (entry) =>
                        entry.serviceId === line.serviceId && entry.currency === line.currency,
                    )
                    return item ? [{ promo, item }] : []
                  })
            const priceLabel = session
              ? `Precio por visita de ${line.title}`
              : `Precio acordado de ${line.title}`
            return (
              <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]">
                  <div className="flex min-w-0 items-start gap-3">
                    {/* Casilla de los tableros: desmarcarla quita el tratamiento del borrador. */}
                    {canChangeItems ? (
                      <Checkbox
                        checked
                        className="mt-0.5"
                        disabled={blocked}
                        aria-label={`Incluir ${line.title}`}
                        onCheckedChange={(next) => {
                          if (next === true) return
                          void runAction(`drop:${line.planItemId}`, line.planItemId, () =>
                            removeItems([line.planItemId]),
                          )
                        }}
                      />
                    ) : null}
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{line.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {treatmentSiteLabel(line)} · {billingNote(line, money, false)}
                    </span>
                    {/* En pantallas estrechas no hay columna «Precio normal»: va aquí. */}
                    {!below && line.tariffPriceCents != null ? (
                      <span className="text-xs text-muted-foreground sm:hidden">
                        Precio normal {money.plain(line.tariffPriceCents, line.currency)}
                      </span>
                    ) : null}
                    {below ? (
                      <span className="text-xs font-medium text-primary">
                        {line.lineDiscountCents != null
                          ? `${money.plain(line.lineDiscountCents, line.currency)} menos que el precio normal`
                          : `Menos que el precio normal de ${money.plain(line.tariffPriceCents, line.currency)}`}
                      </span>
                    ) : null}
                    {line.priceCents == null ? (
                      <span className="text-xs text-muted-foreground">
                        Sin precio normal: escribe el precio acordado.
                      </span>
                    ) : null}
                  </div>
                  </div>
                  <span className="hidden text-right text-sm text-muted-foreground tabular-nums sm:block">
                    <span className="sr-only">Precio normal: </span>
                    <span className={cn(below && "line-through")}>
                      {line.tariffPriceCents == null
                        ? "sin precio"
                        : money.plain(line.tariffPriceCents, line.currency)}
                    </span>
                  </span>
                  {fixed ? (
                    <span className="justify-self-end text-right font-semibold tabular-nums">
                      {money.plain(line.priceCents, line.currency)}
                    </span>
                  ) : index >= 0 ? (
                    <form.AppField name={`lines[${index}].priceCents`}>
                      {(field) => (
                        <field.TextField
                          label={priceLabel}
                          hideLabel
                          inputMode="decimal"
                          autoComplete="off"
                          className="w-32 justify-self-end text-right"
                          inputClassName="w-28 self-end text-right font-semibold tabular-nums"
                          disabled={blocked}
                        />
                      )}
                    </form.AppField>
                  ) : null}
                </div>

                {session && index >= 0 ? (
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <form.AppField name={`lines[${index}].sessionsPlanned`}>
                      {(field) => (
                        <field.TextField
                          label="Visitas previstas"
                          inputMode="numeric"
                          autoComplete="off"
                          className="w-auto"
                          inputClassName="w-16 text-center font-semibold tabular-nums"
                          disabled={blocked}
                        />
                      )}
                    </form.AppField>
                    <span className="ml-auto text-sm">
                      <span className="text-muted-foreground">Total de la línea </span>
                      <span className="font-semibold tabular-nums">
                        {line.lineTotalCents == null
                          ? "sin precio"
                          : money.plain(line.lineTotalCents, line.currency)}
                      </span>
                    </span>
                  </div>
                ) : null}

                {line.promotionId != null ? (
                  <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        Promoción: {line.promotionName ?? "sin nombre"}
                      </span>
                      <SubmitButton
                        size="sm"
                        variant="outline"
                        pending={pending === `remove:${line.planItemId}`}
                        disabled={blocked}
                        onClick={() =>
                          void runAction(`remove:${line.planItemId}`, line.planItemId, () =>
                            saveLines([{ planItemId: line.planItemId, optionId: option.id, promotionId: null }]),
                          )
                        }
                      >
                        Quitar
                        <span className="sr-only"> la promoción de {line.title}</span>
                      </SubmitButton>
                    </div>
                    {fixed ? (
                      <span className="text-xs text-muted-foreground">
                        El precio de esta promoción es fijo.
                      </span>
                    ) : reference != null ? (
                      <span className="text-xs text-muted-foreground">
                        Solo pide un motivo si el precio baja de {money.plain(reference,line.currency)}.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  offers.map(({ promo, item }) => {
                    const key = `apply:${line.planItemId}:${promo.id}`
                    return (
                      <div
                        key={promo.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{promo.name}:</span>{" "}
                          {item.mode === "fixed"
                            ? `quedaría en ${money.plain(item.priceCents, item.currency)}`
                            : `tú pones el precio final, desde ${money.plain(item.priceCents, item.currency)}`}
                        </span>
                        <SubmitButton
                          size="sm"
                          variant="outline"
                          pending={pending === key}
                          disabled={blocked}
                          onClick={() =>
                            void runAction(key, line.planItemId, () =>
                              saveLines([
                                item.mode === "fixed"
                                  ? { planItemId: line.planItemId, optionId: option.id, promotionId: promo.id }
                                  : {
                                      planItemId: line.planItemId,
                                      optionId: option.id,
                                      promotionId: promo.id,
                                      // Con «desde», el precio editable empieza en el mínimo anunciado.
                                      promotionFinalPriceCents: item.priceCents,
                                    },
                              ]),
                            )
                          }
                        >
                          Aplicar
                          <span className="sr-only">
                            {" "}
                            {promo.name} a {line.title}
                          </span>
                        </SubmitButton>
                      </div>
                    )
                  })
                )}
                {actionError?.at === line.planItemId ? (
                  <p role="alert" className="text-sm text-destructive">
                    {actionError.message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>

      {addable.length > 0 ? (
        <fieldset className="flex flex-col gap-2 rounded-xl border border-dashed px-3 py-3">
          <legend className="px-1 text-sm font-medium">Otros tratamientos del plan</legend>
          <p className="text-xs text-muted-foreground">
            {budget.options.length > 1
              ? `Marca uno para incluirlo en la ${option.label.toLowerCase()}, a su precio normal.`
              : "Marca uno para incluirlo en este presupuesto, a su precio normal."}
          </p>
          {addable.map((item) => (
            <FieldLabel key={item.id} className="flex items-center gap-3 text-sm font-normal">
              <Checkbox
                checked={false}
                disabled={blocked}
                aria-label={`Incluir ${item.title}`}
                onCheckedChange={(next) => {
                  if (next !== true) return
                  void runAction(`add:${item.id}`, "add", () => addItems([item.id]))
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{item.title}</span>{" "}
                <span className="text-xs text-muted-foreground">{treatmentSiteLabel(item)}</span>
              </span>
              <span className="text-muted-foreground tabular-nums">
                {item.priceCents == null ? "Sin precio" : money.plain(item.priceCents, item.currency)}
              </span>
            </FieldLabel>
          ))}
          {actionError?.at === "add" ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError.message}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {promotionsFailed ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          No se pudieron cargar las promociones vigentes.
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={onRetryPromotions}
          >
            Reintentar
          </Button>
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-3">
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0"
            disabled={blocked}
            onClick={openDiscount}
          >
            Aplicar un descuento a todo
          </Button>
          <form.AppField name="reason">
            {(field) => (
              <field.TextField
                label="Motivo del ajuste de precio"
                description="Se pide solo cuando un precio baja del precio normal."
                maxLength={500}
                disabled={blocked}
              />
            )}
          </form.AppField>
        </div>
        <BudgetTotals
          option={option}
          lines={lines}
          currency={budget.currency}
          money={money}
          className="flex-[1_1_16rem]"
        />
      </div>

      {dirty ? (
        <p role="status" className="text-sm text-muted-foreground">
          Hay cambios sin guardar: el total se actualiza al guardar el borrador.
        </p>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {actionAlert}

      <div className="flex flex-col gap-2 border-t pt-4">
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          {sendAction ? sendAction(saveBeforeSend) : null}
          <SubmitButton
            variant={sendAction ? "outline" : "default"}
            pending={delivering}
            disabled={blocked}
            onClick={handleDeliver}
          >
            Imprimir y entregar
          </SubmitButton>
          <SubmitButton
            variant="outline"
            pending={saving}
            disabled={blocked || !dirty}
            onClick={() => void submitForm(form, { fieldMap, root: rootRef.current })}
          >
            Guardar borrador
          </SubmitButton>
          {secondaryActions}
        </div>
      </div>

      {discountOpen ? (
        <FormDrawer
          {...discountSurface}
          open={discountOpen}
          title="Aplicar un descuento a todo"
          description="Baja el mismo porcentaje a cada tratamiento, calculado sobre su precio normal. Los que tienen una promoción no cambian."
          submitLabel="Aplicar descuento"
          onClose={() => {
            if (!discountSurface.isSubmitting) setDiscountOpen(false)
          }}
        >
          <FieldGroup>
            <discountForm.AppField name="percent">
              {(field) => (
                <field.TextField
                  label="Descuento, en porcentaje"
                  description="Un número del 1 al 100."
                  inputMode="numeric"
                  autoComplete="off"
                />
              )}
            </discountForm.AppField>
            <discountForm.AppField name="reason">
              {(field) => (
                <field.TextField
                  label="Motivo del descuento"
                  description="Queda anotado en cada tratamiento que baja."
                  maxLength={500}
                />
              )}
            </discountForm.AppField>
          </FieldGroup>
        </FormDrawer>
      ) : null}
    </div>
  )
}
