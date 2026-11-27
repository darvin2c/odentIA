import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
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
import { ChevronDown, Minus, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react"
import { type ReactNode, useEffect, useId, useState } from "react"
import { DISTRITOS, HOY, nid, type Producto, type Rubro } from "../datos"
import { lastCost, money, proposeTier, readNum, simulate } from "../precio"
import { cambiar } from "../tienda"
import { Propuesto, Seccion } from "./piezas"

export function MoneyInput({
  value,
  onChange,
  label,
  id,
  disabled,
  className,
  placeholder,
}: {
  value: number | null
  onChange: (v: number | null) => void
  label?: string
  id?: string
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  const [text, setText] = useState(value == null ? "" : String(value).replace(".", ","))
  useEffect(() => {
    if (readNum(text) !== value) setText(value == null ? "" : String(value).replace(".", ","))
  }, [value])
  return (
    <InputGroup className={cn("w-full", className)}>
      <InputGroupAddon className="text-muted-foreground">S/</InputGroupAddon>
      <InputGroupInput
        id={id}
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        className="tabular-nums"
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.,]/g, "")
          setText(t)
          const n = readNum(t)
          if (t.trim() === "") onChange(null)
          else if (n != null) onChange(n)
        }}
      />
    </InputGroup>
  )
}

/** La barra del margen: del costo al mínimo es lo que ganas seguro; del mínimo al precio, lo que Sofi puede ceder. */
function MarginBar({
  cost,
  min,
  list,
  unit,
}: {
  cost: number
  min: number | null
  list: number
  unit: string
}) {
  const max = Math.max(list, cost, min ?? 0) * 1.04 || 1
  const pc = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`
  const m = min ?? list
  const loss = min != null && min < cost
  const gan = list - cost
  const pct = list ? Math.round((gan / list) * 100) : 0
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 bg-foreground/18 transition-[width] duration-500 ease-out"
          style={{ width: pc(Math.min(cost, list)) }}
        />
        {!loss ? (
          <span
            className="absolute inset-y-0 bg-success/70 transition-[left,width] duration-500 ease-out"
            style={{ left: pc(cost), width: `calc(${pc(m)} - ${pc(cost)})` }}
          />
        ) : (
          <span
            className="absolute inset-y-0 bg-destructive/60 transition-[left,width] duration-500 ease-out"
            style={{ left: pc(m), width: `calc(${pc(cost)} - ${pc(m)})` }}
          />
        )}
        {min != null ? (
          <span
            className="rayas absolute inset-y-0 transition-[left,width] duration-500 ease-out"
            style={{
              left: pc(Math.max(m, loss ? cost : m)),
              width: `calc(${pc(list)} - ${pc(Math.max(m, loss ? cost : m))})`,
            }}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-foreground/20" aria-hidden />
          Costo <b className="font-semibold text-foreground tabular-nums">{money(cost)}</b>
        </span>
        {min != null && !loss ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-success/70" aria-hidden />
            Ganas seguro{" "}
            <b className="font-semibold text-foreground tabular-nums">{money(min - cost)}</b>
          </span>
        ) : null}
        {min != null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="rayas size-2.5 rounded-sm" aria-hidden />
            Sofi puede ceder{" "}
            <b className="font-semibold text-foreground tabular-nums">
              {money(list - Math.max(min, loss ? cost : min))}
            </b>
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5">
          Precio <b className="font-semibold text-foreground tabular-nums">{money(list)}</b>
        </span>
      </div>
      <p className="text-sm">
        {loss ? (
          <span className="inline-flex items-start gap-1.5 text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            El mínimo está {money(cost - (min ?? 0))} por debajo del costo: al bajar tanto, Sofi
            vendería a pérdida.
          </span>
        ) : (
          <>
            Ganas <b className="tabular-nums">{money(gan)}</b> por {unit} a precio de lista ({pct}{" "}
            %).{" "}
            {min != null ? (
              <span className="text-muted-foreground">
                Sofi puede ceder hasta{" "}
                <b className="text-foreground tabular-nums">{money(list - min)}</b>; en el mínimo
                aún ganas {money(min - cost)}.
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

function Plegable({
  title,
  summary,
  children,
  id,
  defaultOpen,
}: {
  title: string
  summary: ReactNode
  children: ReactNode
  id?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<string>).detail
      if (id && (t === id || t.startsWith(id))) setOpen(true)
    }
    window.addEventListener("ficha:abrir", onOpen)
    return () => window.removeEventListener("ficha:abrir", onOpen)
  }, [id])
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<div id={id} className="scroll-mt-24 border-t pt-1" />}
    >
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{title}</span>
          {!open ? <span className="truncate text-sm text-muted-foreground">{summary}</span> : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-3 pt-1 pb-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const fecha = (iso: string) => {
  const [, m, d] = iso.split("-")
  const mes = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"][
    Number(m) - 1
  ]
  return `${Number(d)} ${mes}`
}

function Stepper({
  value,
  onChange,
  min = 1,
  label,
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  label: string
}) {
  return (
    <div
      className="inline-flex h-9 items-center rounded-full border border-input-border bg-input/50"
      role="group"
      aria-label={label}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full"
        aria-label="Menos"
        onClick={() => onChange(Math.max(min, value - 1))}
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
        onClick={() => onChange(value + 1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  )
}

export function PriceCard({
  p,
  edit,
  costos,
  R,
}: {
  p: Producto
  edit: boolean
  costos: boolean
  R: Rubro
}) {
  const listId = useId()
  const minId = "campo-minimo"
  const cost = lastCost(p)
  const set = (label: string, fn: (x: Producto) => void, group?: string) =>
    cambiar(p.id, label, fn, { group, toast: !group })
  const [sim, setSim] = useState({
    qty: 1,
    dist: 0,
    color: p.colors[0]?.id,
    size: p.sizes[Math.floor(p.sizes.length / 2)],
  })
  const s = simulate(p, sim)
  const tierAi = p.ai.tier === null ? null : (p.ai.tier ?? proposeTier(p))
  const promoAi = p.ai.promo
  const activas = p.promos.filter((x) => x.desde <= HOY && x.hasta >= HOY).length
  const propuestas = (tierAi ? 1 : 0) + (promoAi ? 1 : 0)

  return (
    <Seccion
      id="precio"
      title="Precio y ofertas de Sofi"
      summary={`${money(p.list)}${p.min != null ? ` · baja hasta ${money(p.min)}` : " · no negocia"}`}
      contains={["campo-minimo", "ofertas", "promos", "simulador"]}
    >
      <div className={cn("grid gap-3", costos ? "grid-cols-3" : "grid-cols-2")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={listId} className="text-sm font-medium">
            Precio
          </label>
          <MoneyInput
            id={listId}
            value={p.list}
            disabled={!edit}
            onChange={(v) => v != null && set("Cambiaste el precio", (x) => (x.list = v), "precio")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={minId} className="text-sm font-medium">
            Mínimo
          </label>
          <MoneyInput
            id={minId}
            value={p.min}
            placeholder="No negocia"
            disabled={!edit}
            onChange={(v) => set("Cambiaste el mínimo", (x) => (x.min = v), "minimo")}
          />
        </div>
        {costos ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Costo</span>
            <div className="flex h-9 items-center justify-between rounded-3xl bg-muted px-3 text-sm">
              <span className="tabular-nums">{money(cost)}</span>
              <span className="text-xs text-muted-foreground">{p.costos[0]?.fecha}</span>
            </div>
          </div>
        ) : null}
      </div>

      {costos && cost != null ? (
        <MarginBar cost={cost} min={p.min} list={p.list} unit={R.unitOne} />
      ) : null}

      <div id="ofertas" className="flex scroll-mt-24 flex-col gap-1 rounded-xl">
        <span className="text-sm font-semibold">Lo que Sofi puede ofrecer</span>
        <span className="text-sm text-muted-foreground">
          Una sola vez por conversación, del mismo margen y si paga a una hora exacta.
        </span>
        <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {(
            [
              ["envio", "Envío gratis"],
              ["soles", "Unos soles de menos"],
              ["dosx", "Precio en la 2.ª unidad"],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="flex min-h-10 items-center justify-between gap-3 text-sm">
              {l}
              <Switch
                checked={p.ofertas[k]}
                disabled={!edit}
                onCheckedChange={(v) => set(`${l}: ${v ? "sí" : "no"}`, (x) => (x.ofertas[k] = v))}
              />
            </label>
          ))}
          <label className="flex min-h-10 items-center justify-between gap-3 text-sm">
            Un regalo
            <Input
              value={p.ofertas.regalo}
              disabled={!edit}
              placeholder="Ej.: medias"
              className="h-8 w-40"
              onChange={(e) =>
                set("Cambiaste el regalo", (x) => (x.ofertas.regalo = e.target.value), "regalo")
              }
            />
          </label>
        </div>
      </div>

      <Plegable
        id="promos"
        title="Precio por cantidad y promociones"
        summary={
          <>
            {p.tiers.length + (p.mayor ? 1 : 0)} por cantidad · {activas}{" "}
            {activas === 1 ? "promoción activa" : "promociones activas"}
            {propuestas && edit ? (
              <span className="text-primary">
                {" "}
                · <Sparkles className="inline size-3.5 align-[-2px]" aria-hidden /> {propuestas}{" "}
                {propuestas === 1 ? "propuesta" : "propuestas"}
              </span>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col divide-y rounded-xl border">
          {p.tiers.map((t, i) => (
            <div key={`t${i}`} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="w-24 text-muted-foreground">Desde</span>
              <Input
                aria-label="Desde cuántos"
                inputMode="numeric"
                disabled={!edit}
                value={String(t.desde)}
                className="h-8 w-16 text-center"
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  if (n > 0)
                    set(
                      "Cambiaste un precio por cantidad",
                      (x) => (x.tiers[i]!.desde = n),
                      `tier-d-${i}`,
                    )
                }}
              />
              <span className="text-muted-foreground">a</span>
              <MoneyInput
                className="w-28"
                label="Precio por cantidad"
                value={t.precio}
                disabled={!edit}
                onChange={(v) =>
                  v != null &&
                  set(
                    "Cambiaste un precio por cantidad",
                    (x) => (x.tiers[i]!.precio = v),
                    `tier-p-${i}`,
                  )
                }
              />
              <span className="ml-auto text-xs text-muted-foreground">c/u</span>
              {edit ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Quitar"
                  onClick={() =>
                    set("Quitaste un precio por cantidad", (x) => x.tiers.splice(i, 1))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          {p.mayor ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="w-24 text-muted-foreground">Por mayor</span>
              <Input
                aria-label="Por mayor desde"
                inputMode="numeric"
                disabled={!edit}
                value={String(p.mayor.desde)}
                className="h-8 w-16 text-center"
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  if (n > 0) set("Cambiaste el por mayor", (x) => (x.mayor!.desde = n), "mayor-d")
                }}
              />
              <span className="text-muted-foreground">a</span>
              <MoneyInput
                className="w-28"
                label="Precio por mayor"
                value={p.mayor.precio}
                disabled={!edit}
                onChange={(v) =>
                  v != null &&
                  set("Cambiaste el por mayor", (x) => (x.mayor!.precio = v), "mayor-p")
                }
              />
              <span className="ml-auto text-xs text-muted-foreground">c/u</span>
            </div>
          ) : null}
          {tierAi && edit ? (
            <div className="propuesta entra flex items-center gap-2 rounded-b-xl border-0 px-3 py-2 text-sm">
              <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Desde <b>{tierAi.desde}</b> a <b>{money(tierAi.precio)}</b>
                {cost != null ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · deja {Math.round(((tierAi.precio - cost) / tierAi.precio) * 100)} % de margen
                  </span>
                ) : null}
              </span>
              <span className="ml-auto">
                <Propuesto
                  porque={`Quien compra ${tierAi.desde} o más suele pedir rebaja. Con ${money(tierAi.precio)} cada uno sigues sobre tu mínimo${cost != null ? ` y ganas ${money(tierAi.precio - cost)} por ${R.unitOne}` : ""}.`}
                  onAccept={() =>
                    set(`Desde ${tierAi.desde} a ${money(tierAi.precio)}`, (x) => {
                      x.tiers = [...x.tiers, { desde: tierAi.desde, precio: tierAi.precio }].sort(
                        (a, b) => a.desde - b.desde,
                      )
                      x.ai.tier = null
                    })
                  }
                  onDiscard={() => set("Descartaste la propuesta", (x) => (x.ai.tier = null))}
                />
              </span>
            </div>
          ) : null}
        </div>
        {edit ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              set("Agregaste un precio por cantidad", (x) =>
                x.tiers.push({ desde: (x.tiers.at(-1)?.desde ?? 1) + 1, precio: x.list }),
              )
            }
          >
            <Plus aria-hidden />
            Precio por cantidad
          </Button>
        ) : null}

        <span className="mt-2 text-sm font-semibold">Promociones con fecha</span>
        <div className="flex flex-col divide-y rounded-xl border">
          {p.promos.length === 0 && !promoAi ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Ninguna. Una promoción baja el precio solo entre sus fechas.
            </p>
          ) : null}
          {p.promos.map((x) => {
            const on = x.desde <= HOY && x.hasta >= HOY
            return (
              <div key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <span className="font-medium">{x.nombre}</span>
                <Badge variant={on ? "success" : "outline"}>{on ? "Activa" : "Programada"}</Badge>
                <span className="text-muted-foreground">
                  −{x.pct} % ·{" "}
                  {x.alcance.startsWith("col:")
                    ? `${R.col} ${x.alcance.slice(4)}`
                    : x.alcance.startsWith("row:")
                      ? `${p.colors.find((c) => c.id === x.alcance.slice(4))?.name ?? ""}`
                      : "todo"}{" "}
                  · {fecha(x.desde)} al {fecha(x.hasta)}
                </span>
                {edit ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label={`Quitar ${x.nombre}`}
                    onClick={() =>
                      set(
                        `Quitaste «${x.nombre}»`,
                        (y) => (y.promos = y.promos.filter((z) => z.id !== x.id)),
                      )
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
            )
          })}
          {promoAi && edit ? (
            <div className="propuesta entra flex flex-wrap items-center gap-2 rounded-b-xl border-0 px-3 py-2.5 text-sm">
              <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="font-medium">{promoAi.nombre}</span>
              <span className="text-muted-foreground">
                −{promoAi.pct} % · {fecha(promoAi.desde)} al {fecha(promoAi.hasta)}
              </span>
              <span className="ml-auto">
                <Propuesto
                  porque={promoAi.porque}
                  onAccept={() =>
                    set(`Promoción «${promoAi.nombre}»`, (y) => {
                      const { porque: _p, ...promo } = promoAi
                      y.promos.push({ ...promo, id: nid("pr") })
                      y.ai.promo = undefined
                    })
                  }
                  onDiscard={() =>
                    set("Descartaste la promoción propuesta", (y) => (y.ai.promo = undefined))
                  }
                />
              </span>
            </div>
          ) : null}
        </div>
      </Plegable>

      <Plegable
        id="simulador"
        title="Probar cuánto cobraría Sofi"
        summary={`${sim.qty} ${sim.qty === 1 ? R.unitOne : R.unit} a ${s.distrito}: cobra desde ${money(s.minPaid)}`}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            Cantidad
            <Stepper label="Cantidad" value={sim.qty} onChange={(qty) => setSim({ ...sim, qty })} />
          </div>
          <div className="flex min-w-44 flex-1 flex-col gap-1.5 text-sm font-medium">
            Entrega
            <Select
              items={Object.fromEntries(DISTRITOS.map(([d], i) => [String(i), d]))}
              value={String(sim.dist)}
              onValueChange={(v) => setSim({ ...sim, dist: Number(v) })}
            >
              <SelectTrigger className="w-full" aria-label="Entrega">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISTRITOS.map(([d, c], i) => (
                  <SelectItem key={d} value={String(i)}>
                    {d} · {c ? money(c) : "gratis"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {p.colors.length > 1 ? (
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              {R.row}
              <Select
                items={Object.fromEntries(p.colors.map((c) => [c.id, c.name]))}
                value={sim.color}
                onValueChange={(v) => setSim({ ...sim, color: String(v) })}
              >
                <SelectTrigger className="w-32" aria-label={R.row}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {p.colors.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-xl bg-surface-muted p-3 text-sm">
          <dt className="text-muted-foreground">Precio sin negociar ({s.why})</dt>
          <dd className="text-right tabular-nums">{money(s.auto * s.qty)}</dd>
          <dt className="text-muted-foreground">Envío a {s.distrito}</dt>
          <dd className="text-right tabular-nums">
            {s.gratis ? "Gratis desde S/ 250" : money(s.envio)}
          </dd>
          {s.absorbe ? (
            <>
              <dt className="text-muted-foreground">Puede regalar el envío, del margen</dt>
              <dd className="text-right tabular-nums">−{money(s.absorbe)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">Lo menos que cobra Sofi</dt>
          <dd className="text-right font-semibold tabular-nums">{money(s.minPaid)}</dd>
          {costos && s.gan != null ? (
            <>
              <dt className="text-muted-foreground">Ganas, en el peor caso</dt>
              <dd
                className={cn(
                  "text-right font-medium tabular-nums",
                  s.gan < 0 ? "text-destructive" : "text-success",
                )}
              >
                {money(s.gan)}
              </dd>
            </>
          ) : null}
        </dl>
      </Plegable>
    </Seccion>
  )
}
