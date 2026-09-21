/**
 * Permisos y contexto de usuario para las maquetas de Storybook: la página real
 * los toma del router (`getRouteApi("/_org")`), que no existe dentro del
 * Storybook. Todo lo demás del dominio es el código real.
 */
export function useCanWrite(): boolean {
  return true
}

export function useMyUserId(): string {
  return "demo-user"
}

export function useOrgMembers(): Array<{ userId: string; role: string; user: { name: string } }> {
  return [
    { userId: "demo-user", role: "admin", user: { name: "Dra. Ana Torres" } },
    { userId: "demo-user-2", role: "member", user: { name: "Dr. Luis Paredes" } },
  ]
}

/** «Hace cuánto» corto en es-PE, igual que en el platform. */
export function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return "ahora"
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 30) return `hace ${days} d`
  return new Date(iso).toLocaleDateString("es-PE")
}
