import {
  Badge,
  Button,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ArrowRight, Copy, Plus, Sparkles, X } from "lucide-react"
import { useState } from "react"
import { ESTADOS, type EstadoId, foto, type Producto, type Rubro } from "../datos"
import { key, money, priceSpan, totalStock } from "../precio"
import { type Cambio, cambiar } from "../tienda"
import { Seccion } from "./piezas"

const set = (p: Producto, label: string, fn: (x: Producto) => void, group?: string) =>
  cambiar(p.id, label, fn, { group, toast: !group })

export function StatusCard({ p, edit }: { p: Producto; edit: boolean }) {
  const e = ESTADOS.find((x) => x.id === p.estado)!
  const frase = e.sofi
    .replace("{dias}", p.estadoInfo.dias || "…")
    .replace("{cupo}", p.estadoInfo.cupo || "…")
    .replace("{fecha}", p.estadoInfo.fecha || "…")
  return (
    <Seccion id="estado" title="Estado" lateral summary={e.label}>
      <Select
        items={Object.fromEntries(ESTADOS.map((x) => [x.id, x.label]))}
        value={p.estado}
        disabled={!edit}
        onValueChange={(v) =>
          set(
            p,
            `Estado: ${ESTADOS.find((x) => x.id === v)?.label.toLowerCase()}`,
            (x) => (x.estado = v as EstadoId),
          )
        }
      >
        <SelectTrigger className="w-full" aria-label="Estado del producto">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ESTADOS.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              <span
                className={cn(
                  "size-2 rounded-full",
                  x.id === "disponible"
                    ? "bg-success"
                    : x.id === "agotado" || x.id === "no"
                      ? "bg-muted-foreground"
                      : "bg-warning",
                )}
                aria-hidden
              />
              {x.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {p.estado === "encargo" || p.estado === "cupo" || p.estado === "preventa" ? (
        <label className="entra flex items-center justify-between gap-3 text-sm">
          {p.estado === "encargo"
            ? "Días para conseguirlo"
            : p.estado === "cupo"
              ? "Cuántos por día"
              : "Llega el"}
          <Input
            className="h-8 w-28"
            disabled={!edit}
            placeholder={p.estado === "preventa" ? "15 dic" : "3"}
            value={
              (p.estado === "encargo"
                ? p.estadoInfo.dias
                : p.estado === "cupo"
                  ? p.estadoInfo.cupo
                  : p.estadoInfo.fecha) ?? ""
            }
            onChange={(ev) =>
              set(
                p,
                "Cambiaste el estado",
                (x) => {
                  const k = x.estado === "encargo" ? "dias" : x.estado === "cupo" ? "cupo" : "fecha"
                  x.estadoInfo[k] = ev.target.value
                },
                "estado-info",
              )
            }
          />
        </label>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Sofi: </span>
        {frase}
      </p>
    </Seccion>
  )
}

export function WebCard({ p, edit, R }: { p: Producto; edit: boolean; R: Rubro }) {
  const url = `${R.store.slug}.gestoria24.com/${p.web.slug || p.id}`
  const cover = p.media.find((m) => m.kind === "foto")
  return (
    <Seccion
      id="web"
      title="Catálogo web"
      lateral
      summary={p.web.visible ? "Se muestra" : "No se muestra"}
    >
      <label className="flex items-center justify-between gap-3 text-sm">
        Se muestra en tu catálogo
        <Switch
          checked={p.web.visible}
          disabled={!edit}
          onCheckedChange={(v) =>
            set(
              p,
              v ? "Se muestra en el catálogo" : "Ya no se muestra en el catálogo",
              (x) => (x.web.visible = v),
            )
          }
        />
      </label>
      {p.web.visible ? (
        <div className="flex items-center gap-3 rounded-xl bg-surface-muted p-2">
          {cover ? (
            <img src={foto(cover.src)} alt="" className="size-12 rounded-lg object-cover" />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{p.name}</span>
            <span className="truncate text-xs text-muted-foreground">{url}</span>
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copiar el enlace"
            onClick={() => {
              void navigator.clipboard?.writeText(`https://${url}`).catch(() => undefined)
              toast.success("Enlace copiado")
            }}
          >
            <Copy aria-hidden />
          </Button>
        </div>
      ) : null}
    </Seccion>
  )
}

export function OrganizationCard({
  p,
  edit,
  cats,
}: {
  p: Producto
  edit: boolean
  cats: string[]
}) {
  const [word, setWord] = useState("")
  const sugeridas = (p.ai.keywords ?? []).filter((k) => !p.keywords.includes(k))
  return (
    <Seccion
      id="organizacion"
      title="Organización"
      lateral
      summary={`${p.cat} · ${p.keywords.length} palabras`}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Categoría</span>
        <Select
          items={Object.fromEntries(cats.map((c) => [c, c]))}
          value={p.cat}
          disabled={!edit}
          onValueChange={(v) => set(p, `Categoría: ${v}`, (x) => (x.cat = String(v)))}
        >
          <SelectTrigger className="w-full" aria-label="Categoría">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cats.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground" id="palabras">
          Cómo la buscan
        </span>
        <div className="flex flex-wrap gap-1.5" aria-labelledby="palabras">
          {p.keywords.map((k) => (
            <Badge
              key={k}
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
                    set(
                      p,
                      `Quitaste «${k}»`,
                      (x) => (x.keywords = x.keywords.filter((y) => y !== k)),
                    )
                  }
                >
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </Badge>
          ))}
          {edit
            ? sugeridas.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="propuesta entra inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium text-primary-soft-foreground hover:bg-primary-soft"
                  onClick={() => set(p, `Agregaste «${k}»`, (x) => x.keywords.push(k))}
                  aria-label={`Agregar «${k}», propuesta de la IA`}
                >
                  <Sparkles className="size-3" aria-hidden />
                  {k}
                </button>
              ))
            : null}
        </div>
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const w = word.trim()
              if (w && !p.keywords.includes(w))
                set(p, `Agregaste «${w}»`, (x) => x.keywords.push(w))
              setWord("")
            }}
          >
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder="Otra palabra y Enter"
              className="h-8"
              aria-label="Agregar una palabra con que la buscan"
            />
          </form>
        ) : null}
      </div>
    </Seccion>
  )
}

export function InventoryCard({ p, R, onKardex }: { p: Producto; R: Rubro; onKardex: () => void }) {
  const total = totalStock(p)
  const sin = p.colors.flatMap((c) =>
    p.sizes.filter((z) => (p.stock[key(c.id, z)] ?? 0) === 0).map((z) => `${c.name} ${z}`),
  )
  return (
    <Seccion
      id="inventario"
      title="Inventario"
      lateral
      summary={`${total} ${R.unit}${sin.length ? ` · ${sin.length} sin stock` : ""}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{total}</span>
        <span className="text-sm text-muted-foreground">
          {R.unit} en {p.colors.length * p.sizes.length} variantes
        </span>
      </div>
      {sin.length ? (
        <p className="text-sm">
          <span className="text-warning">Sin stock:</span> {sin.slice(0, 4).join(", ")}
          {sin.length > 4 ? ` y ${sin.length - 4} más` : ""}
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
    </Seccion>
  )
}

export function PackageCard({ p, edit }: { p: Producto; edit: boolean }) {
  const f = (k: "peso" | "l" | "a" | "h", label: string, unit: string) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <span className="relative">
        <Input
          inputMode="decimal"
          disabled={!edit}
          value={p.paquete[k]}
          className="h-8 pr-8 tabular-nums"
          onChange={(e) =>
            set(p, "Cambiaste el paquete", (x) => (x.paquete[k] = e.target.value), `paq-${k}`)
          }
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs">
          {unit}
        </span>
      </span>
    </label>
  )
  return (
    <Seccion
      id="paquete"
      title="Paquete para la agencia"
      lateral
      summary={
        p.paquete.peso
          ? `${p.paquete.peso} kg · ${p.paquete.l} × ${p.paquete.a} × ${p.paquete.h} cm`
          : "Sin peso ni medidas"
      }
    >
      <div className="grid grid-cols-3 gap-2">{f("peso", "Peso", "kg")}</div>
      <div className="grid grid-cols-3 gap-2">
        {f("l", "Largo", "cm")}
        {f("a", "Ancho", "cm")}
        {f("h", "Alto", "cm")}
      </div>
    </Seccion>
  )
}

export function CrossSellCard({ p, edit, all }: { p: Producto; edit: boolean; all: Producto[] }) {
  const others = all.filter((x) => x.id !== p.id)
  const row = (id: string, kind: "con" | "parecido") => {
    const o = all.find((x) => x.id === id)
    if (!o) return null
    const m = o.media.find((x) => x.kind === "foto")
    return (
      <li key={`${kind}${id}`} className="flex items-center gap-3">
        {m ? <img src={foto(m.src)} alt="" className="size-10 rounded-lg object-cover" /> : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{o.name}</span>
          <span className="text-xs text-muted-foreground">
            {kind === "con"
              ? `${priceSpan(o)} · −${p.combo.pct || 10} % si lo lleva junto`
              : `${priceSpan(o)} · si busca algo más barato`}
          </span>
        </span>
        {edit ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Quitar ${o.name}`}
            onClick={() =>
              set(p, `Quitaste ${o.name}`, (x) => {
                if (kind === "con") x.combo.con = x.combo.con.filter((y) => y !== id)
                else x.parecido = x.parecido.filter((y) => y !== id)
              })
            }
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </li>
    )
  }
  const add = (kind: "con" | "parecido") => {
    const free = others.filter((o) => !p.combo.con.includes(o.id) && !p.parecido.includes(o.id))
    if (!edit || !free.length) return null
    return (
      <Select
        items={Object.fromEntries(free.map((o) => [o.id, o.name]))}
        value={null}
        onValueChange={(v) =>
          v &&
          set(p, "Agregaste venta cruzada", (x) => {
            if (kind === "con") x.combo.con.push(String(v))
            else x.parecido.push(String(v))
          })
        }
      >
        <SelectTrigger
          size="sm"
          className="h-8 w-fit border-dashed"
          aria-label={kind === "con" ? "Agregar algo que combina" : "Agregar algo más barato"}
        >
          <Plus className="size-3.5" aria-hidden />
          <SelectValue placeholder="Agregar" />
        </SelectTrigger>
        <SelectContent>
          {free.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name} · {money(o.list)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (!others.length)
    return (
      <Seccion id="cruzada" title="Venta cruzada" lateral summary="Sin otros productos">
        <p className="text-sm text-muted-foreground">
          Con otro producto en el catálogo, Sofi puede ofrecerlo junto a este o como algo más
          barato.
        </p>
      </Seccion>
    )
  return (
    <Seccion
      id="cruzada"
      title="Venta cruzada"
      lateral
      summary={`Combina con ${p.combo.con.length} · más barato ${p.parecido.length}`}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Combina con</span>
        <ul className="flex flex-col gap-2">{p.combo.con.map((id) => row(id, "con"))}</ul>
        {add("con")}
      </div>
      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-xs font-medium text-muted-foreground">Algo más barato</span>
        <ul className="flex flex-col gap-2">{p.parecido.map((id) => row(id, "parecido"))}</ul>
        {add("parecido")}
      </div>
    </Seccion>
  )
}

export function ActivityCard({ items, onAll }: { items: Cambio[]; onAll: () => void }) {
  return (
    <Seccion
      id="actividad"
      title="Quién cambió qué"
      lateral
      summary={items[0] ? `${items[0].who.split(" ")[0]}: ${items[0].what}` : "Sin cambios"}
    >
      <ol className="flex flex-col gap-3">
        {items.slice(0, 3).map((c, i) => (
          <li key={`${c.when}${i}`} className="entra flex gap-2.5 text-sm">
            <span
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                c.ia ? "bg-primary" : c.rol === "Tú" ? "bg-success" : "bg-muted-foreground/40",
              )}
              aria-hidden
            />
            <span className="flex min-w-0 flex-col">
              <span className="leading-snug">{c.what}</span>
              <span className="text-xs text-muted-foreground">
                {c.who} · {c.when}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <Button variant="ghost" size="sm" className="-ml-2 self-start text-primary" onClick={onAll}>
        Ver todo
        <ArrowRight aria-hidden />
      </Button>
    </Seccion>
  )
}
