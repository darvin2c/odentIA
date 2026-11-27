import {
  Badge,
  Button,
  cn,
  FieldGroup,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  DatePickerButton,
  FormDrawer,
  RadioChips,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Minus, Plus, Trash2, TriangleAlert } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { axesOf, type DraftPromotion, sameText } from "../lib/ficha"
import { currencySymbol, type DeliveryMethod, money, moneyInput, readMoney } from "../lib/tienda"
import { useFichaContext } from "./contexto"
import { FieldProblem, Fold, Section, useTyped } from "./piezas"

/**
 * Precio y ofertas de Sofi (prototipo `ficha/precio-card.tsx`): el precio, el mínimo, el costo y
 * el margen en vivo (solo con `costos.ver`), lo que Sofi puede ofrecer, el precio por cantidad,
 * por mayor y las promociones con fecha de todo el producto, de un color o de una talla, y el
 * simulador. Lo que cobraría Sofi lo calcula el servidor (`POST /simular`, la misma cuenta de los
 * pedidos): aquí no se rehace.
 */

/** Un monto que se escribe en la ficha y se guarda solo: queda lo escrito mientras no se lea. */
export function Amount({
  cents,
  onChange,
  id,
  label,
  disabled,
  placeholder,
  className,
  invalid,
}: {
  cents: number | null
  onChange: (cents: number | null) => void
  id?: string
  label?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  invalid?: boolean
}) {
  const { store } = useFichaContext()
  const [text, setText] = useTyped(
    cents,
    (v) => (v === null ? "" : moneyInput(v, store.currency)),
    (t) => (t.trim() ? readMoney(t, store.currency) : null),
  )
  return (
    <InputGroup className={cn("w-full", className)}>
      <InputGroupAddon className="text-muted-foreground">
        {currencySymbol(store.currency)}
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        className="tabular-nums"
        value={text}
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9.,]/g, "")
          setText(next)
          if (next.trim() === "") onChange(null)
          else {
            const value = readMoney(next, store.currency)
            if (value !== null && value > 0) onChange(value)
          }
        }}
      />
    </InputGroup>
  )
}

/** Un número entero que se escribe en la ficha. */
export function Count({
  value,
  onChange,
  label,
  disabled,
  className,
  min = 1,
}: {
  value: number | null
  onChange: (n: number | null) => void
  label: string
  disabled?: boolean
  className?: string
  min?: number
}) {
  const [text, setText] = useTyped(
    value,
    (v) => (v === null ? "" : String(v)),
    (t) => (t ? Number(t) : null),
  )
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      disabled={disabled}
      value={text}
      className={cn("h-8 w-16 text-center tabular-nums", className)}
      onChange={(e) => {
        const next = e.target.value.replace(/\D/g, "").slice(0, 5)
        setText(next)
        if (!next) onChange(null)
        else if (Number(next) >= min) onChange(Number(next))
      }}
    />
  )
}

/** La barra del margen: del costo al mínimo se gana seguro; del mínimo al precio, lo que Sofi cede. */
function MarginBar({ cost, min, list }: { cost: number; min: number | null; list: number }) {
  const { store, unitOne } = useFichaContext()
  const fmt = (cents: number) => money(cents, store.currency)
  const max = Math.max(list, cost, min ?? 0) * 1.04 || 1
  const pc = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`
  const m = min ?? list
  const loss = min !== null && min < cost
  const gain = list - cost
  const pct = list ? Math.round((gain / list) * 100) : 0
  const from = Math.max(m, loss ? cost : m)
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 bg-foreground/18 motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: pc(Math.min(cost, list)) }}
        />
        {!loss ? (
          <span
            className="absolute inset-y-0 bg-success/70 motion-safe:transition-[left,width] motion-safe:duration-500"
            style={{ left: pc(cost), width: `calc(${pc(m)} - ${pc(cost)})` }}
          />
        ) : (
          <span
            className="absolute inset-y-0 bg-destructive/60 motion-safe:transition-[left,width] motion-safe:duration-500"
            style={{ left: pc(m), width: `calc(${pc(cost)} - ${pc(m)})` }}
          />
        )}
        {min !== null ? (
          <span
            className="rayas absolute inset-y-0 motion-safe:transition-[left,width] motion-safe:duration-500"
            style={{ left: pc(from), width: `calc(${pc(list)} - ${pc(from)})` }}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-foreground/20" aria-hidden />
          Costo <b className="font-semibold text-foreground tabular-nums">{fmt(cost)}</b>
        </span>
        {min !== null && !loss ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-success/70" aria-hidden />
            Ganas seguro{" "}
            <b className="font-semibold text-foreground tabular-nums">{fmt(min - cost)}</b>
          </span>
        ) : null}
        {min !== null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="rayas size-2.5 rounded-sm" aria-hidden />
            Sofi puede ceder{" "}
            <b className="font-semibold text-foreground tabular-nums">{fmt(list - from)}</b>
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5">
          Precio <b className="font-semibold text-foreground tabular-nums">{fmt(list)}</b>
        </span>
      </div>
      <p className="text-sm">
        {loss ? (
          <span className="inline-flex items-start gap-1.5 text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            El mínimo está {fmt(cost - (min ?? 0))} por debajo del costo: si Sofi baja hasta ahí,
            vende a pérdida.
          </span>
        ) : (
          <>
            Ganas <b className="tabular-nums">{fmt(gain)}</b> por {unitOne} a precio de lista ({pct}{" "}
            %).{" "}
            {min !== null ? (
              <span className="text-muted-foreground">
                Sofi puede ceder hasta{" "}
                <b className="text-foreground tabular-nums">{fmt(list - min)}</b>; en el mínimo aún
                ganas {fmt(min - cost)}.
              </span>
            ) : (
              <span className="text-muted-foreground">Sin mínimo, Sofi no negocia.</span>
            )}
          </>
        )}
      </p>
    </div>
  )
}

function Stepper({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (n: number) => void
  label: string
}) {
  return (
    <fieldset
      className="m-0 inline-flex h-9 min-w-0 items-center rounded-full border border-input-border bg-input/50 p-0"
      aria-label={label}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full"
        aria-label="Menos"
        disabled={value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        <Minus aria-hidden />
      </Button>
      <span className="w-7 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full"
        aria-label="Más"
        disabled={value >= 1000}
        onClick={() => onChange(Math.min(1000, value + 1))}
      >
        <Plus aria-hidden />
      </Button>
    </fieldset>
  )
}

/** «Hoy» de la tienda, en su zona horaria (ADR 0222). */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date())
}

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-")
  const months = [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "set",
    "oct",
    "nov",
    "dic",
  ]
  return `${Number(d)} ${months[Number(m) - 1] ?? ""}`
}

/** Una promoción nueva, de todo el producto, de un color o de una talla. */
function NewPromotion({ onClose }: { onClose: () => void }) {
  const { draft, store, change, rubro } = useFichaContext()
  const today = todayIn(store.timeZone)
  const grid = draft.grid
  const rowLabel = grid?.rowName ?? rubro?.rowLabel ?? "Color"
  const columnLabel = grid?.columnName ?? rubro?.columnLabel ?? "Talla"
  const scopes = [
    { value: "todo", label: "Todo el producto" },
    ...(grid?.rowName
      ? grid.rows.map((r) => ({ value: `rows:${r.value}`, label: `${rowLabel} ${r.value}` }))
      : []),
    ...(grid?.columnName
      ? grid.columns.map((c) => ({
          value: `columns:${c.value}`,
          label: `${columnLabel} ${c.value}`,
        }))
      : []),
  ]
  const form = useAppForm({
    defaultValues: { name: "", percentOff: "10", startsOn: today, endsOn: "", scope: "todo" },
    validators: {
      onSubmit: z
        .object({
          name: z.string().trim().min(1, "Escribe el nombre, como «Cyber»"),
          percentOff: z.string().refine((v) => Number(v) >= 1 && Number(v) <= 90, "De 1 a 90 %"),
          startsOn: z.string().min(1, "Elige desde qué día"),
          endsOn: z.string().min(1, "Elige hasta qué día"),
          scope: z.string(),
        })
        .refine((v) => !v.endsOn || v.endsOn >= v.startsOn, {
          message: "Termina antes de empezar",
          path: ["endsOn"],
        }),
    },
    onSubmit: async ({ value }) => {
      const [axis, ...rest] = value.scope.split(":")
      const scope: DraftPromotion["scope"] =
        value.scope === "todo"
          ? null
          : { axis: axis as "rows" | "columns", index: -1, value: rest.join(":") }
      change(`Promoción «${value.name.trim()}»`, (d) => {
        d.promotions.push({
          name: value.name.trim(),
          percentOff: Number(value.percentOff),
          startsOn: value.startsOn,
          endsOn: value.endsOn,
          scope,
        })
      })
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Nueva promoción"
      description="Un porcentaje menos entre dos fechas. No se suma con otra: a cada variante le toca la mejor."
      onClose={onClose}
      submitLabel="Agregar la promoción"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField label="Nombre" maxLength={60} placeholder="Cyber" autoFocus />
          )}
        </form.AppField>
        <form.AppField name="percentOff">
          {(field) => (
            <field.TextField label="Cuánto menos (%)" inputMode="numeric" maxLength={2} />
          )}
        </form.AppField>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="startsOn">
            {(field) => (
              <field.Control label="Desde">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.Subscribe selector={(s) => s.values.startsOn}>
            {(startsOn) => (
              <form.AppField name="endsOn">
                {(field) => (
                  <field.Control label="Hasta">
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        value={field.state.value}
                        min={startsOn || undefined}
                        onChange={field.handleChange}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            )}
          </form.Subscribe>
        </div>
        <form.AppField name="scope">
          {(field) => (
            <field.Group
              legend="De qué"
              description="De todo el producto, de un color o de una talla."
            >
              {() =>
                scopes.length <= 6 ? (
                  <RadioChips
                    aria-label="De qué"
                    value={field.state.value}
                    options={scopes}
                    onChange={(v) => field.handleChange(v ?? "todo")}
                  />
                ) : (
                  <Select
                    items={Object.fromEntries(scopes.map((s) => [s.value, s.label]))}
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(String(v ?? "todo"))}
                  >
                    <SelectTrigger className="w-full" aria-label="De qué">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scopes.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              }
            </field.Group>
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

interface Simulation {
  variantName: string
  quantity: number
  listUnitCents: number
  autoUnitCents: number
  reason: "lista" | "promocion" | "cantidad" | "mayor" | "combo"
  promotion: string | null
  floorUnitCents: number
  negotiable: boolean
  deliveryName: string | null
  deliveryListCents: number
  lowest: {
    subtotalCents: number
    deliveryCents: number
    deliveryFreeByPolicy: boolean
    totalCents: number
    discountCents: number
    giftCents: number
    marginUsedCents: number
  } | null
  problems: Record<string, string> | null
  costCents: number | null
  gainCents: number | null
}

const REASONS: Record<Simulation["reason"], string> = {
  lista: "precio de lista",
  promocion: "promoción",
  cantidad: "precio por cantidad",
  mayor: "por mayor",
  combo: "combo",
}

/** «Probar cuánto cobraría Sofi»: lo calcula el servidor con la misma regla de los pedidos. */
function Simulator() {
  const { sheet, store, costs, unit, unitOne, draft, rubro } = useFichaContext()
  const [quantity, setQuantity] = useState(1)
  const axes = axesOf(sheet)
  const rowValues = axes.rows === null ? [] : (sheet.options[axes.rows]?.values ?? [])
  const columnValues = axes.columns === null ? [] : (sheet.options[axes.columns]?.values ?? [])
  const [row, setRow] = useState(rowValues[0] ?? "")
  const [column, setColumn] = useState(columnValues[Math.floor(columnValues.length / 2)] ?? "")
  const [delivery, setDelivery] = useState("")
  const [zone, setZone] = useState("")
  const lists = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{ deliveries: DeliveryMethod[] }>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  const deliveries = (lists.data?.deliveries ?? []).filter(
    (d) => d.isActive && d.cost !== "se_acuerda",
  )
  const method = deliveries.find((d) => d.id === delivery)
  const variant = sheet.variants.find(
    (v) =>
      (axes.rows === null || sameText(v.optionValues[axes.rows] ?? "", row)) &&
      (axes.columns === null || sameText(v.optionValues[axes.columns] ?? "", column)),
  )
  const body = {
    ...(variant ? { variantId: variant.id } : {}),
    quantity,
    ...(method ? { deliveryMethodId: method.id } : {}),
    ...(method?.cost === "por_zona" ? { zone: zone || method.zones[0]?.name || null } : {}),
  }
  const sim = useQuery({
    queryKey: ["simular", store.id, sheet.id, sheet.updatedAt, body],
    queryFn: () =>
      api<Simulation>(`/api/tiendas/${store.id}/productos/${sheet.id}/simular`, {
        method: "POST",
        body,
      }),
    enabled: sheet.variants.length > 0,
    placeholderData: (previous) => previous,
  })
  const s = sim.data
  const fmt = (cents: number) => money(cents, store.currency)
  const rowLabel = draft.grid?.rowName ?? rubro?.rowLabel ?? "Color"
  const columnLabel = draft.grid?.columnName ?? rubro?.columnLabel ?? "Talla"
  return (
    <Fold
      id="simulador"
      title="Probar cuánto cobraría Sofi"
      summary={
        s?.lowest
          ? `${quantity} ${quantity === 1 ? unitOne : unit}${s.deliveryName ? ` · ${s.deliveryName}` : ""}: cobra desde ${fmt(s.lowest.totalCents)}`
          : "Elige cuántos y la entrega"
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5 text-sm font-medium">
          Cantidad
          <Stepper label="Cantidad" value={quantity} onChange={setQuantity} />
        </div>
        <div className="flex min-w-44 flex-1 flex-col gap-1.5 text-sm font-medium">
          Entrega
          <Select
            items={{
              "": "Sin envío",
              ...Object.fromEntries(deliveries.map((d) => [d.id, d.name])),
            }}
            value={delivery}
            onValueChange={(v) => {
              setDelivery(String(v ?? ""))
              setZone("")
            }}
          >
            <SelectTrigger className="w-full" aria-label="Entrega">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Sin envío</SelectItem>
              {deliveries.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {method?.cost === "por_zona" && method.zones.length ? (
          <div className="flex min-w-36 flex-col gap-1.5 text-sm font-medium">
            Zona
            <Select
              items={Object.fromEntries(
                method.zones.map((z) => [z.name, `${z.name} · ${fmt(z.priceCents)}`]),
              )}
              value={zone || method.zones[0]!.name}
              onValueChange={(v) => setZone(String(v ?? ""))}
            >
              <SelectTrigger className="w-full" aria-label="Zona">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {method.zones.map((z) => (
                  <SelectItem key={z.name} value={z.name}>
                    {z.name} · {fmt(z.priceCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {rowValues.length > 1 ? (
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            {rowLabel}
            <Select
              items={Object.fromEntries(rowValues.map((v) => [v, v]))}
              value={row}
              onValueChange={(v) => setRow(String(v ?? ""))}
            >
              <SelectTrigger className="w-32" aria-label={rowLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rowValues.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {columnValues.length > 1 ? (
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            {columnLabel}
            <Select
              items={Object.fromEntries(columnValues.map((v) => [v, v]))}
              value={column}
              onValueChange={(v) => setColumn(String(v ?? ""))}
            >
              <SelectTrigger className="w-24" aria-label={columnLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {columnValues.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {sim.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {sim.error.message}
        </p>
      ) : null}
      {s ? (
        <dl
          className={cn(
            "grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-xl bg-surface-muted p-3 text-sm",
            sim.isFetching && "opacity-70",
          )}
          aria-live="polite"
        >
          <dt className="text-muted-foreground">
            Precio sin negociar (
            {s.reason === "promocion" && s.promotion
              ? `promoción «${s.promotion}»`
              : REASONS[s.reason]}
            )
          </dt>
          <dd className="text-right tabular-nums">{fmt(s.autoUnitCents * s.quantity)}</dd>
          {s.deliveryName ? (
            <>
              <dt className="text-muted-foreground">Envío: {s.deliveryName}</dt>
              <dd className="text-right tabular-nums">
                {s.lowest?.deliveryFreeByPolicy ? "Gratis" : fmt(s.deliveryListCents)}
              </dd>
            </>
          ) : null}
          {s.lowest && s.lowest.marginUsedCents > 0 ? (
            <>
              <dt className="text-muted-foreground">Lo más que puede ceder, del margen</dt>
              <dd className="text-right tabular-nums">−{fmt(s.lowest.marginUsedCents)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">Lo menos que cobra Sofi</dt>
          <dd className="text-right font-semibold tabular-nums">
            {s.lowest ? fmt(s.lowest.totalCents) : "—"}
          </dd>
          {costs && s.gainCents !== null ? (
            <>
              <dt className="text-muted-foreground">Ganas, en el peor caso</dt>
              <dd
                className={cn(
                  "text-right font-medium tabular-nums",
                  s.gainCents < 0 ? "text-destructive" : "text-success",
                )}
              >
                {fmt(s.gainCents)}
              </dd>
            </>
          ) : null}
          {!s.negotiable ? (
            <dd className="col-span-2 text-xs text-muted-foreground">
              A este precio no negocia: no hay margen sobre el mínimo.
            </dd>
          ) : null}
          {s.problems ? (
            <dd className="col-span-2 text-xs text-destructive">{Object.values(s.problems)[0]}</dd>
          ) : null}
        </dl>
      ) : sim.isPending && sheet.variants.length ? (
        <p className="text-sm text-muted-foreground">Calculando…</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Con lo guardado de la ficha. Lo que cambies se ve aquí al guardarse.
      </p>
    </Fold>
  )
}

export function PriceCard() {
  const { draft, sheet, store, edit, costs, change, errors, unit, rubro } = useFichaContext()
  const listId = useId()
  const [adding, setAdding] = useState(false)
  const today = todayIn(store.timeZone)
  const fmt = (cents: number) => money(cents, store.currency)
  const active = draft.promotions.filter((p) => p.startsOn <= today && p.endsOn >= today).length
  const tiers = draft.quantityPrices.length + (draft.wholesale ? 1 : 0)
  const cost = costs ? sheet.lastCostCents : null
  const rowLabel = draft.grid?.rowName ?? rubro?.rowLabel ?? "Color"
  const columnLabel = draft.grid?.columnName ?? rubro?.columnLabel ?? "Talla"
  const settled = draft.status?.kind === "liquidacion"
  return (
    <Section
      id="precio"
      title="Precio y ofertas de Sofi"
      summary={`${fmt(draft.listPriceCents)}${draft.minPriceCents !== null ? ` · baja hasta ${fmt(draft.minPriceCents)}` : " · no negocia"}`}
      contains={["campo-minimo", "ofertas", "promos", "simulador"]}
    >
      <div className={cn("grid gap-3", costs ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={listId} className="text-sm font-medium">
            Precio
          </label>
          <Amount
            id={listId}
            cents={draft.listPriceCents}
            disabled={!edit}
            invalid={!!errors.listPriceCents}
            onChange={(v) =>
              v !== null &&
              change("Cambiaste el precio", (d) => (d.listPriceCents = v), { group: "precio" })
            }
          />
          <FieldProblem message={errors.listPriceCents} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="campo-minimo" className="text-sm font-medium">
            Mínimo
          </label>
          <Amount
            id="campo-minimo"
            cents={settled ? draft.listPriceCents : draft.minPriceCents}
            placeholder="No negocia"
            disabled={!edit || settled}
            invalid={!!errors.minPriceCents}
            onChange={(v) =>
              change("Cambiaste el mínimo", (d) => (d.minPriceCents = v), { group: "minimo" })
            }
          />
          <FieldProblem message={errors.minPriceCents} />
          {settled ? (
            <p className="text-xs text-muted-foreground">En liquidación el precio es el final.</p>
          ) : null}
        </div>
        {costs ? (
          <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
            <span className="text-sm font-medium">Costo</span>
            <div className="flex h-9 items-center justify-between rounded-3xl bg-muted px-3 text-sm">
              <span className="tabular-nums">{cost !== null ? fmt(cost) : "Sin costo"}</span>
              <span className="text-xs text-muted-foreground">el de la última entrada</span>
            </div>
          </div>
        ) : null}
      </div>

      {costs && cost !== null ? (
        <MarginBar
          cost={cost}
          min={settled ? draft.listPriceCents : draft.minPriceCents}
          list={draft.listPriceCents}
        />
      ) : null}

      <div id="ofertas" className="flex scroll-mt-24 flex-col gap-1 rounded-xl">
        <span className="text-sm font-semibold">Lo que Sofi puede ofrecer</span>
        <span className="text-sm text-muted-foreground">
          Una sola vez por conversación, del mismo margen y si paga a una hora exacta.
        </span>
        <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {(
            [
              ["delivery", "Envío gratis"],
              ["discount", "Unos soles de menos"],
              ["secondUnit", "Precio en la 2.ª unidad"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex min-h-10 items-center justify-between gap-3 text-sm">
              <label htmlFor={`oferta-${key}`}>{label}</label>
              <Switch
                id={`oferta-${key}`}
                checked={draft.offers[key]}
                disabled={!edit}
                onCheckedChange={(on) =>
                  change(`${label}: ${on ? "sí" : "no"}`, (d) => (d.offers[key] = on))
                }
              />
            </div>
          ))}
          <div className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <label htmlFor="oferta-regalo">Un regalo</label>
            <Input
              id="oferta-regalo"
              value={draft.offers.gift ?? ""}
              disabled={!edit}
              maxLength={80}
              placeholder="Ej.: medias"
              className="h-8 w-40"
              onChange={(e) =>
                change("Cambiaste el regalo", (d) => (d.offers.gift = e.target.value || null), {
                  group: "regalo",
                })
              }
            />
          </div>
        </div>
        <FieldProblem message={errors.offers ?? errors["offers.gift"]} />
      </div>

      <Fold
        id="promos"
        title="Precio por cantidad y promociones"
        summary={`${tiers} por cantidad · ${active} ${active === 1 ? "promoción activa" : "promociones activas"}`}
      >
        <div className="flex flex-col divide-y rounded-xl border">
          {draft.quantityPrices.length === 0 && !draft.wholesale ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Ninguno. Quien lleva más puede pagar menos por {unit}.
            </p>
          ) : null}
          {draft.quantityPrices.map((tier, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: el orden es su identidad
            <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="w-24 text-muted-foreground">Desde</span>
              <Count
                label="Desde cuántos"
                value={tier.minQuantity}
                min={2}
                disabled={!edit}
                onChange={(n) =>
                  n !== null &&
                  change(
                    "Cambiaste un precio por cantidad",
                    (d) => (d.quantityPrices[i]!.minQuantity = n),
                    {
                      group: `tier-d-${i}`,
                    },
                  )
                }
              />
              <span className="text-muted-foreground">a</span>
              <Amount
                className="w-28"
                label="Precio por cantidad"
                cents={tier.unitPriceCents}
                disabled={!edit}
                onChange={(v) =>
                  v !== null &&
                  change(
                    "Cambiaste un precio por cantidad",
                    (d) => (d.quantityPrices[i]!.unitPriceCents = v),
                    {
                      group: `tier-p-${i}`,
                    },
                  )
                }
              />
              <span className="ml-auto text-xs text-muted-foreground">c/u</span>
              {edit ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Quitar este precio por cantidad"
                  onClick={() =>
                    change("Quitaste un precio por cantidad", (d) => d.quantityPrices.splice(i, 1))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          {draft.wholesale ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="w-24 text-muted-foreground">Por mayor</span>
              <Count
                label="Por mayor desde"
                value={draft.wholesale.minQuantity}
                min={2}
                disabled={!edit}
                onChange={(n) =>
                  n !== null &&
                  change("Cambiaste el por mayor", (d) => (d.wholesale!.minQuantity = n), {
                    group: "mayor-d",
                  })
                }
              />
              <span className="text-muted-foreground">a</span>
              <Amount
                className="w-28"
                label="Precio por mayor"
                cents={draft.wholesale.unitPriceCents}
                disabled={!edit}
                onChange={(v) =>
                  v !== null &&
                  change("Cambiaste el por mayor", (d) => (d.wholesale!.unitPriceCents = v), {
                    group: "mayor-p",
                  })
                }
              />
              <span className="ml-auto text-xs text-muted-foreground">c/u, revendedoras</span>
              {edit ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Quitar el precio por mayor"
                  onClick={() =>
                    change("Quitaste el precio por mayor", (d) => (d.wholesale = null))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <FieldProblem
          message={
            errors.quantityPrices ??
            Object.entries(errors).find(([k]) => k.startsWith("quantityPrices."))?.[1] ??
            errors.wholesale ??
            Object.entries(errors).find(([k]) => k.startsWith("wholesale."))?.[1]
          }
        />
        {edit ? (
          <div className="flex flex-wrap gap-1">
            {draft.quantityPrices.length < 5 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  change("Agregaste un precio por cantidad", (d) => {
                    const from = (d.quantityPrices.at(-1)?.minQuantity ?? 1) + 1
                    d.quantityPrices.push({
                      minQuantity: from,
                      unitPriceCents: Math.max(1, Math.round(d.listPriceCents * 0.9)),
                    })
                  })
                }
              >
                <Plus aria-hidden />
                Precio por cantidad
              </Button>
            ) : null}
            {!draft.wholesale ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  change("Agregaste el precio por mayor", (d) => {
                    d.wholesale = {
                      minQuantity: 6,
                      unitPriceCents: Math.max(1, Math.round(d.listPriceCents * 0.8)),
                    }
                  })
                }
              >
                <Plus aria-hidden />
                Por mayor
              </Button>
            ) : null}
          </div>
        ) : null}

        <span className="mt-2 text-sm font-semibold">Promociones con fecha</span>
        <div className="flex flex-col divide-y rounded-xl border">
          {draft.promotions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Ninguna. Una promoción baja el precio solo entre sus fechas.
            </p>
          ) : null}
          {draft.promotions.map((promo, i) => {
            const on = promo.startsOn <= today && promo.endsOn >= today
            const past = promo.endsOn < today
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: el orden es su identidad
              <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <span className="font-medium">{promo.name}</span>
                <Badge variant={on ? "success" : "outline"}>
                  {on ? "Activa" : past ? "Terminó" : "Programada"}
                </Badge>
                <span className="text-muted-foreground">
                  −{promo.percentOff} % ·{" "}
                  {promo.scope
                    ? `${promo.scope.axis === "rows" ? rowLabel : columnLabel} ${promo.scope.value}`
                    : "todo"}{" "}
                  · {shortDate(promo.startsOn)} al {shortDate(promo.endsOn)}
                </span>
                {edit ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label={`Quitar ${promo.name}`}
                    onClick={() =>
                      change(`Quitaste «${promo.name}»`, (d) => d.promotions.splice(i, 1))
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
        <FieldProblem
          message={
            errors.promotions ??
            Object.entries(errors).find(([k]) => k.startsWith("promotions."))?.[1]
          }
        />
        {edit && draft.promotions.length < 10 ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Promoción
          </Button>
        ) : null}
      </Fold>

      <Simulator />
      {adding ? <NewPromotion onClose={() => setAdding(false)} /> : null}
    </Section>
  )
}
