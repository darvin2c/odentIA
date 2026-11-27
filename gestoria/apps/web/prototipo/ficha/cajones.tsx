import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Kbd,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@odentia/ui"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@odentia/ui/components/command"
import { DetailDrawer, RadioChips } from "@odentia/ui-patterns"
import { Check, CheckCheck, Search } from "lucide-react"
import { useState } from "react"
import { type Dato, foto, type Producto, type Rubro } from "../datos"
import { basePrice, key, money, priceSpan, totalStock } from "../precio"
import type { Cambio } from "../tienda"
import { irA, Swatch } from "./piezas"

/* ---------- Kardex ---------- */
export function KardexDrawer({
  p,
  saved,
  R,
  open,
  onClose,
}: {
  p: Producto
  saved: Producto | undefined
  R: Rubro
  open: boolean
  onClose: () => void
}) {
  const pend = saved
    ? p.colors.flatMap((c) =>
        p.sizes
          .map((z) => [z, (p.stock[key(c.id, z)] ?? 0) - (saved.stock[key(c.id, z)] ?? 0)] as const)
          .filter(([, d]) => d !== 0)
          .map(([z, d]) => ({
            fecha: "Sin guardar",
            tipo: "Ajuste",
            que: `${c.name} ${z}`,
            d,
            pend: true,
          })),
      )
    : []
  const rows = [
    ...pend,
    {
      fecha: "26 nov",
      tipo: "Venta",
      que: `Pedido 0147 · ${p.colors[1]?.name ?? p.colors[0]?.name} ${p.sizes[4] ?? ""}`,
      d: -1,
    },
    {
      fecha: "24 nov",
      tipo: "Venta",
      que: `Pedido 0139 · ${p.colors[0]?.name} ${p.sizes[3] ?? ""}`,
      d: -1,
    },
    ...p.costos.map((c) => ({
      fecha: c.fecha,
      tipo: "Entrada",
      que: `${c.cant} ${R.unit} a ${money(c.costo)}`,
      d: c.cant,
    })),
  ]
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title="Kardex"
      description={`${p.name} · quedan ${totalStock(p)} ${R.unit}`}
      size="lg"
    >
      <p className="text-sm text-muted-foreground">
        El stock solo cambia con un movimiento. Un ajuste a mano pide su motivo al guardar.
      </p>
      <ol className="flex flex-col divide-y rounded-xl border">
        {rows.map((r, i) => (
          <li
            key={`${r.fecha}${i}`}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 text-sm",
              "pend" in r && "bg-primary-soft/40",
            )}
          >
            <span className="w-20 shrink-0 text-muted-foreground">{r.fecha}</span>
            <Badge
              variant={r.tipo === "Entrada" ? "success" : r.tipo === "Venta" ? "secondary" : "soft"}
            >
              {r.tipo}
            </Badge>
            <span className="min-w-0 flex-1 truncate">{r.que}</span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                r.d > 0 ? "text-success" : "text-foreground",
              )}
            >
              {r.d > 0 ? "+" : ""}
              {r.d}
            </span>
          </li>
        ))}
      </ol>
    </DetailDrawer>
  )
}

/* ---------- Historial ---------- */
export function HistoryDrawer({
  items,
  open,
  onClose,
  pendientes,
}: {
  items: Cambio[]
  open: boolean
  onClose: () => void
  pendientes: string[]
}) {
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title="Quién cambió qué"
      description="Cada cambio guardado, con quién y cuándo. Lo de la IA, aceptado por una persona."
      size="lg"
    >
      {pendientes.length ? (
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed p-3 text-sm">
          <span className="font-semibold">Sin guardar todavía</span>
          {pendientes.map((x) => (
            <span key={x} className="text-muted-foreground">
              {x}
            </span>
          ))}
        </div>
      ) : null}
      <ol className="relative flex flex-col gap-4 pl-5 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px before:bg-border">
        {items.map((c, i) => (
          <li key={`${c.when}${i}`} className="relative flex flex-col text-sm">
            <span
              className={cn(
                "absolute top-1.5 -left-5 size-[11px] rounded-full border-2 border-card",
                c.ia ? "bg-primary" : c.rol === "Tú" ? "bg-success" : "bg-muted-foreground/50",
              )}
              aria-hidden
            />
            <span>{c.what}</span>
            <span className="text-xs text-muted-foreground">
              {c.who} · {c.rol} · {c.when}
            </span>
          </li>
        ))}
      </ol>
    </DetailDrawer>
  )
}

/* ---------- Buscar en la ficha ( / ) ---------- */
export function SearchDialog({
  p,
  R,
  tpl,
  open,
  onClose,
}: {
  p: Producto
  R: Rubro
  tpl: Dato[]
  open: boolean
  onClose: () => void
}) {
  const grupos: [string, [string, string][]][] = [
    [
      "Producto",
      [
        ["Fotos y videos", "fotos"],
        ["Nombre", "texto"],
        ["Descripción para vender", "texto"],
        ["Variantes", "variantes"],
        ["Stock por variante", "stock"],
      ],
    ],
    [
      "Precio y Sofi",
      [
        ["Precio", "precio"],
        ["Mínimo", "campo-minimo"],
        ["Lo que Sofi puede ofrecer", "ofertas"],
        ["Precio por cantidad y promociones", "promos"],
        ["Probar cuánto cobraría Sofi", "simulador"],
      ],
    ],
    [
      `Datos de ${R.label.toLowerCase()}`,
      [
        ...tpl.map((d) => [d.label, `dato-${d.id}`] as [string, string]),
        ["Preguntas respondidas", "preguntas"],
      ],
    ],
    [
      "Al costado",
      [
        ["Estado", "estado"],
        ["Catálogo web", "web"],
        ["Categoría y cómo la buscan", "organizacion"],
        ["Inventario y kardex", "inventario"],
        ["Paquete para la agencia", "paquete"],
        ["Venta cruzada", "cruzada"],
        ["Quién cambió qué", "actividad"],
      ],
    ],
  ]
  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Buscar en la ficha"
      description={`Ir a un campo de ${p.name}`}
    >
      <Command>
        <CommandInput placeholder="Buscar en la ficha: precio, material, talla…" />
        <CommandList>
          <CommandEmpty>Nada con ese nombre en esta ficha.</CommandEmpty>
          {grupos.map(([g, items]) => (
            <CommandGroup key={g} heading={g}>
              {items.map(([label, target]) => (
                <CommandItem
                  key={label}
                  value={`${label} ${g}`}
                  onSelect={() => {
                    onClose()
                    setTimeout(() => irA(target), 120)
                  }}
                >
                  <Search className="text-muted-foreground" aria-hidden />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          <CommandGroup heading={R.row}>
            {p.colors.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.name} color`}
                onSelect={() => {
                  onClose()
                  setTimeout(() => irA("variantes"), 120)
                }}
              >
                <Swatch color={c} />
                {c.name} · {priceSpan({ ...p, colors: [c] })}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/* ---------- Atajos ---------- */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string[], string][] = [
    [["G"], "Guardar los cambios"],
    [["/"], "Buscar en la ficha"],
    [["S"], "Abrir o cerrar Sofi"],
    [["P"], "Vista previa"],
    [["Ctrl", "Z"], "Deshacer"],
    [["Ctrl", "Mayús", "Z"], "Rehacer"],
    [["Ctrl", "V"], "Pegar fotos"],
    [["?"], "Ver los atajos"],
  ]
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>Funcionan cuando no estás escribiendo en un campo.</DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2.5 text-sm">
          {rows.map(([keys, what]) => (
            <div key={what} className="flex items-center justify-between gap-3">
              <dt>{what}</dt>
              <dd className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- El motivo de un ajuste de stock ---------- */
export function StockReasonDialog({
  open,
  n,
  onClose,
  onSave,
}: {
  open: boolean
  n: number
  onClose: () => void
  onSave: (motivo: string) => void
}) {
  const [v, setV] = useState<string | null>(null)
  const [otro, setOtro] = useState("")
  const [err, setErr] = useState(false)
  const opts = ["Entró mercadería", "Conté y corregí", "Se dañó o se perdió", "Otro"]
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const motivo = v === "Otro" ? otro.trim() : v
            if (!motivo) return setErr(true)
            onSave(motivo)
          }}
        >
          <DialogHeader>
            <DialogTitle>¿Por qué cambia el stock?</DialogTitle>
            <DialogDescription>
              Cambiaste {n} {n === 1 ? "variante" : "variantes"}. Queda en el kardex con tu nombre.
            </DialogDescription>
          </DialogHeader>
          <RadioChips
            aria-label="Motivo"
            value={v}
            invalid={err && !v}
            options={opts.map((o) => ({ value: o, label: o }))}
            onChange={(o) => {
              setV(o)
              setErr(false)
            }}
          />
          {v === "Otro" ? (
            <Textarea
              autoFocus
              rows={2}
              placeholder="Cuéntalo en pocas palabras"
              value={otro}
              onChange={(e) => setOtro(e.target.value)}
              aria-label="Otro motivo"
            />
          ) : null}
          {err ? (
            <p className="text-sm text-destructive">Elige un motivo para guardar el ajuste.</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">
              <Check aria-hidden />
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
