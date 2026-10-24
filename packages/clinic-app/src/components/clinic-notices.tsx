/**
 * La franja de avisos de la clínica (ADR 0065), con lo que entrega el
 * servidor (`/api/account/billing/notices`): qué ve cada persona y con qué
 * texto lo decide el servicio, no esta pantalla. Aquí solo se pinta, se
 * recuerda quién cerró qué y se resuelve cada acción.
 */
import { type StripNotice, NoticeStrip } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, useNavigate, useRouterState } from "@tanstack/react-router"
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { apiFetch } from "../lib/api"
import { useReceptionName, withReceptionName } from "../lib/agent-names"
import { PLAN_PATH } from "../lib/billing"
import { RouterLink } from "../lib/router-link"
import type { Consumption } from "./billing/consumption"
import { SpendCapDrawer } from "./billing/spend-cap"

export type ClinicNoticeAction =
  | { kind: "pagar" | "elegir_plan" | "ver_plan" | "ver_consumo" | "subir_tope" | "escribir_soporte"; label: string; shortLabel: string }
  | { kind: "quitar_acceso"; label: string; shortLabel: string; grantId: string; caseId: string }

export interface ClinicNotice {
  id: string
  topic: "cobro" | "tope" | "plan" | "soporte"
  tone: "aviso" | "alarma" | "limite"
  message: string
  short: string
  action: ClinicNoticeAction | null
  dismiss: "nivel" | "dia" | null
}

const orgRouteApi = getRouteApi("/_org")
const noticesKey = (orgId: string) => ["saas", orgId, "notices"] as const

/** Los avisos de la clínica para quien mira; la misma consulta para la franja, el menú y la Bandeja. */
export function useClinicNotices() {
  const { org } = orgRouteApi.useRouteContext()
  return useQuery({
    queryKey: noticesKey(org.id),
    queryFn: () =>
      apiFetch<{ data: ClinicNotice[] }>(`/api/account/billing/notices?orgId=${encodeURIComponent(org.id)}`).then((res) => res.data),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  })
}

/* ---- Lo cerrado con la X: de cada persona, en este navegador ---- */

const today = () => new Date().toISOString().slice(0, 10)

function readClosed(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeClosed(key: string, value: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Sin almacenamiento, el aviso vuelve a verse al recargar.
  }
}

/** Un aviso «por hoy» vuelve al día siguiente; uno «hasta subir de nivel» cambia de id al subir. */
function isClosed(notice: ClinicNotice, closed: Record<string, string>): boolean {
  if (!notice.dismiss) return false
  const when = closed[notice.id]
  if (!when) return false
  return notice.dismiss === "nivel" || when === today()
}

/* ---- Subir el tope desde la franja ---- */

const RaiseCapContext = createContext<() => void>(() => undefined)

/** Abre el formulario del tope desde cualquier pantalla (franja, Bandeja). */
export function useRaiseCap(): () => void {
  return useContext(RaiseCapContext)
}

function RaiseCapProvider({ children }: { children: ReactNode }) {
  const { org } = orgRouteApi.useRouteContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const consumption = useQuery({
    queryKey: ["billing", org.id, "consumption"],
    queryFn: () =>
      apiFetch<{ data: Consumption }>(`/api/account/billing/consumption?orgId=${encodeURIComponent(org.id)}`).then((res) => res.data),
    enabled: open,
    retry: false,
  })
  const save = async (capCents: number | null) => {
    await apiFetch("/api/account/billing/spend-cap", { method: "POST", body: JSON.stringify({ orgId: org.id, capCents }) })
    void queryClient.invalidateQueries({ queryKey: ["billing", org.id] })
    void queryClient.invalidateQueries({ queryKey: ["saas", org.id] })
  }
  const data = consumption.data
  return (
    <RaiseCapContext.Provider value={useCallback(() => setOpen(true), [])}>
      {children}
      {data ? (
        <SpendCapDrawer
          open={open}
          currency={data.currency ?? "USD"}
          currentCents={data.spendCapCents ?? null}
          projectedOverCents={data.projectedCents !== null ? Math.max(0, data.projectedCents - data.creditCents) : null}
          onClose={() => setOpen(false)}
          onSave={save}
        />
      ) : null}
    </RaiseCapContext.Provider>
  )
}

/* ---- La franja ---- */

function Strip({ userId }: { userId: string }) {
  const receptionName = useReceptionName()
  const { org } = orgRouteApi.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const raiseCap = useRaiseCap()
  const notices = useClinicNotices()
  const storageKey = `odentia:avisos-cerrados:${userId}`
  const [closed, setClosed] = useState(() => readClosed(storageKey))

  const revoke = useMutation({
    retry: false,
    mutationFn: (action: { grantId: string; caseId: string }) =>
      apiFetch(`/api/help/cases/${encodeURIComponent(action.caseId)}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId: action.grantId }),
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: noticesKey(org.id) }),
  })

  const items = useMemo<StripNotice[]>(() => {
    const close = (id: string) => {
      const next = { ...closed, [id]: today() }
      writeClosed(storageKey, next)
      setClosed(next)
    }
    return (notices.data ?? [])
      .filter((notice) => !isClosed(notice, closed))
      .map((notice) => {
        const action = notice.action
        let stripAction: StripNotice["action"]
        if (action) {
          const base = { label: action.label, shortLabel: action.shortLabel }
          if (action.kind === "subir_tope") stripAction = { ...base, onSelect: raiseCap }
          else if (action.kind === "quitar_acceso") stripAction = { ...base, onSelect: () => revoke.mutate(action) }
          else if (action.kind === "escribir_soporte")
            stripAction = { ...base, onSelect: () => void navigate({ to: pathname, search: { ayuda: "casos" } as never }) }
          else stripAction = { ...base, to: PLAN_PATH }
        }
        return {
          id: notice.id,
          tone: notice.tone,
          message: withReceptionName(notice.message, receptionName),
          short: withReceptionName(notice.short, receptionName),
          action: stripAction,
          onDismiss: notice.dismiss ? () => close(notice.id) : undefined,
        }
      })
  }, [notices.data, closed, storageKey, raiseCap, revoke, navigate, pathname, receptionName])

  return <NoticeStrip notices={items} LinkComponent={RouterLink} />
}

/**
 * Lo que la clínica pinta encima de todo: la franja y, alrededor, el
 * formulario del tope que abren sus acciones. Va en el `notice` del AppShell;
 * `RaiseCapProvider` envuelve además el contenido para que la Bandeja lo abra.
 */
export function ClinicNoticeStrip({ userId }: { userId: string }) {
  return <Strip userId={userId} />
}

export { RaiseCapProvider }
