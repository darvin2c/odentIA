import type { Db } from "@odentia/db"
import { type ClinicHosts, syncClinicHosts } from "@odentia/services"

/** Cada cuánto el worker pone al día la regla de hosts permitidos de cada zona (ADR 0193). */
export const CLINIC_HOSTS_EVERY_MS = 3_600_000

/**
 * La reconciliación de la regla de hosts permitidos de Cloudflare (ADR 0193): al arrancar
 * y cada hora, lo que no se sincronizó al crear o borrar una clínica (Cloudflare caído en
 * ese momento). Es un GET por zona y solo escribe si la lista cambió, así que una clínica
 * nueva no queda bloqueada más de una hora. Sin esperarla, como los videos de la Ayuda:
 * Cloudflare lento no detiene la ingesta ni el envío.
 */
export function clinicHostsQueue(
  ownerDb: Db,
  clinicHosts: ClinicHosts,
  sync: typeof syncClinicHosts = syncClinicHosts,
  now: () => number = Date.now,
): { name: string; poll: () => Promise<boolean> } {
  let next = 0
  return {
    name: "clinic_hosts",
    poll: async () => {
      if (now() < next) return false
      next = now() + CLINIC_HOSTS_EVERY_MS
      void sync(ownerDb, clinicHosts)
      return false
    },
  }
}
