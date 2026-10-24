import { apiFetch } from "./api"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/** «Mi calendario» (issue 46, ADR 0082): lo que entrega `/api/agenda/calendar`. */
export type CalendarClient = "google" | "iphone" | "mac" | "outlook" | "navegador" | "otro"

export interface CalendarFeedUse {
  client: CalendarClient
  label: string
  since: string
  lastAt: string
  days: number
  isNew: boolean
}

export interface MyCalendarFeed {
  allowed: boolean
  preview: { summary: string; start: string; end: string; timeZone: string; location: string | null } | null
  feed: null | {
    createdAt: string
    url: string | null
    webcalUrl: string | null
    googleUrl: string | null
    lastUsedAt: string | null
    clients: CalendarFeedUse[]
    alert: { client: CalendarClient; label: string; at: string } | null
  }
}

export interface TeamCalendarFeed {
  userId: string
  createdAt: string
  lastUsedAt: string | null
  newUse: boolean
}

export const MY_CALENDAR_KEY = ["my-calendar-feed"] as const
export const TEAM_CALENDAR_KEY = ["team-calendar-feeds"] as const

export function fetchMyCalendarFeed(): Promise<{ data: MyCalendarFeed }> {
  return apiFetch("/api/agenda/calendar/mine")
}

export function createMyCalendarFeed(): Promise<{ data: MyCalendarFeed }> {
  return apiFetch("/api/agenda/calendar/mine", { method: "POST" })
}

export function rotateMyCalendarFeed(): Promise<{ data: MyCalendarFeed }> {
  return apiFetch("/api/agenda/calendar/mine/rotate", { method: "POST" })
}

export function revokeMyCalendarFeed(): Promise<unknown> {
  return apiFetch("/api/agenda/calendar/mine", { method: "DELETE" })
}

export function acknowledgeCalendarClient(client: CalendarClient): Promise<unknown> {
  return apiFetch("/api/agenda/calendar/mine/known", { method: "POST", body: JSON.stringify({ client }) })
}

export function fetchTeamCalendarFeeds(): Promise<{ data: TeamCalendarFeed[] }> {
  return apiFetch("/api/agenda/calendar/team")
}

export function revokeTeamCalendarFeed(userId: string): Promise<unknown> {
  return apiFetch(`/api/agenda/calendar/team/${encodeURIComponent(userId)}`, { method: "DELETE" })
}

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone() }).format(date)
}

/** «hoy 10:42», «ayer 22:10» o «20 oct 10:15», en la zona de la clínica. */
export function whenWords(iso: string, now = new Date()): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit", timeZone: activeOrgTimeZone() })
  if (dayKey(at) === dayKey(now)) return `hoy ${time}`
  if (dayKey(at) === dayKey(new Date(now.getTime() - 86_400_000))) return `ayer ${time}`
  const day = at.toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
  return `${day} ${time}`
}

/** «Todos los días · desde el 15 oct», «Solo ayer», «3 de los últimos 7 días». */
export function usageWords(use: CalendarFeedUse, now = new Date()): string {
  const since = new Date(`${use.since}T12:00:00Z`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: "UTC" })
  if (use.days >= 7) return `Todos los días · desde el ${since}`
  if (use.days === 1) {
    const day = dayKey(new Date(use.lastAt))
    if (day === dayKey(now)) return "Solo hoy"
    if (day === dayKey(new Date(now.getTime() - 86_400_000))) return "Solo ayer"
    return "Un día de los últimos 7"
  }
  return `${use.days} de los últimos 7 días · desde el ${since}`
}
