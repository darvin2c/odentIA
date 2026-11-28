import { useEffect, useMemo, useSyncExternalStore } from "react"
import { ApiError } from "../lib/api"
import {
  cellKey,
  type Draft,
  draftOf,
  type Grid,
  gridBody,
  gridChanged,
  gridOf,
  type History,
  heldOf,
  idsOf,
  loweredCells,
  onBase,
  PATCH_FIELDS,
  type PatchField,
  patchOf,
  record,
  type Sheet,
  same,
} from "../lib/ficha"

/**
 * El borrador de la ficha, que se guarda solo (sin botón obligatorio): cada cambio va al borrador
 * y, al rato, al servidor. Dice siempre cómo está («Guardando…», «Guardado», lo que no se guardó y
 * por qué), deja deshacer y rehacer, y no pierde nada si falla la red: lo escrito se queda en la
 * pantalla (y en el navegador) y se vuelve a intentar. Los datos del producto van con
 * `PATCH /productos/:id`; los colores, tallas y el stock, con `POST /productos/:id/cuadricula`,
 * donde subir el stock es una entrada del kardex y bajarlo pide motivo (ADR 0206).
 */

export type SaveStatus =
  | { kind: "saved" }
  | { kind: "pending" }
  | { kind: "saving" }
  /** Sin conexión o el servidor no respondió: se reintenta solo. */
  | { kind: "offline"; message: string }
  /** El servidor no aceptó algo: se dice en su campo; lo demás sí se guarda. */
  | { kind: "rejected"; message: string }
  /** Baja el stock: falta el motivo para guardar la cuadrícula. */
  | { kind: "reason"; cells: number }
  /** A medio escribir (las medidas del paquete): se guarda al completarlo. */
  | { kind: "incomplete"; message: string }

export interface SaveApi {
  get: () => Promise<Sheet>
  patch: (body: Record<string, unknown>) => Promise<Sheet>
  grid: (body: ReturnType<typeof gridBody>) => Promise<Sheet>
}

interface State {
  sheet: Sheet
  base: Draft
  draft: Draft
  history: History
  /** Lo que dijo el servidor de cada campo que no aceptó. */
  errors: Record<string, string>
  status: SaveStatus
  /** El motivo para bajar el stock, mientras espera guardarse. */
  reason: string
  /** Lo último que se deshizo o hizo, para avisarlo. */
  last: { label: string; at: number } | null
}

const DELAY = 900
const RETRY = 5000
const storageKey = (id: string) => `gestoria:ficha:${id}`

/** Una copia que se puede cambiar sin tocar el original. */
const clone = <T>(value: T): T => structuredClone(value)
/** Esta pestaña: un borrador que otra pestaña está guardando no se recupera aquí. */
const TAB = typeof crypto !== "undefined" ? crypto.randomUUID() : "pestaña"
/** Lo que se considera vivo: otra pestaña que anotó su borrador hace menos de esto. */
const ALIVE_MS = 30_000

export class FichaStore {
  private state: State
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight = false
  private again = false
  /** Lo que el servidor rechazó, con el valor rechazado: no se vuelve a enviar igual. */
  private rejected: Record<string, string> = {}
  private gridRejected: string | null = null
  /** La cuadrícula que baja el stock frente al de ahora y espera su motivo. */
  private needsReason: string | null = null
  /** El producto ya no está o ya no se puede cambiar: no se intenta más. */
  private closed = false
  private restored = false
  /** Cuántas pantallas lo usan: se suelta solo sin ninguna. */
  mounted = 0

  constructor(
    sheet: Sheet,
    private readonly api: SaveApi,
    private readonly onSaved: (sheet: Sheet) => void,
    private readonly readOnly: boolean,
  ) {
    const base = draftOf(sheet)
    this.state = {
      sheet,
      base,
      draft: base,
      history: { undo: [], redo: [] },
      errors: {},
      status: { kind: "saved" },
      reason: "",
      last: null,
    }
    if (!readOnly) this.restore()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.state

  private set(next: Partial<State>) {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Cuántas cosas están sin guardar todavía. */
  pendingCount(): number {
    const { base, draft } = this.state
    return (
      PATCH_FIELDS.filter((f) => !same(base[f], draft[f])).length +
      (gridChanged(base, draft) ? 1 : 0)
    )
  }

  /** Un cambio de la persona: se anota para deshacer y se guarda al rato. */
  change(label: string, fn: (draft: Draft) => void, options: { group?: string } = {}) {
    if (this.readOnly) return
    const before = this.state.draft
    const next = clone(before)
    fn(next)
    if (same(next, before)) return
    this.set({
      draft: next,
      history: record(
        this.state.history,
        before,
        label,
        options.group,
        Date.now(),
        this.state.base.grid,
      ),
      last: options.group ? this.state.last : { label, at: Date.now() },
    })
    this.afterChange()
  }

  undo(): string | null {
    const step = this.state.history.undo.at(-1)
    if (!step || this.readOnly) return null
    this.set({
      draft: onBase(step, this.state.base.grid),
      history: {
        undo: this.state.history.undo.slice(0, -1),
        redo: [
          ...this.state.history.redo,
          { ...step, draft: this.state.draft, base: this.state.base.grid },
        ],
      },
      last: { label: `Deshiciste: ${step.label}`, at: Date.now() },
    })
    this.afterChange()
    return step.label
  }

  redo(): string | null {
    const step = this.state.history.redo.at(-1)
    if (!step || this.readOnly) return null
    this.set({
      draft: onBase(step, this.state.base.grid),
      history: {
        undo: [
          ...this.state.history.undo,
          { ...step, draft: this.state.draft, base: this.state.base.grid },
        ],
        redo: this.state.history.redo.slice(0, -1),
      },
      last: { label: `Rehiciste: ${step.label}`, at: Date.now() },
    })
    this.afterChange()
    return step.label
  }

  /** Vuelve todo a lo guardado (lo que no se guardó se pierde). */
  discard() {
    this.set({
      draft: this.state.base,
      errors: {},
      reason: "",
      status: { kind: "saved" },
      history: record(
        this.state.history,
        this.state.draft,
        "Volver a lo guardado",
        undefined,
        Date.now(),
      ),
    })
    this.rejected = {}
    this.gridRejected = null
    this.persist()
  }

  setReason(reason: string) {
    this.set({ reason })
    if (reason.trim().length >= 3) void this.flush()
  }

  /** Llegó la ficha del servidor (al volver a la pestaña, después de una venta). */
  receive(sheet: Sheet) {
    if (this.inflight || this.pendingCount() > 0) {
      this.set({ sheet })
      return
    }
    const base = draftOf(sheet, gridOf(sheet, idsOf(this.state.base.grid)))
    this.set({ sheet, base, draft: base })
  }

  private afterChange() {
    this.persist()
    if (this.state.status.kind !== "saving") this.set({ status: { kind: "pending" } })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), DELAY)
  }

  /** Guarda ya lo que falte (al salir de la página o al pedirlo). */
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.readOnly || this.closed) return
    if (this.inflight) {
      this.again = true
      return
    }
    if (!this.canSendMore()) {
      this.settle()
      return
    }
    this.inflight = true
    this.again = false
    this.set({ status: { kind: "saving" } })
    let offline = false
    try {
      // Primero la cuadrícula: un color que cambia de nombre lleva sus promociones con él.
      const { base, draft } = this.state
      if (
        draft.grid !== null &&
        gridChanged(base, draft) &&
        JSON.stringify(draft.grid) !== this.gridRejected
      )
        offline = (await this.saveGrid(this.state.reason)) === "offline"
      const patch = offline
        ? null
        : patchOf(this.state.base, this.state.draft, this.state.sheet, this.rejected)
      if (patch) {
        const sent = clone(this.state.draft)
        try {
          const saved = await this.api.patch(patch)
          this.applyPatch(saved, sent, Object.keys(patch))
        } catch (error) {
          offline = this.failPatch(error, sent, Object.keys(patch)) === "offline"
        }
      }
    } finally {
      this.inflight = false
    }
    if (offline) return
    if (this.again || this.canSendMore()) {
      this.timer = setTimeout(() => void this.flush(), 50)
      return
    }
    this.settle()
  }

  /** Si queda algo que se puede enviar ahora (no rechazado ni esperando el motivo). */
  private canSendMore() {
    const { base, draft, sheet } = this.state
    if (patchOf(base, draft, sheet, this.rejected)) return true
    const reasoned = this.state.reason.trim().length >= 3
    const grid = JSON.stringify(draft.grid)
    return (
      draft.grid !== null &&
      gridChanged(base, draft) &&
      grid !== this.gridRejected &&
      (reasoned || (loweredCells(base.grid, draft.grid) === 0 && grid !== this.needsReason))
    )
  }

  /** Cómo queda después de guardar: guardado, esperando el motivo o con algo rechazado. */
  private settle() {
    const { base, draft, errors } = this.state
    const grid = JSON.stringify(draft.grid)
    const lowered = gridChanged(base, draft)
      ? Math.max(loweredCells(base.grid, draft.grid), grid === this.needsReason ? 1 : 0)
      : 0
    if (lowered > 0 && grid !== this.gridRejected)
      this.set({ status: { kind: "reason", cells: lowered } })
    else if (Object.keys(errors).length > 0 && this.pendingCount() > 0)
      this.set({
        status: { kind: "rejected", message: Object.values(errors)[0] ?? "No se guardó" },
      })
    else if (this.pendingCount() === 0) this.set({ status: { kind: "saved" }, errors: {} })
    else
      this.set({
        status: {
          kind: "incomplete",
          message: Object.values(heldOf(draft, this.state.sheet))[0] ?? "Hay algo a medio escribir",
        },
      })
    this.persist()
  }

  /**
   * La cuadrícula, sobre el stock de ahora: lo que cambió la persona se suma a lo que hay hoy en
   * el servidor (si se vendió algo mientras tanto, no se pisa la venta).
   */
  private async saveGrid(reason: string): Promise<"saved" | "waiting" | "rejected" | "offline"> {
    const sent = clone(this.state.draft.grid!)
    const base = this.state.base.grid
    // Sin motivo y bajando el stock, no se envía: se pide el motivo.
    if (loweredCells(base, sent) > 0 && reason.trim().length < 3) return "waiting"
    let fresh: Sheet
    try {
      fresh = await this.api.get()
    } catch (error) {
      if (this.isFinal(error)) return "rejected"
      this.offline(error)
      return "offline"
    }
    const now = gridOf(fresh, idsOf(base))
    const target = rebase(base, sent, now)
    const lowered = loweredCells(now, target)
    if (lowered > 0 && reason.trim().length < 3) {
      this.needsReason = JSON.stringify(sent)
      this.set({ sheet: fresh })
      return "waiting"
    }
    try {
      const saved = await this.api.grid(
        gridBody(now, target, lowered > 0 ? { reason: reason.trim() } : {}),
      )
      const grid = gridOf(saved, idsOf(sent))
      const changed = !same(this.state.draft.grid, sent)
      const baseDraft = { ...draftOf(saved, grid) }
      this.set({
        sheet: saved,
        base: { ...this.state.base, grid },
        draft: changed ? this.state.draft : { ...this.state.draft, grid },
        reason: "",
        errors: withoutGridErrors(this.state.errors),
      })
      // Lo del producto que cambia con la cuadrícula (las promociones de un color renombrado).
      this.rebaseFields(baseDraft)
      // El servidor cambió: lo rechazado antes (una promoción de un color renombrado) se reintenta.
      this.gridRejected = null
      this.needsReason = null
      this.rejected = {}
      this.onSaved(saved)
      return "saved"
    } catch (error) {
      if (this.isFinal(error)) return "rejected"
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        this.gridRejected = JSON.stringify(sent)
        const fields = Object.keys(error.fields).length ? error.fields : { grid: error.message }
        // El motivo era para ese intento: el próximo cambio lo vuelve a pedir.
        this.set({
          errors: { ...this.state.errors, ...prefixGrid(fields) },
          status: { kind: "rejected", message: error.message },
          reason: "",
        })
        return "rejected"
      }
      this.offline(error)
      return "offline"
    }
  }

  /** Lo que guardó el servidor pasa a ser lo guardado; lo que no cambió desde que se envió, también. */
  private applyPatch(saved: Sheet, sent: Draft, keys: string[]) {
    const fresh = draftOf(saved, this.state.base.grid)
    const fields = keys.filter((k): k is PatchField =>
      (PATCH_FIELDS as readonly string[]).includes(k),
    )
    const draft = { ...this.state.draft }
    const base = { ...this.state.base }
    for (const field of fields) {
      ;(base as Record<string, unknown>)[field] = fresh[field]
      // Si no se tocó mientras tanto, queda como lo escribió el servidor (sin espacios, en orden).
      if (same(this.state.draft[field], sent[field]))
        (draft as Record<string, unknown>)[field] = fresh[field]
    }
    for (const field of fields) delete this.rejected[field]
    const errors = { ...this.state.errors }
    for (const key of Object.keys(errors))
      if (fields.some((f) => key === f || key.startsWith(`${f}.`))) delete errors[key]
    this.set({ sheet: saved, base, draft, errors })
    this.onSaved(saved)
  }

  /** Lo del producto que no se envió y cambió en el servidor por la cuadrícula. */
  private rebaseFields(fresh: Draft) {
    const base = { ...this.state.base }
    const draft = { ...this.state.draft }
    for (const field of PATCH_FIELDS) {
      if (same(base[field], fresh[field])) continue
      if (same(draft[field], base[field])) (draft as Record<string, unknown>)[field] = fresh[field]
      ;(base as Record<string, unknown>)[field] = fresh[field]
    }
    this.set({ base, draft })
  }

  /**
   * Sin permiso o sin el producto (lo borraron, o ya no está en la tienda): no se reintenta. Lo
   * escrito se queda en la pantalla y se dice.
   */
  private isFinal(error: unknown): boolean {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return false
    this.closed = true
    clearTimeout(this.timer)
    this.set({ status: { kind: "rejected", message: error.message } })
    return true
  }

  private failPatch(error: unknown, sent: Draft, keys: string[]): "rejected" | "offline" {
    if (this.isFinal(error)) return "rejected"
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      const fields = Object.keys(error.fields).length
        ? error.fields
        : Object.fromEntries(keys.map((k) => [k, error.message]))
      for (const key of Object.keys(fields)) {
        const [top, sub] = key.split(".")
        if (top === "rubroData" && sub)
          this.rejected[key] = JSON.stringify(sent.rubroData[sub] ?? null)
        else if (top && (PATCH_FIELDS as readonly string[]).includes(top))
          this.rejected[top] = JSON.stringify(sent[top as PatchField])
      }
      // Lo que no se puede atribuir a un campo: no se repite igual.
      if (!Object.keys(fields).some((k) => this.rejected[k.split(".")[0]!] || this.rejected[k]))
        for (const key of keys) this.rejected[key] = JSON.stringify(sent[key as PatchField])
      this.set({
        errors: { ...this.state.errors, ...fields },
        status: { kind: "rejected", message: error.message },
      })
      // Lo demás que cambió sí se guarda.
      this.again = true
      return "rejected"
    }
    this.offline(error)
    return "offline"
  }

  private offline(error: unknown) {
    const message =
      error instanceof Error ? error.message : "No hay conexión con gestorIA. Lo intento de nuevo."
    this.set({ status: { kind: "offline", message } })
    // Sigue viva: otra pestaña no recupera este borrador mientras se reintenta.
    this.persist()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), RETRY)
  }

  /** Lo que no se guardó queda en el navegador, por si se cierra la pestaña. */
  private persist() {
    const key = storageKey(this.state.sheet.id)
    try {
      if (this.pendingCount() === 0) localStorage.removeItem(key)
      else
        localStorage.setItem(
          key,
          JSON.stringify({
            updatedAt: this.state.sheet.updatedAt,
            base: this.state.base,
            draft: this.state.draft,
            tab: TAB,
            at: Date.now(),
          }),
        )
    } catch {
      // Sin almacenamiento (ventana privada): el borrador vive en la pantalla.
    }
  }

  /**
   * Si quedó un borrador de antes sobre la misma ficha, vuelve: lo que se cambió frente a su
   * base, puesto sobre la ficha de ahora (la cuadrícula, sobre el stock de ahora al guardarse).
   * El de otra pestaña que sigue abierta no se toca: lo guarda ella.
   */
  private restore() {
    try {
      const raw = localStorage.getItem(storageKey(this.state.sheet.id))
      if (!raw) return
      const kept = JSON.parse(raw) as {
        updatedAt: string
        base: Draft
        draft: Draft
        tab?: string
        at?: number
      }
      if (kept.tab && kept.tab !== TAB && Date.now() - (kept.at ?? 0) < ALIVE_MS) return
      const base = this.state.base
      const draft = { ...base }
      const fields = PATCH_FIELDS.filter((f) => !same(kept.base[f], kept.draft[f]))
      for (const field of fields) (draft as Record<string, unknown>)[field] = kept.draft[field]
      // La cuadrícula solo si sigue siendo la misma de entonces (mismos colores y tallas).
      const sameAxes =
        kept.base.grid &&
        base.grid &&
        same(
          kept.base.grid.rows.map((r) => r.value),
          base.grid.rows.map((r) => r.value),
        ) &&
        same(
          kept.base.grid.columns.map((c) => c.value),
          base.grid.columns.map((c) => c.value),
        )
      let keptBase = base
      if (sameAxes && !same(kept.base.grid, kept.draft.grid)) {
        draft.grid = kept.draft.grid
        keptBase = { ...base, grid: kept.base.grid }
      }
      if (same(draft, base) && keptBase === base) {
        localStorage.removeItem(storageKey(this.state.sheet.id))
        return
      }
      this.state = {
        ...this.state,
        base: keptBase,
        draft,
        status: { kind: "pending" },
        last: { label: "Recuperé lo que no se había guardado", at: Date.now() },
      }
      this.restored = true
    } catch {
      // Lo guardado no se lee: se empieza de lo del servidor.
    }
  }

  /** Empieza a guardar lo recuperado (ya en la pantalla, para que se vea cómo va). */
  start() {
    if (this.restored && !this.inflight) {
      this.restored = false
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.flush(), DELAY)
    }
  }

  /** Si se puede soltar: no queda nada por guardar ni se está guardando. */
  idle(): boolean {
    return !this.inflight && (this.closed || this.pendingCount() === 0)
  }
}

/**
 * Lo que cambió la persona (de `base` a `draft`), sobre lo que hay ahora en el servidor (`now`):
 * una celda que no tocó queda como está; una que tocó suma la diferencia a la de ahora.
 */
export function rebase(base: Grid | null, draft: Grid, now: Grid | null): Grid {
  if (!base || !now) return draft
  const cells = { ...draft.cells }
  for (const [key, cell] of Object.entries(draft.cells)) {
    const before = base.cells[key]
    const current = now.cells[key]
    if (!before || !current) continue
    const delta = cell.stock - before.stock
    cells[key] = {
      stock: Math.max(0, current.stock + delta),
      priceCents: same(cell.priceCents, before.priceCents) ? current.priceCents : cell.priceCents,
      barcode: same(cell.barcode, before.barcode) ? current.barcode : cell.barcode,
    }
  }
  return { ...draft, cells }
}

const isGridKey = (key: string) =>
  key === "grid" || key === "reason" || /^(rows|columns|cells)(\.|$)/.test(key)
function withoutGridErrors(errors: Record<string, string>) {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => !isGridKey(key)))
}
function prefixGrid(fields: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, message]) => [isGridKey(key) ? key : `grid.${key}`, message]),
  )
}

/**
 * Un solo borrador por producto en la pestaña: volver a la ficha mientras se guarda lo de antes (o
 * mientras reintenta sin red) usa el mismo, nunca dos que envíen el mismo cambio de stock.
 */
const stores = new Map<string, FichaStore>()

/** El borrador de la ficha en la pantalla: uno por producto, que sigue mientras le quede algo. */
export function useFichaStore(
  sheet: Sheet | undefined,
  api: SaveApi,
  onSaved: (sheet: Sheet) => void,
  readOnly: boolean,
) {
  const key = sheet ? `${sheet.id}:${readOnly ? "ver" : "cambiar"}` : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: uno por producto; lo demás no cambia
  const store = useMemo(() => {
    if (!sheet || !key) return null
    const kept = stores.get(key)
    if (kept) return kept
    const created = new FichaStore(sheet, api, onSaved, readOnly)
    stores.set(key, created)
    return created
  }, [key])
  useEffect(() => {
    if (store && sheet) store.receive(sheet)
  }, [store, sheet])
  useEffect(() => {
    if (!store || !key) return
    store.mounted++
    store.start()
    // Al salir de la ficha o esconder la pestaña, se guarda lo que falte.
    const hide = () => {
      if (document.visibilityState === "hidden") void store.flush()
    }
    const online = () => void store.flush()
    document.addEventListener("visibilitychange", hide)
    window.addEventListener("online", online)
    return () => {
      document.removeEventListener("visibilitychange", hide)
      window.removeEventListener("online", online)
      // Lo que falta se guarda; el borrador se suelta cuando ya no le queda nada.
      store.mounted--
      void store.flush().then(() => {
        if (store.mounted === 0 && store.idle()) stores.delete(key)
      })
    }
  }, [store, key])
  return store
}

const EMPTY = {} as State
export function useFicha(store: FichaStore | null): State {
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? (() => EMPTY),
  )
}

export { cellKey }
