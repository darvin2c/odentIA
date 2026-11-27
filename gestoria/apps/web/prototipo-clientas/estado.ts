import { useSyncExternalStore } from "react"
import {
  type AccionId,
  type Clienta,
  clientasDe,
  type DatoKey,
  planDe,
  type Reglas,
  RUBROS,
  type RubroId,
} from "./datos"

/**
 * El estado del prototipo, en memoria y por tienda: las clientas con lo que Argos anotó, las
 * reglas de Argos y los dos chats de ejemplo. «Empezar de nuevo» lo vuelve al inicio.
 */

export interface Db extends Reglas {
  cl: Clienta[]
  chat: { rocio: number; fio: number }
  paid: boolean
  merged: boolean
  distinct: boolean
  days: boolean[]
  from: string
  to: string
  mes: number
  noRecl: boolean
  noRuta: boolean
  grupos: { id: string; name: string; q: Record<string, string> }[]
  /** Lo que pasó en los chats de ejemplo: respondieron, conversaron, compraron, vendido, bajas. */
  extra: Partial<Record<AccionId, { r: number; k: number; c: number; v: number; b: number }>>
}

function fresh(r: RubroId): Db {
  return {
    cl: clientasDe(r),
    pausa: {},
    permiso: {},
    ok: {},
    skip: {},
    budget: 30,
    used: 28.4,
    budgetOk: false,
    tope: 1,
    mes: 4,
    days: [true, true, true, true, true, true, false],
    from: "10:00",
    to: "19:00",
    noRecl: true,
    noRuta: true,
    chat: { rocio: 0, fio: 0 },
    paid: false,
    merged: false,
    distinct: false,
    grupos: [],
    extra: {},
  }
}

let db: Partial<Record<RubroId, Db>> = {}
let version = 0
const subs = new Set<() => void>()
const emit = () => {
  version++
  for (const f of subs) f()
}

export function getDb(r: RubroId): Db {
  let d = db[r]
  if (!d) {
    d = fresh(r)
    db[r] = d
  }
  return d
}

export function useDb(r: RubroId): Db {
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => version,
  )
  return getDb(r)
}

/** Un cambio del estado de una tienda; la pantalla se dibuja de nuevo. */
export function cambiar(r: RubroId, f: (d: Db) => void) {
  f(getDb(r))
  emit()
}

export function reiniciar() {
  db = {}
  emit()
}

export const planOf = (r: RubroId) => {
  const d = getDb(r)
  return planDe(
    d.cl.filter((c) => !c.oculta),
    RUBROS[r],
    d,
  )
}

/** La tienda corrige un dato: queda como suyo y Argos no lo vuelve a pisar. */
export function corregir(r: RubroId, id: string, key: DatoKey, valor: string, quien: string) {
  cambiar(r, (d) => {
    const c = d.cl.find((x) => x.id === id)
    if (!c) return
    const prev = c.datos[key]
    c.datos[key] = {
      valor,
      fuente: "equipo",
      de: `${quien.split(" ")[0]} lo ${prev?.dudas ? "confirmó" : "corrigió"}`,
      cuando: "27 nov",
      quien,
      fijo: true,
      hist: [
        { cuando: "27 nov", quien, valor, nota: prev?.dudas ? "Lo confirmó" : "Lo corrigió" },
        ...(prev?.hist ?? []),
      ],
    }
  })
}
