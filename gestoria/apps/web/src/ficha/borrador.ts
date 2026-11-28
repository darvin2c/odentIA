import { useEffect, useMemo, useSyncExternalStore } from "react"
import { ApiError } from "../lib/api"
import {
  cellKey,
  changedFields,
  type Draft,
  draftOf,
  FIELD_NAMES,
  type Grid,
  gridBody,
  gridChanged,
  gridLook,
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
  shiftBases,
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
  /**
   * Otra pestaña u otra persona cambió lo mismo mientras se editaba: no se pisa. Lo escrito se
   * queda y la persona elige (`keepMine` o `takeTheirs`).
   */
  | { kind: "conflict"; message: string }

/** Lo que responde la cuadrícula: la ficha y lo que se vendió mientras se editaba. */
export interface GridSaved {
  product: Sheet
  meanwhile?: { variant: string; seen: number; now: number }[]
}

export interface SaveApi {
  patch: (body: Record<string, unknown>) => Promise<Sheet>
  grid: (body: ReturnType<typeof gridBody> & { version?: string }) => Promise<GridSaved>
  /** La ficha de ahora en el servidor: después de un 409, para ver qué cambió. */
  load: () => Promise<Sheet>
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
  /** Lo que se vendió mientras se editaba la cuadrícula, para avisarlo. */
  sold: string | null
  /** Lo que cambió otra pestaña u otra persona y ya se ve aquí, para avisarlo. */
  news: string | null
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
  /** Lo escrito en un campo espera a que se salga de él (`release`) para guardarse. */
  private held = false
  /** Los campos que otra pestaña cambió igual: no se envían hasta que la persona elija. */
  private clash: string[] = []
  /**
   * La versión de la ficha sobre la que está lo guardado de esta pantalla (`base`): va con cada
   * envío y, si cambió en el servidor, responde 409. Una ficha que llega mientras hay algo sin
   * guardar no la mueve: así lo de otra pestaña no se pisa sin avisar.
   */
  private version: string
  private readonly typing: () => boolean

  constructor(
    sheet: Sheet,
    private readonly api: SaveApi,
    private readonly onSaved: (sheet: Sheet) => void,
    private readonly readOnly: boolean,
    options: { typing?: () => boolean } = {},
  ) {
    this.typing = options.typing ?? typingInPage
    this.version = sheet.updatedAt
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
      sold: null,
      news: null,
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
    // Un motivo elegido se guarda ya; uno que se escribe, al salir del campo.
    if (reason.trim().length >= 3) this.tick()
  }

  /**
   * Se salió del campo (o se dio Enter): lo que esperaba se guarda. Mientras se escribe no se
   * guarda nada: el deshacer del campo (Ctrl+Z del navegador) pasa por valores que nadie escribió
   * («S/ 1» camino a «S/ 149») y ninguno de esos debe llegar al servidor ni al historial.
   */
  release() {
    if (!this.held) return
    this.held = false
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 0)
  }

  /** El guardado que corre solo: si se está escribiendo en un campo, espera a `release`. */
  private tick() {
    if (this.typing()) {
      this.held = true
      return
    }
    void this.flush()
  }

  /** Llegó la ficha del servidor (al volver a la pestaña, después de una venta). */
  receive(sheet: Sheet) {
    if (this.inflight || this.pendingCount() > 0) {
      this.set({ sheet })
      return
    }
    const base = draftOf(sheet, gridOf(sheet, idsOf(this.state.base.grid)))
    this.version = sheet.updatedAt
    this.set({ sheet, base, draft: base })
  }

  private afterChange() {
    this.persist()
    if (this.state.status.kind !== "saving") this.set({ status: { kind: "pending" } })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tick(), DELAY)
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
      let stale = false
      if (
        draft.grid !== null &&
        gridChanged(base, draft) &&
        !this.clash.includes("grid") &&
        JSON.stringify(draft.grid) !== this.gridRejected
      ) {
        const result = await this.saveGrid(this.state.reason)
        offline = result === "offline"
        stale = result === "stale"
      }
      const patch = offline || stale ? null : this.patchNow()
      if (patch) {
        const sent = clone(this.state.draft)
        try {
          const saved = await this.api.patch({ ...patch, version: this.version })
          this.applyPatch(saved, sent, Object.keys(patch))
        } catch (error) {
          if (isStale(error)) stale = true
          else offline = this.failPatch(error, sent, Object.keys(patch)) === "offline"
        }
      }
      // Otra pestaña cambió la ficha: se mira qué, se toma lo que no se tocó aquí y se sigue.
      if (stale) offline = (await this.onStale()) === "offline"
    } finally {
      this.inflight = false
    }
    if (offline) return
    if (this.again || this.canSendMore()) {
      this.timer = setTimeout(() => this.tick(), 50)
      return
    }
    this.settle()
  }

  /** Lo del producto que se puede enviar ahora: sin lo rechazado ni lo que choca con otra pestaña. */
  private patchNow() {
    const patch = patchOf(this.state.base, this.state.draft, this.state.sheet, this.rejected)
    if (!patch) return null
    for (const field of this.clash) delete patch[field]
    return Object.keys(patch).length > 0 ? patch : null
  }

  /** Si queda algo que se puede enviar ahora (no rechazado ni esperando el motivo). */
  private canSendMore() {
    const { base, draft } = this.state
    if (this.patchNow()) return true
    if (this.clash.includes("grid")) return false
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
    if (this.clash.length > 0) {
      this.set({ status: { kind: "conflict", message: clashMessage(this.clash) } })
      this.persist()
      return
    }
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
  private async saveGrid(
    reason: string,
  ): Promise<"saved" | "waiting" | "rejected" | "offline" | "stale"> {
    const sent = clone(this.state.draft.grid!)
    const base = this.state.base.grid
    // Sin motivo y bajando el stock, no se envía: se pide el motivo. Lo que se envía es lo que
    // cambió frente al stock que se vio (`seenStock`): el servidor lo suma al de ahora.
    const lowered = loweredCells(base, sent)
    if (lowered > 0 && reason.trim().length < 3) return "waiting"
    try {
      const { product: saved, meanwhile = [] } = await this.api.grid({
        ...gridBody(base, sent, lowered > 0 ? { reason: reason.trim() } : {}),
        version: this.version,
      })
      const grid = gridOf(saved, idsOf(sent))
      // Lo que se siguió escribiendo mientras se guardaba va sobre lo guardado de ahora (con lo
      // que se vendió en ese momento), nunca sobre el stock de antes.
      const draft = same(this.state.draft.grid, sent)
        ? { ...this.state.draft, grid }
        : { ...this.state.draft, grid: onSaved(this.state.draft.grid, sent, grid) }
      const baseDraft = { ...draftOf(saved, grid) }
      this.set({
        sheet: saved,
        base: { ...this.state.base, grid },
        draft,
        // Deshacer lo ya guardado vuelve al stock de verdad: los pasos se mueven con lo guardado.
        history: shiftBases(this.state.history, base, sent),
        reason: "",
        errors: withoutGridErrors(this.state.errors),
        sold: meanwhile.length
          ? `Se vendió mientras editabas: ${meanwhile
              .map((m) => `${m.variant} (había ${m.seen}, quedaban ${m.now})`)
              .join(", ")}. Lo que cambiaste se sumó a eso.`
          : this.state.sold,
      })
      this.version = saved.updatedAt
      // Lo del producto que cambia con la cuadrícula (las promociones de un color renombrado).
      this.rebaseFields(baseDraft)
      // El servidor cambió: lo rechazado antes (una promoción de un color renombrado) se reintenta.
      this.gridRejected = null
      this.needsReason = null
      this.rejected = {}
      this.onSaved(saved)
      return "saved"
    } catch (error) {
      if (isStale(error)) return "stale"
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
    this.version = saved.updatedAt
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
   * El servidor dijo que la ficha cambió desde la versión que se vio (otra pestaña, otra persona).
   * Se trae la de ahora: lo que cambió allá y aquí no se tocó, se toma; lo que se cambió en los
   * dos lados no se pisa y espera a que la persona elija. Lo escrito nunca se pierde.
   */
  private async onStale(): Promise<"merged" | "offline"> {
    let latest: Sheet
    try {
      latest = await this.api.load()
    } catch (error) {
      this.offline(error)
      return "offline"
    }
    const { base, draft } = this.state
    const fresh = draftOf(latest, gridOf(latest, idsOf(draft.grid)))
    const mine = changedFields(base, draft)
    const theirs = changedFields(base, fresh)
    const clash: string[] = mine.filter((f) => theirs.includes(f))
    const gridMine = gridChanged(base, draft)
    const gridTheirs = !same(gridLook(base.grid), gridLook(fresh.grid))
    if (gridMine && gridTheirs) clash.push("grid")
    const nextBase = { ...fresh }
    const nextDraft = { ...fresh }
    for (const field of mine) (nextDraft as Record<string, unknown>)[field] = draft[field]
    if (gridMine) {
      // El stock va por diferencia (`seenStock`): lo que se vio antes sigue siendo la base.
      nextDraft.grid = draft.grid
      if (!gridTheirs) nextBase.grid = base.grid
    }
    const changed = [
      ...theirs.filter((f) => !mine.includes(f)).map((f) => FIELD_NAMES[f] ?? f),
      ...(gridTheirs && !gridMine ? ["los colores o las tallas"] : []),
    ]
    this.clash = clash
    this.version = latest.updatedAt
    this.set({
      sheet: latest,
      base: nextBase,
      draft: nextDraft,
      news:
        changed.length > 0 && clash.length === 0
          ? `Alguien cambió esta ficha mientras la tenías abierta: ${listOf(changed)}. Ya lo ves aquí; lo tuyo se guarda igual.`
          : this.state.news,
    })
    this.onSaved(latest)
    return "merged"
  }

  /** Ante un cambio de otra pestaña en lo mismo: se guarda lo de esta pantalla encima. */
  keepMine() {
    if (!this.clash.length) return
    this.clash = []
    this.set({ status: { kind: "pending" } })
    void this.flush()
  }

  /** Ante un cambio de otra pestaña en lo mismo: se queda lo de la otra y se suelta lo de aquí. */
  takeTheirs() {
    if (!this.clash.length) return
    const draft = { ...this.state.draft }
    for (const field of this.clash)
      (draft as Record<string, unknown>)[field] = (
        this.state.base as unknown as Record<string, unknown>
      )[field]
    this.clash = []
    this.set({ draft, status: { kind: "pending" } })
    void this.flush()
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
    this.timer = setTimeout(() => this.tick(), RETRY)
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

/** El servidor dijo 409: la ficha cambió desde la versión que se vio. */
const isStale = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && error.code === "STALE"

/** «el precio y el mínimo»: una lista en palabras. */
function listOf(items: string[]): string {
  const unique = [...new Set(items)]
  return unique.length > 1
    ? `${unique.slice(0, -1).join(", ")} y ${unique.at(-1)}`
    : (unique[0] ?? "")
}

function clashMessage(clash: string[]): string {
  const names = clash.map((f) =>
    f === "grid" ? "los colores, las tallas o el stock" : (FIELD_NAMES[f] ?? f),
  )
  return `Alguien cambió esta ficha mientras la tenías abierta: ${listOf(names)}. Lo tuyo sigue aquí, sin guardar.`
}

/** Si el foco está en algo donde se escribe (un campo de texto o de número). */
function typingInPage(): boolean {
  if (typeof document === "undefined") return false
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true
  return (
    el instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type)
  )
}

/**
 * Lo que se escribió en la cuadrícula mientras se guardaba (de `sent` a `draft`), sobre lo que
 * guardó el servidor (`saved`, con lo que se vendió en ese momento): la diferencia de cada celda
 * se suma a lo guardado; el precio y el código, como se escribieron.
 */
export function onSaved(draft: Grid | null, sent: Grid, saved: Grid | null): Grid | null {
  if (!draft || !saved) return draft
  const cells = { ...draft.cells }
  for (const [key, cell] of Object.entries(draft.cells)) {
    const before = sent.cells[key]
    const now = saved.cells[key]
    if (!before || !now) continue
    cells[key] = { ...cell, stock: Math.max(0, now.stock + cell.stock - before.stock) }
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
