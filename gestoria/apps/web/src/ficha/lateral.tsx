import {
  Badge,
  Button,
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
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { DatePickerButton } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Copy, Plus, X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { CategoryOptions, useCatalog } from "../catalogo"
import { api } from "../lib/api"
import {
  cellKey,
  FIELD_NAMES,
  type HistoryEvent,
  readNumber,
  type SaleState,
  STATES,
  type StatusDraft,
} from "../lib/ficha"
import { LINK_DOMAIN } from "../lib/marca"
import { when } from "../lib/pedidos"
import { money } from "../lib/tienda"
import { Photo } from "../piezas"
import { useFichaContext } from "./contexto"
import { FieldProblem, Section, useTyped } from "./piezas"
import { Count, todayIn } from "./precio"

/**
 * La columna del costado de la ficha (prototipo `ficha/lateral.tsx`): el estado, el catálogo web,
 * la organización y los códigos, el inventario con su kardex, el paquete para la agencia, la venta
 * cruzada y quién cambió qué.
 */

export const STATE_TONES: Record<SaleState, "success" | "outline" | "warning"> = {
  disponible: "success",
  agotado: "outline",
  encargo: "warning",
  cupo: "warning",
  preventa: "warning",
  liquidacion: "warning",
  no_se_vende: "outline",
}

/** El estado que se ve: el que pone la tienda o, si no, el que sale del stock. */
export function stateOf(status: StatusDraft, stock: number): SaleState {
  return status?.kind ?? (stock > 0 ? "disponible" : "agotado")
}

export function StateBadge({ state, className }: { state: SaleState; className?: string }) {
  const tone = STATE_TONES[state]
  return (
    <Badge variant={tone} className={className}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "success"
            ? "bg-success"
            : tone === "warning"
              ? "bg-warning"
              : "bg-muted-foreground",
        )}
        aria-hidden
      />
      {STATES[state].label}
    </Badge>
  )
}

const STATUS_CHOICES = [
  "stock",
  "encargo",
  "cupo",
  "preventa",
  "liquidacion",
  "no_se_vende",
] as const

export function StatusCard({ stock }: { stock: number }) {
  const { draft, edit, change, store, errors } = useFichaContext()
  const state = stateOf(draft.status, stock)
  const status = draft.status
  const fromStock = stock > 0 ? "disponible" : "agotado"
  const phrase = STATES[state].sofi
    .replace("{dias}", status?.kind === "encargo" ? String(status.days) : "…")
    .replace("{cupo}", status?.kind === "cupo" ? String(status.perDay) : "…")
    .replace("{fecha}", status?.kind === "preventa" ? status.date : "…")
  const labels: Record<(typeof STATUS_CHOICES)[number], string> = {
    stock: `${STATES[fromStock].label} (según el stock)`,
    encargo: STATES.encargo.label,
    cupo: STATES.cupo.label,
    preventa: STATES.preventa.label,
    liquidacion: STATES.liquidacion.label,
    no_se_vende: STATES.no_se_vende.label,
  }
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
  return (
    <Section id="estado" title="Estado" side summary={STATES[state].label}>
      <Select
        items={labels}
        value={status?.kind ?? "stock"}
        disabled={!edit}
        onValueChange={(v) =>
          change(`Estado: ${labels[(v ?? "stock") as keyof typeof labels].toLowerCase()}`, (d) => {
            const kind = v ?? "stock"
            d.status =
              kind === "encargo"
                ? { kind, days: 3 }
                : kind === "cupo"
                  ? { kind, perDay: 5 }
                  : kind === "preventa"
                    ? { kind, date: inTwoWeeks }
                    : kind === "liquidacion" || kind === "no_se_vende"
                      ? { kind }
                      : null
          })
        }
      >
        <SelectTrigger className="w-full" aria-label="Estado del producto">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_CHOICES.map((choice) => {
            const tone = STATE_TONES[choice === "stock" ? fromStock : choice]
            return (
              <SelectItem key={choice} value={choice}>
                <span
                  className={cn(
                    "size-2 rounded-full",
                    tone === "success"
                      ? "bg-success"
                      : tone === "warning"
                        ? "bg-warning"
                        : "bg-muted-foreground",
                  )}
                  aria-hidden
                />
                {labels[choice]}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      {status?.kind === "encargo" || status?.kind === "cupo" ? (
        <div className="entra flex items-center justify-between gap-3 text-sm">
          {status.kind === "encargo" ? "Días para conseguirlo" : "Cuántos por día"}
          <Count
            label={status.kind === "encargo" ? "Días para conseguirlo" : "Cuántos por día"}
            className="w-20"
            value={status.kind === "encargo" ? status.days : status.perDay}
            disabled={!edit}
            onChange={(n) =>
              n !== null &&
              change(
                "Cambiaste el estado",
                (d) => {
                  if (d.status?.kind === "encargo") d.status.days = Math.min(365, n)
                  if (d.status?.kind === "cupo") d.status.perDay = Math.min(1000, n)
                },
                { group: "estado" },
              )
            }
          />
        </div>
      ) : null}
      {status?.kind === "preventa" ? (
        <div className="entra flex items-center justify-between gap-3 text-sm">
          <span id="llega-el">Llega el</span>
          <DatePickerButton
            aria-labelledby="llega-el"
            value={status.date}
            min={todayIn(store.timeZone)}
            disabled={!edit}
            onChange={(date) =>
              date &&
              change("Cambiaste el día que llega", (d) => {
                if (d.status?.kind === "preventa") d.status.date = date
              })
            }
          />
        </div>
      ) : null}
      <FieldProblem
        message={
          errors.status ?? Object.entries(errors).find(([k]) => k.startsWith("status."))?.[1]
        }
      />
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Sofi: </span>
        {phrase}
      </p>
    </Section>
  )
}

export function WebCard({ coverId }: { coverId: string | null }) {
  const { draft, edit, change, store, errors } = useFichaContext()
  const slugId = useId()
  const brand = useQuery({
    queryKey: ["marca", store.id],
    queryFn: () => api<{ brand: { link: string | null } }>(`/api/tiendas/${store.id}/marca`),
    enabled: edit,
    retry: false,
  })
  const link = brand.data?.brand.link
  const [slug, setSlug] = useState(draft.web.slug ?? "")
  useEffect(() => setSlug(draft.web.slug ?? ""), [draft.web.slug])
  const url = link && draft.web.slug ? `${link}${LINK_DOMAIN}/${draft.web.slug}` : null
  return (
    <Section
      id="web"
      title="Catálogo web"
      side
      summary={draft.web.visible ? "Se muestra" : "No se muestra"}
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        <label htmlFor={`${slugId}-web`}>Se muestra en tu catálogo</label>
        <Switch
          id={`${slugId}-web`}
          checked={draft.web.visible}
          disabled={!edit}
          onCheckedChange={(on) =>
            change(
              on ? "Se muestra en el catálogo" : "Ya no se muestra en el catálogo",
              (d) => (d.web.visible = on),
            )
          }
        />
      </div>
      {draft.web.visible ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={slugId} className="text-xs font-medium text-muted-foreground">
              Su nombre en el link
            </label>
            <Input
              id={slugId}
              value={slug}
              disabled={!edit}
              maxLength={80}
              placeholder="zapatilla-de-lona"
              aria-invalid={errors["web.slug"] || errors.web ? true : undefined}
              onChange={(e) => {
                const next = e.target.value
                  .normalize("NFD")
                  .replace(/[̀-ͯ]/g, "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+/, "")
                setSlug(next)
                const clean = next.replace(/-+$/, "")
                change("Cambiaste el nombre en el link", (d) => (d.web.slug = clean || null), {
                  group: "slug",
                })
              }}
            />
            <FieldProblem message={errors["web.slug"] ?? errors.web} />
          </div>
          {url ? (
            <div className="flex items-center gap-3 rounded-xl bg-surface-muted p-2">
              <Photo storeId={store.id} photoId={coverId} alt="" className="size-12" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{draft.name}</span>
                <span className="truncate text-xs text-muted-foreground">{url}</span>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copiar el enlace"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`https://${url}`)
                    .then(() => toast.success("Enlace copiado"))
                    .catch(() => toast.error("No se pudo copiar"))
                }}
              >
                <Copy aria-hidden />
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  )
}

export function OrganizationCard() {
  const { draft, edit, change, store, errors } = useFichaContext()
  const [word, setWord] = useState("")
  const categoryId = useId()
  const listId = useId()
  const codeId = useId()
  const [category, setCategory] = useState(draft.category ?? "")
  const [code, setCode] = useState(draft.code ?? "")
  useEffect(() => setCategory(draft.category ?? ""), [draft.category])
  useEffect(() => setCode(draft.code ?? ""), [draft.code])
  return (
    <Section
      id="organizacion"
      title="Organización"
      side
      summary={`${draft.category ?? "Sin categoría"} · ${draft.keywords.length} palabras`}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={categoryId} className="text-xs font-medium text-muted-foreground">
          Categoría
        </label>
        <Input
          id={categoryId}
          list={listId}
          value={category}
          maxLength={60}
          disabled={!edit}
          placeholder="Zapatillas"
          onChange={(e) => {
            setCategory(e.target.value)
            change("Cambiaste la categoría", (d) => (d.category = e.target.value.trim() || null), {
              group: "categoria",
            })
          }}
        />
        <CategoryOptions id={listId} storeId={store.id} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground" id="palabras">
          Cómo la buscan
        </span>
        {draft.keywords.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-labelledby="palabras">
            {draft.keywords.map((k) => (
              <li key={k}>
                <Badge
                  variant="secondary"
                  className="entra h-7 gap-1 rounded-full pr-1 pl-2.5 text-[13px]"
                >
                  {k}
                  {edit ? (
                    <button
                      type="button"
                      aria-label={`Quitar «${k}»`}
                      className="flex size-5 items-center justify-center rounded-full hover:bg-foreground/10"
                      onClick={() =>
                        change(
                          `Quitaste «${k}»`,
                          (d) => (d.keywords = d.keywords.filter((y) => y !== k)),
                        )
                      }
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Las palabras con que te piden este producto.
          </p>
        )}
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const w = word.trim()
              if (w && !draft.keywords.some((k) => k.toLowerCase() === w.toLowerCase()))
                change(`Agregaste «${w}»`, (d) => d.keywords.push(w))
              setWord("")
            }}
          >
            <Input
              value={word}
              maxLength={40}
              onChange={(e) => setWord(e.target.value)}
              placeholder="Otra palabra y Enter"
              className="h-8"
              aria-label="Agregar una palabra con que la buscan"
            />
          </form>
        ) : null}
        <FieldProblem
          message={
            errors.keywords ?? Object.entries(errors).find(([k]) => k.startsWith("keywords."))?.[1]
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={codeId} className="text-xs font-medium text-muted-foreground">
          Código del producto
        </label>
        <Input
          id={codeId}
          value={code}
          maxLength={40}
          disabled={!edit}
          placeholder="ZAP-URB"
          aria-invalid={errors.code ? true : undefined}
          onChange={(e) => {
            const next = e.target.value.replace(/\s/g, "")
            setCode(next)
            change("Cambiaste el código", (d) => (d.code = next || null), { group: "codigo" })
          }}
        />
        <FieldProblem message={errors.code} />
        <p className="text-xs text-muted-foreground">
          El código de barras de cada variante va en «Variantes», en «Código de barras».
        </p>
      </div>
    </Section>
  )
}

export function InventoryCard({ onKardex }: { onKardex: () => void }) {
  const { draft, unit } = useFichaContext()
  const grid = draft.grid
  const cells = grid
    ? grid.rows.flatMap((r) =>
        grid.columns.map((c) => ({
          name: [r.value, c.value].filter(Boolean).join(" ") || "Única",
          stock: grid.cells[cellKey(r.id, c.id)]?.stock ?? 0,
        })),
      )
    : []
  const total = cells.reduce((n, c) => n + c.stock, 0)
  const out = cells.filter((c) => c.stock === 0).map((c) => c.name)
  return (
    <Section
      id="inventario"
      title="Inventario"
      side
      summary={`${total} ${unit}${out.length ? ` · ${out.length} sin stock` : ""}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{total}</span>
        <span className="text-sm text-muted-foreground">
          {unit} en {cells.length} {cells.length === 1 ? "variante" : "variantes"}
        </span>
      </div>
      {out.length ? (
        <p className="text-sm">
          <span className="text-warning">Sin stock:</span> {out.slice(0, 4).join(", ")}
          {out.length > 4 ? ` y ${out.length - 4} más` : ""}
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-primary"
        onClick={onKardex}
      >
        Ver el kardex
        <ArrowRight aria-hidden />
      </Button>
    </Section>
  )
}

/** Un largo o un peso del paquete: se escribe en kg o cm y se guarda en gramos o milímetros. */
function Measure({
  label,
  unit,
  value,
  factor,
  onChange,
}: {
  label: string
  unit: string
  value: number | null
  factor: number
  onChange: (v: number | null) => void
}) {
  const { edit } = useFichaContext()
  const shown = (v: number | null) => (v === null ? "" : String(v / factor).replace(".", ","))
  const [text, setText] = useTyped(value, shown, (t) => {
    const n = readNumber(t)
    return n === null ? null : Math.round(n * factor)
  })
  const id = useId()
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      <InputGroup>
        <InputGroupInput
          id={id}
          inputMode="decimal"
          disabled={!edit}
          value={text}
          className="tabular-nums"
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.,]/g, "")
            setText(next)
            if (!next.trim()) onChange(null)
            else {
              const n = readNumber(next)
              if (n !== null && n > 0) onChange(Math.round(n * factor))
            }
          }}
        />
        <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function PackageCard() {
  const { draft, change, errors } = useFichaContext()
  const p = draft.package
  const set = (key: keyof typeof p, label: string) => (v: number | null) =>
    change(`Cambiaste ${label} del paquete`, (d) => (d.package[key] = v), {
      group: `paquete-${key}`,
    })
  const dims = [p.lengthMm, p.widthMm, p.heightMm]
  const partial = dims.some((v) => v !== null) && dims.some((v) => v === null)
  return (
    <Section
      id="paquete"
      title="Paquete para la agencia"
      side
      summary={
        p.weightG
          ? `${p.weightG / 1000} kg${p.lengthMm ? ` · ${p.lengthMm / 10} × ${(p.widthMm ?? 0) / 10} × ${(p.heightMm ?? 0) / 10} cm` : ""}`
          : "Sin peso ni medidas"
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <Measure
          label="Peso"
          unit="kg"
          factor={1000}
          value={p.weightG}
          onChange={set("weightG", "el peso")}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Measure
          label="Largo"
          unit="cm"
          factor={10}
          value={p.lengthMm}
          onChange={set("lengthMm", "el largo")}
        />
        <Measure
          label="Ancho"
          unit="cm"
          factor={10}
          value={p.widthMm}
          onChange={set("widthMm", "el ancho")}
        />
        <Measure
          label="Alto"
          unit="cm"
          factor={10}
          value={p.heightMm}
          onChange={set("heightMm", "el alto")}
        />
      </div>
      {partial ? (
        <p className="text-xs text-muted-foreground">
          Con el largo, el ancho y el alto se guardan las medidas.
        </p>
      ) : null}
      <FieldProblem
        message={
          partial
            ? undefined
            : (errors.package ??
              Object.entries(errors).find(([k]) => k.startsWith("package."))?.[1])
        }
      />
      <p className="text-xs text-muted-foreground">Solo si envías por agencia.</p>
    </Section>
  )
}

export function CrossSellCard() {
  const { draft, sheet, edit, change, store } = useFichaContext()
  const catalog = useCatalog(store.id)
  const others = (catalog.data?.products ?? []).filter((p) => p.id !== sheet.id)
  const linked = (kind: "combina" | "parecido") =>
    draft.links
      .filter((l) => l.kind === kind)
      .map(
        (l) =>
          others.find((o) => o.id === l.productId) ?? {
            id: l.productId,
            name: sheet.links.find((x) => x.productId === l.productId)?.name ?? "Producto",
            photoId: null,
            fromCents: 0,
            toCents: 0,
          },
      )
  const fmt = (from: number, to: number) =>
    from === to
      ? money(from, store.currency)
      : `${money(from, store.currency)} a ${money(to, store.currency)}`
  const row = (
    o: { id: string; name: string; photoId: string | null; fromCents: number; toCents: number },
    kind: "combina" | "parecido",
  ) => (
    <li key={`${kind}${o.id}`} className="flex items-center gap-3">
      <Photo storeId={store.id} photoId={o.photoId} alt="" className="size-10" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{o.name}</span>
        <span className="text-xs text-muted-foreground">
          {o.fromCents ? `${fmt(o.fromCents, o.toCents)} · ` : ""}
          {kind === "combina"
            ? draft.comboPercentOff
              ? `−${draft.comboPercentOff} % si lo lleva junto`
              : "Sofi lo ofrece junto"
            : "si busca algo más barato"}
        </span>
      </span>
      {edit ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Quitar ${o.name}`}
          onClick={() =>
            change(`Quitaste ${o.name}`, (d) => {
              d.links = d.links.filter((l) => !(l.productId === o.id && l.kind === kind))
            })
          }
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </li>
  )
  const add = (kind: "combina" | "parecido") => {
    const free = others.filter(
      (o) => !draft.links.some((l) => l.productId === o.id && l.kind === kind),
    )
    if (!edit || !free.length) return null
    return (
      <Select
        items={Object.fromEntries(free.map((o) => [o.id, o.name]))}
        value={null}
        onValueChange={(v) =>
          v &&
          change(`Agregaste ${free.find((o) => o.id === v)?.name ?? "un producto"}`, (d) => {
            d.links.push({ productId: String(v), kind })
          })
        }
      >
        <SelectTrigger
          size="sm"
          className="h-8 w-fit border-dashed"
          aria-label={kind === "combina" ? "Agregar algo que combina" : "Agregar algo más barato"}
        >
          <Plus className="size-3.5" aria-hidden />
          <SelectValue placeholder="Agregar" />
        </SelectTrigger>
        <SelectContent>
          {free.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name} · {money(o.fromCents, store.currency)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  const combos = linked("combina")
  const cheaper = linked("parecido")
  if (!others.length && !draft.links.length)
    return (
      <Section id="cruzada" title="Venta cruzada" side summary="Sin otros productos">
        <p className="text-sm text-muted-foreground">
          Con otro producto en el catálogo, Sofi puede ofrecerlo junto a este o como algo más
          barato.
        </p>
      </Section>
    )
  return (
    <Section
      id="cruzada"
      title="Venta cruzada"
      side
      summary={`Combina con ${combos.length} · más barato ${cheaper.length}`}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Combina con</span>
        {combos.length ? (
          <ul className="flex flex-col gap-2">{combos.map((o) => row(o, "combina"))}</ul>
        ) : null}
        {combos.length ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            Si lo lleva junto, menos
            <span className="flex items-center gap-1">
              <Count
                label="Porcentaje del combo"
                value={draft.comboPercentOff}
                disabled={!edit}
                className="w-14"
                onChange={(n) =>
                  change(
                    "Cambiaste el combo",
                    (d) => (d.comboPercentOff = n === null ? null : Math.min(90, n)),
                    {
                      group: "combo",
                    },
                  )
                }
              />
              %
            </span>
          </div>
        ) : null}
        {add("combina")}
      </div>
      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-xs font-medium text-muted-foreground">Algo más barato</span>
        {cheaper.length ? (
          <ul className="flex flex-col gap-2">{cheaper.map((o) => row(o, "parecido"))}</ul>
        ) : null}
        {add("parecido")}
      </div>
    </Section>
  )
}

/** Lo que dice el historial de un cambio, en una línea. */
export function eventLine(event: HistoryEvent, unit: string): string {
  if (event.action === "creado") return "Creó el producto"
  if (event.action === "cuadricula") {
    const parts: string[] = []
    for (const c of event.changes) {
      if (c.field === "stockIn") parts.push(`entraron ${c.to} ${unit}`)
      else if (c.field === "stockOut") parts.push(`bajó el stock ${c.to}`)
      else if (c.field === "variantsAdded") parts.push(`sumó ${c.to} variantes`)
      else if (c.field === "variantsRemoved") parts.push(`quitó ${c.to} variantes`)
      else if (c.field === "options") parts.push("cambió los colores o las tallas")
      else if (c.field.startsWith("price:")) parts.push(`cambió el precio de ${c.field.slice(6)}`)
    }
    return parts.length
      ? `${parts[0]![0]!.toUpperCase()}${parts.join(", ").slice(1)}`
      : "Cambió las variantes"
  }
  if (event.action === "pregunta") return "Guardó una respuesta en la ficha"
  const names = [...new Set(event.changes.map((c) => FIELD_NAMES[c.field] ?? "la ficha"))]
  return names.length
    ? `Cambió ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`
    : "Cambió la ficha"
}

export function useHistory(storeId: string, productId: string) {
  return useQuery({
    queryKey: ["historial", storeId, productId],
    queryFn: () =>
      api<{ events: HistoryEvent[] }>(`/api/tiendas/${storeId}/productos/${productId}/historial`),
  })
}

export function ActivityCard({ onAll }: { onAll: () => void }) {
  const { store, sheet, unit } = useFichaContext()
  const history = useHistory(store.id, sheet.id)
  const events = history.data?.events ?? []
  return (
    <Section
      id="actividad"
      title="Quién cambió qué"
      side
      summary={
        events[0]
          ? `${events[0].actorName ?? "Alguien"}: ${eventLine(events[0], unit)}`
          : "Sin cambios"
      }
    >
      {history.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {history.isError ? (
        <p className="text-sm text-destructive">No se pudo cargar el historial.</p>
      ) : null}
      {events.length ? (
        <ol className="flex flex-col gap-3">
          {events.slice(0, 3).map((e) => (
            <li key={e.id} className="flex gap-2.5 text-sm">
              <span
                className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40"
                aria-hidden
              />
              <span className="flex min-w-0 flex-col">
                <span className="leading-snug">{eventLine(e, unit)}</span>
                <span className="text-xs text-muted-foreground">
                  {e.actorName ?? "Alguien del equipo"} · {when(e.createdAt)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : history.data ? (
        <p className="text-sm text-muted-foreground">Todavía sin cambios.</p>
      ) : null}
      {events.length ? (
        <Button variant="ghost" size="sm" className="-ml-2 self-start text-primary" onClick={onAll}>
          Ver todo
          <ArrowRight aria-hidden />
        </Button>
      ) : null}
    </Section>
  )
}
