import { toast } from "@odentia/ui"
import { useSyncExternalStore } from "react"
import { type Chat, type Dato, type Producto, type Rol, RUBROS, type RubroId } from "./datos"
import { key, money } from "./precio"

/**
 * El estado del prototipo, en memoria: lo guardado de cada producto, el borrador que se edita (que
 * se guarda solo en este navegador), deshacer y rehacer, y el historial de quién cambió qué.
 */

export interface Cambio {
  who: string
  rol: string
  when: string
  what: string
  ia?: boolean
}

interface RubroDb {
  products: Producto[]
  saved: Record<string, Producto>
  tpl: Dato[]
  chats: Chat[]
  historial: Record<string, Cambio[]>
  tocaDone: boolean
}

interface Paso {
  rubro: RubroId
  pid: string
  label: string
  before: Producto
  after: Producto
  group?: string
  at: number
}

interface Estado {
  rubro: RubroId
  rol: Rol
  db: Partial<Record<RubroId, RubroDb>>
  undo: Paso[]
  redo: Paso[]
  borradorAt: number | null
  version: number
}

const clone = <T>(v: T): T => structuredClone(v)
const LS = (r: RubroId) => `gestoria-prototipo:borrador:${r}`

function seedHistorial(r: RubroId, products: Producto[]): Record<string, Cambio[]> {
  const R = RUBROS[r]
  const h: Record<string, Cambio[]> = {}
  for (const p of products) {
    const c = p.costos[0]
    h[p.id] = [
      {
        who: R.store.ventas,
        rol: "Ventas",
        when: "26 nov, 16:40",
        what: `Vendió 1 ${R.unitOne} · Pedido 0147`,
      },
      {
        who: "IA",
        rol: "Propuesta",
        when: "21 nov, 10:12",
        what: `Propuso ${p.datos.material ? `el material «${String(p.datos.material)}»` : "los datos"} desde las fotos · lo aceptó ${R.store.owner.split(" ")[0]}`,
        ia: true,
      },
      {
        who: R.store.owner,
        rol: "Dueño",
        when: "20 nov, 18:02",
        what: `Cambió el precio de ${money(Math.round(p.list * 1.08))} a ${money(p.list)}`,
      },
      ...(c
        ? [
            {
              who: R.store.owner,
              rol: "Dueño",
              when: `${c.fecha}, 09:30`,
              what: `Entrada de ${c.cant} ${R.unit} a ${money(c.costo)} cada uno`,
            },
          ]
        : []),
    ]
  }
  return h
}

function freshDb(r: RubroId): RubroDb {
  const R = RUBROS[r]
  const products = R.products()
  const saved = Object.fromEntries(products.map((p) => [p.id, clone(p)]))
  let draft = products
  try {
    const raw = localStorage.getItem(LS(r))
    if (raw) {
      const parsed = JSON.parse(raw) as Producto[]
      if (Array.isArray(parsed) && parsed.length) draft = parsed
      // Lo nuevo de una sesión anterior, que no llegó a guardarse, vuelve como borrador.
      for (const p of draft) if (!saved[p.id]) saved[p.id] = clone(p)
    }
  } catch {
    /* sin almacenamiento: se empieza de cero */
  }
  return {
    products: draft,
    saved,
    tpl: R.datos.map((d) => ({ ...d })),
    chats: clone(R.chats),
    historial: seedHistorial(r, products),
    tocaDone: false,
  }
}

function readHash(): { rubro: RubroId; rol: Rol } {
  const m = /^#\/(\w+)/.exec(location.hash)
  const rubro = (m && m[1] in RUBROS ? m[1] : "calzado") as RubroId
  return { rubro, rol: location.hash.includes("ventas=1") ? "ventas" : "dueno" }
}

let S: Estado = { ...readHash(), db: {}, undo: [], redo: [], borradorAt: null, version: 0 }
const subs = new Set<() => void>()
function emit() {
  S = { ...S, version: S.version + 1 }
  for (const f of subs) f()
}
export function subscribe(f: () => void) {
  subs.add(f)
  return () => subs.delete(f)
}
export function useTienda<T>(sel: (s: Estado) => T): T {
  return useSyncExternalStore(subscribe, () => sel(S))
}
export const estado = () => S

export function db(r: RubroId = S.rubro): RubroDb {
  let d = S.db[r]
  if (!d) {
    d = freshDb(r)
    S.db[r] = d
  }
  return d
}
/** Cualquier cambio vuelve a pintar: el prototipo es chico y así nada queda viejo. */
export const useVersion = () => useTienda((s) => s.version)
export function useDb(): RubroDb {
  useVersion()
  return db()
}
export function useProducto(pid: string): Producto | undefined {
  useVersion()
  return db().products.find((p) => p.id === pid)
}

export function setRubro(r: RubroId) {
  S.rubro = r
  S.undo = []
  S.redo = []
  emit()
}
export function setRol(rol: Rol) {
  S.rol = rol
  emit()
}

/* ---------- borrador ---------- */
let saveTimer: ReturnType<typeof setTimeout> | undefined
function autosave() {
  clearTimeout(saveTimer)
  const r = S.rubro
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS(r), JSON.stringify(db(r).products))
    } catch {
      /* sin almacenamiento: el borrador vive solo en esta pestaña */
    }
    S.borradorAt = Date.now()
    emit()
  }, 500)
}

/* ---------- cambiar, deshacer, rehacer ---------- */
interface Opciones {
  /** Cambios seguidos del mismo grupo (escribir en un campo) son un solo paso. */
  group?: string
  /** Con aviso y «Deshacer»: las acciones de un toque. Al escribir, no. */
  toast?: boolean
}

export function cambiar(pid: string, label: string, fn: (p: Producto) => void, o: Opciones = {}) {
  const d = db()
  const i = d.products.findIndex((p) => p.id === pid)
  if (i < 0) return
  const before = d.products[i]!
  const after = clone(before)
  fn(after)
  d.products = d.products.map((p, j) => (j === i ? after : p))
  const last = S.undo.at(-1)
  const now = Date.now()
  if (o.group && last && last.group === o.group && last.pid === pid && now - last.at < 1600) {
    last.after = after
    last.at = now
  } else {
    S.undo = [
      ...S.undo.slice(-60),
      { rubro: S.rubro, pid, label, before, after, group: o.group, at: now },
    ]
  }
  S.redo = []
  autosave()
  emit()
  if (o.toast)
    toast(label, {
      id: "deshacer",
      duration: 5000,
      action: { label: "Deshacer", onClick: () => deshacer() },
    })
}

function aplicar(p: Paso, cual: "before" | "after") {
  const d = db(p.rubro)
  d.products = d.products.map((x) => (x.id === p.pid ? clone(p[cual]) : x))
  autosave()
}
export function deshacer() {
  const p = S.undo.at(-1)
  if (!p) return
  S.undo = S.undo.slice(0, -1)
  S.redo = [...S.redo, p]
  aplicar(p, "before")
  emit()
  toast(`Deshecho: ${lowerFirst(p.label)}`, {
    id: "deshacer",
    duration: 4000,
    action: { label: "Rehacer", onClick: () => rehacer() },
  })
}
export function rehacer() {
  const p = S.redo.at(-1)
  if (!p) return
  S.redo = S.redo.slice(0, -1)
  S.undo = [...S.undo, p]
  aplicar(p, "after")
  emit()
}
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/* ---------- lo que cambió ---------- */
export function diff(a: Producto | undefined, b: Producto): string[] {
  if (!a) return ["Producto nuevo"]
  const out: string[] = []
  if (a.name !== b.name) out.push(`Nombre: «${b.name}»`)
  if (a.texto !== b.texto) out.push("Descripción")
  if (a.list !== b.list) out.push(`Precio de ${money(a.list)} a ${money(b.list)}`)
  if (a.min !== b.min) out.push(`Mínimo de ${money(a.min)} a ${money(b.min)}`)
  if (a.estado !== b.estado) out.push("Estado")
  if (JSON.stringify(a.colors) !== JSON.stringify(b.colors)) out.push("Colores")
  if (a.sizes.join() !== b.sizes.join()) out.push("Tallas")
  if (JSON.stringify(a.media) !== JSON.stringify(b.media)) out.push("Fotos y videos")
  const st = stockCambiado(a, b)
  if (st) out.push(`Stock de ${st} ${st === 1 ? "variante" : "variantes"}`)
  const pc = Object.keys({ ...a.prices, ...b.prices }).filter(
    (k) => a.prices[k] !== b.prices[k],
  ).length
  if (pc) out.push(`Precio de ${pc} ${pc === 1 ? "variante" : "variantes"}`)
  if (JSON.stringify(a.datos) !== JSON.stringify(b.datos)) out.push("Datos del rubro")
  if (JSON.stringify(a.ofertas) !== JSON.stringify(b.ofertas)) out.push("Lo que puede ofrecer Sofi")
  if (JSON.stringify([a.tiers, a.mayor, a.promos]) !== JSON.stringify([b.tiers, b.mayor, b.promos]))
    out.push("Precios por cantidad y promociones")
  if (
    JSON.stringify([a.keywords, a.cat, a.web, a.paquete, a.combo, a.parecido, a.preguntas]) !==
    JSON.stringify([b.keywords, b.cat, b.web, b.paquete, b.combo, b.parecido, b.preguntas])
  )
    out.push("Organización y venta")
  return out
}
export function stockCambiado(a: Producto | undefined, b: Producto): number {
  if (!a) return 0
  return b.colors.reduce(
    (n, c) =>
      n +
      b.sizes.filter((z) => (a.stock[key(c.id, z)] ?? 0) !== (b.stock[key(c.id, z)] ?? 0)).length,
    0,
  )
}

export function guardar(pid: string, motivo?: string) {
  const d = db()
  const p = d.products.find((x) => x.id === pid)
  if (!p) return
  const lista = diff(d.saved[pid], p)
  const R = RUBROS[S.rubro]
  const yo = S.rol === "dueno" ? R.store.owner : R.store.ventas
  const ahora = new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })
  d.historial[pid] = [
    ...lista.map((what) => ({
      who: yo,
      rol: "Tú",
      when: `Hoy, ${ahora}`,
      what: what.startsWith("Stock de") && motivo ? `${what} · ${motivo}` : what,
    })),
    ...(d.historial[pid] ?? []),
  ]
  d.saved = { ...d.saved, [pid]: clone(p) }
  S.undo = S.undo.filter((x) => x.pid !== pid)
  S.redo = []
  autosave()
  emit()
  toast.success(
    lista.length === 1 ? `Guardado: ${lowerFirst(lista[0]!)}` : `Guardados ${lista.length} cambios`,
    { id: "deshacer" },
  )
}
export function descartar(pid: string) {
  const d = db()
  const s = d.saved[pid]
  if (!s) return
  d.products = d.products.map((x) => (x.id === pid ? clone(s) : x))
  S.undo = S.undo.filter((x) => x.pid !== pid)
  S.redo = []
  autosave()
  emit()
  toast("Volvió a lo guardado", { id: "deshacer" })
}

export function agregarProducto(p: Producto) {
  const d = db()
  d.products = [...d.products, p]
  // Se crea guardado: lo propuesto por la IA queda como propuesta dentro de él.
  d.saved = { ...d.saved, [p.id]: clone(p) }
  const R = RUBROS[S.rubro]
  d.historial[p.id] = [
    {
      who: S.rol === "dueno" ? R.store.owner : R.store.ventas,
      rol: "Tú",
      when: "Hoy",
      what: "Creó el producto desde fotos",
    },
  ]
  autosave()
  emit()
}

export function plantilla(fn: (tpl: Dato[]) => Dato[]) {
  const d = db()
  d.tpl = fn(d.tpl)
  emit()
}
export function marcarToca() {
  db().tocaDone = true
  emit()
}
export function reiniciar() {
  try {
    for (const r of Object.keys(RUBROS)) localStorage.removeItem(LS(r as RubroId))
  } catch {
    /* nada que borrar */
  }
  S = { ...S, db: {}, undo: [], redo: [], borradorAt: null }
  emit()
}
