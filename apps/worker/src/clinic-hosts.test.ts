import type { Db } from "@odentia/db"
import type { ClinicHosts } from "@odentia/services"
import { expect, it, vi } from "vitest"
import { CLINIC_HOSTS_EVERY_MS, clinicHostsQueue } from "./clinic-hosts.js"

/**
 * La reconciliación de la regla de hosts permitidos (ADR 0193): al arrancar y cada hora,
 * sin esperar a Cloudflare. La sincronización es un doble: nada llama a la API real.
 */

const ownerDb = {} as Db
const clinicHosts = {
  firewall: { putRule: vi.fn() },
  domains: {},
  zones: [],
} as unknown as ClinicHosts

it("reconcilia al arrancar y después cada hora, sin frenar el ciclo", async () => {
  let clock = 1_000_000
  const sync = vi.fn(async () => null)
  const queue = clinicHostsQueue(ownerDb, clinicHosts, sync, () => clock)
  expect(queue.name).toBe("clinic_hosts")

  // Al arrancar: la primera vuelta ya reconcilia, y no cuenta como trabajo hecho.
  expect(await queue.poll()).toBe(false)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledWith(ownerDb, clinicHosts)

  // Antes de la hora, las vueltas del ciclo no la repiten.
  clock += CLINIC_HOSTS_EVERY_MS - 1
  await queue.poll()
  expect(sync).toHaveBeenCalledTimes(1)

  // A la hora, otra vez; y la siguiente, una hora después de esa.
  clock += 1
  await queue.poll()
  expect(sync).toHaveBeenCalledTimes(2)
  clock += CLINIC_HOSTS_EVERY_MS
  await queue.poll()
  expect(sync).toHaveBeenCalledTimes(3)
  expect(CLINIC_HOSTS_EVERY_MS).toBe(3_600_000)
})

it("no espera a Cloudflare: una sincronización lenta no detiene la vuelta", async () => {
  const sync = vi.fn(() => new Promise<null>(() => undefined))
  const queue = clinicHostsQueue(ownerDb, clinicHosts, sync, () => 0)
  await expect(queue.poll()).resolves.toBe(false)
  expect(sync).toHaveBeenCalledTimes(1)
})
