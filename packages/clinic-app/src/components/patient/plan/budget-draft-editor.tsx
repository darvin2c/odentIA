/**
 * El borrador de una opción del presupuesto: precios, promociones, visitas
 * previstas y los tratamientos que entran. Se arma aquí, donde se ven los
 * precios; el dictado sigue agregando tratamientos al plan.
 */
import { formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Button, Checkbox, cn, Field, FieldDescription, FieldGroup, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { type ReactNode, useId, useState } from "react"
import type { AdjustBudgetLineBody, BudgetLine, BudgetOption, BudgetWithTotals } from "../../../lib/budgets"
import type { PlanItem } from "../../../lib/patients"
import type { Promotion } from "../../../lib/promotions"
import {
  billingNote,
  BudgetTotals,
  hasFixedPromotion,
  isBelowTariff,
  isSessionLine,
  type Money,
  mutationMessage,
  sessionExplanation,
  treatmentSiteLabel,
} from "./budget-parts"

interface LineEdit {
  price?: string
  sessions?: string
}

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
 * líneas, su total y sus tratamientos.
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
  onDeliver: (pendingLines: AdjustBudgetLineBody[]) => void
  actionAlert: ReactNode
  /** «Enviar por WhatsApp»: recibe cómo guardar antes lo escrito. */
  sendAction?: (beforeSend: () => Promise<void>) => ReactNode
  secondaryActions: ReactNode
}): React.JSX.Element {
  const uid = useId()
  const [edits, setEdits] = useState<Record<string, LineEdit>>({})
  /** `null`: el motivo no se ha tocado y vale el que ya tienen las líneas. */
  const [reason, setReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountPercent, setDiscountPercent] = useState("")
  const [discountReason, setDiscountReason] = useState("")
  const [discountError, setDiscountError] = useState<string | null>(null)

  const savedReason = lines.find((line) => line.priceReason)?.priceReason ?? ""
  const reasonText = reason ?? savedReason
  const reasonTouched = reason !== null

  const inputValue = (cents: number | null, currency: string): string => {
    if (cents == null) return ""
    try {
      return formatMoneyInput(cents, currency, locale)
    } catch {
      return ""
    }
  }
  const setEdit = (planItemId: string, patch: LineEdit) =>
    setEdits((current) => ({ ...current, [planItemId]: { ...current[planItemId], ...patch } }))
  /** Tras cambiar el precio en el servidor, lo escrito para ese precio ya no vale. */
  const dropPriceEdits = (planItemIds: string[]) =>
    setEdits((current) => {
      const next = { ...current }
      for (const id of planItemIds) {
        if (next[id]) next[id] = { sessions: next[id].sessions }
      }
      return next
    })

  /** Lo que cambió frente a lo guardado, o el motivo por el que aún no se puede guardar. */
  const buildPatch = (): { lines: AdjustBudgetLineBody[] } | { error: string } => {
    const reasonValue = reasonText.trim()
    const changes: AdjustBudgetLineBody[] = []
    for (const line of lines) {
      const edit = edits[line.planItemId] ?? {}
      const body: AdjustBudgetLineBody = { planItemId: line.planItemId, optionId: option.id }
      let changed = false
      let price = line.priceCents

      if (edit.price !== undefined && !hasFixedPromotion(line)) {
        const text = edit.price.trim()
        if (text === "") {
          if (line.priceCents != null) {
            return { error: `Escribe el precio acordado de «${line.title}».` }
          }
        } else {
          let parsed: number
          try {
            parsed = parseMoney(text, line.currency, locale)
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Importe inválido"
            return { error: `«${line.title}»: ${detail}.` }
          }
          if (parsed !== line.priceCents) {
            body.priceCents = parsed
            changed = true
          }
          price = parsed
        }
      }

      if (edit.sessions !== undefined && isSessionLine(line)) {
        const text = edit.sessions.trim()
        const visits = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN
        if (!Number.isInteger(visits) || visits < 1 || visits > 200) {
          return { error: `Las visitas previstas de «${line.title}» van de 1 a 200.` }
        }
        if (visits !== line.sessionsPlanned) {
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
            return {
              error: `Escribe el motivo del ajuste: «${line.title}» queda por debajo ${floor}.`,
            }
          }
          if (wanted !== (line.priceReason ?? "")) {
            body.reason = wanted
            changed = true
          }
        } else if (priceChanged && line.priceReason) {
          // Volvió a su referencia: el motivo anterior ya no describe nada.
          body.reason = null
        }
      }

      if (changed) changes.push(body)
    }
    return { lines: changes }
  }

  const patch = buildPatch()
  const dirty = "error" in patch || patch.lines.length > 0
  const blocked = disabled || pending != null
  // En una revisión los tratamientos se eligen al crearla (misma regla del servidor).
  const canChangeItems = !budget.supersedesBudgetId

  const handleSave = async () => {
    if ("error" in patch) {
      setError(patch.error)
      return
    }
    if (patch.lines.length === 0) return
    setError(null)
    setPending("save")
    try {
      await saveLines(patch.lines)
      setEdits({})
      setReason(null)
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const handleDeliver = () => {
    if ("error" in patch) {
      setError(patch.error)
      return
    }
    setError(null)
    onDeliver(patch.lines)
  }

  /** Antes de enviar se guarda lo escrito; si algo no se puede guardar, no se envía. */
  const saveBeforeSend = async () => {
    if ("error" in patch) {
      setError(patch.error)
      throw new Error(patch.error)
    }
    if (patch.lines.length === 0) return
    await saveLines(patch.lines)
    setEdits({})
    setReason(null)
  }

  /** Aplicar o quitar una promoción: se guarda en el momento, línea por línea. */
  const runPromotion = async (key: string, body: AdjustBudgetLineBody) => {
    setError(null)
    setPending(key)
    try {
      await saveLines([body])
      dropPriceEdits([body.planItemId])
    } catch (err) {
      setError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const submitDiscount = async () => {
    const text = discountPercent.trim()
    const percent = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      setDiscountError("Escribe un porcentaje del 1 al 100.")
      return
    }
    const motive = discountReason.trim()
    if (!motive) {
      setDiscountError("Escribe el motivo del descuento.")
      return
    }
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
      setDiscountError(
        "Ningún tratamiento admite el descuento: todos tienen una promoción o les falta el precio.",
      )
      return
    }
    setDiscountError(null)
    setPending("discount")
    try {
      await saveLines(discounted)
      dropPriceEdits(discounted.map((line) => line.planItemId))
      setReason(null)
      setDiscountOpen(false)
    } catch (err) {
      setDiscountError(mutationMessage(err))
    } finally {
      setPending(null)
    }
  }

  const note = sessionExplanation(lines, money)

  return (
    <>
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
            const edit = edits[line.planItemId] ?? {}
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
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]">
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
                          setError(null)
                          setPending(`drop:${line.planItemId}`)
                          removeItems([line.planItemId])
                            .then(() =>
                              setEdits((current) => {
                                const { [line.planItemId]: _gone, ...rest } = current
                                return rest
                              }),
                            )
                            .catch((err: unknown) => setError(mutationMessage(err)))
                            .finally(() => setPending(null))
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
                  ) : (
                    <Input
                      aria-label={priceLabel}
                      inputMode="decimal"
                      autoComplete="off"
                      className="w-28 justify-self-end text-right font-semibold tabular-nums"
                      disabled={blocked}
                      value={edit.price ?? inputValue(line.priceCents, line.currency)}
                      onChange={(event) =>
                        setEdit(line.planItemId, { price: event.currentTarget.value })
                      }
                    />
                  )}
                </div>

                {session ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <FieldLabel
                      htmlFor={`${uid}-visits-${line.id}`}
                      className="text-sm text-muted-foreground"
                    >
                      Visitas previstas
                    </FieldLabel>
                    <Input
                      id={`${uid}-visits-${line.id}`}
                      inputMode="numeric"
                      autoComplete="off"
                      className="w-16 text-center font-semibold tabular-nums"
                      disabled={blocked}
                      value={
                        edit.sessions ??
                        (line.sessionsPlanned == null ? "" : String(line.sessionsPlanned))
                      }
                      onChange={(event) =>
                        setEdit(line.planItemId, { sessions: event.currentTarget.value })
                      }
                    />
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
                          void runPromotion(`remove:${line.planItemId}`, {
                            planItemId: line.planItemId,
                            optionId: option.id,
                            promotionId: null,
                          })
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
                            void runPromotion(
                              key,
                              item.mode === "fixed"
                                ? { planItemId: line.planItemId, optionId: option.id, promotionId: promo.id }
                                : {
                                    planItemId: line.planItemId,
                                    optionId: option.id,
                                    promotionId: promo.id,
                                    // Con «desde», el precio editable empieza en el mínimo anunciado.
                                    promotionFinalPriceCents: item.priceCents,
                                  },
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
                  setError(null)
                  setPending(`add:${item.id}`)
                  addItems([item.id])
                    .catch((err: unknown) => setError(mutationMessage(err)))
                    .finally(() => setPending(null))
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
            onClick={() => {
              setDiscountPercent("")
              setDiscountReason(reasonText)
              setDiscountError(null)
              setDiscountOpen(true)
            }}
          >
            Aplicar un descuento a todo
          </Button>
          <Field>
            <FieldLabel htmlFor={`${uid}-reason`}>Motivo del ajuste de precio</FieldLabel>
            <Input
              id={`${uid}-reason`}
              value={reasonText}
              maxLength={500}
              disabled={blocked}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            <FieldDescription>Se pide solo cuando un precio baja del precio normal.</FieldDescription>
          </Field>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {actionAlert}

      <div className="flex flex-wrap items-start gap-2 border-t pt-4">
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
          pending={pending === "save"}
          disabled={blocked || !dirty}
          onClick={() => void handleSave()}
        >
          Guardar borrador
        </SubmitButton>
        {secondaryActions}
      </div>

      {discountOpen ? (
        <FormDrawer
          open={discountOpen}
          title="Aplicar un descuento a todo"
          description="Baja el mismo porcentaje a cada tratamiento, calculado sobre su precio normal. Los que tienen una promoción no cambian."
          error={discountError}
          isSubmitting={pending === "discount"}
          submitLabel="Aplicar descuento"
          onClose={() => {
            if (pending !== "discount") setDiscountOpen(false)
          }}
          onSubmit={(event) => {
            event.preventDefault()
            void submitDiscount()
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${uid}-discount-percent`}>Descuento, en porcentaje</FieldLabel>
              <Input
                id={`${uid}-discount-percent`}
                inputMode="numeric"
                autoComplete="off"
                value={discountPercent}
                onChange={(event) => setDiscountPercent(event.currentTarget.value)}
              />
              <FieldDescription>Un número del 1 al 100.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${uid}-discount-reason`}>Motivo del descuento</FieldLabel>
              <Input
                id={`${uid}-discount-reason`}
                value={discountReason}
                maxLength={500}
                onChange={(event) => setDiscountReason(event.currentTarget.value)}
              />
              <FieldDescription>Queda anotado en cada tratamiento que baja.</FieldDescription>
            </Field>
          </FieldGroup>
        </FormDrawer>
      ) : null}
    </>
  )
}
