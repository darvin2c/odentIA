import type { HostsFirewall, HostsRuleOutcome } from "./clinic-hosts.js"

/**
 * El adaptador de Cloudflare de la lista de hosts permitidos (ADR 0193): la API de
 * Rulesets, en la fase de las reglas personalizadas de la zona
 * (`http_request_firewall_custom`). Lee la entrada de la fase y crea o cambia solo la
 * regla con la descripción dada: las demás (la del robot de escaneo, las que ponga el
 * dueño) no se tocan, y nunca se reescribe la entrada entera. La regla nueva va al
 * final, con Block y encendida; de la que ya está solo cambia la expresión: si alguien
 * la apagó o le cambió la acción en el panel, queda así.
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const PHASE = "http_request_firewall_custom"

interface CloudflareRule {
  id: string
  description?: string
  expression?: string
  action?: string
  action_parameters?: unknown
  logging?: unknown
  enabled?: boolean
}

interface CloudflareRuleset {
  id: string
  rules?: CloudflareRule[]
}

interface CloudflareAnswer<T> {
  success?: boolean
  result?: T | null
  errors?: Array<{ code?: number; message?: string }>
}

interface Reply<T> {
  status: number
  ok: boolean
  answer: CloudflareAnswer<T> | null
}

/** Lo que Cloudflare no aceptó, con su código; nunca lleva el token. */
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Cloudflare respondió ${status}${detail ? `: ${detail}` : ""}`)
    this.name = "CloudflareApiError"
  }
}

export function cloudflareHostsFirewall(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): HostsFirewall {
  async function request<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const answer = (await response.json().catch(() => null)) as CloudflareAnswer<T> | null
    return { status: response.status, ok: response.ok && answer?.success !== false, answer }
  }

  function resultOf<T>(reply: Reply<T>): T | null {
    if (reply.ok) return reply.answer?.result ?? null
    const detail = (reply.answer?.errors ?? [])
      .map((error) => `${error.message ?? ""} (${error.code ?? "?"})`)
      .join("; ")
    throw new CloudflareApiError(reply.status, detail)
  }

  return {
    async putRule(zoneId, rule): Promise<HostsRuleOutcome> {
      const rulesets = `/zones/${encodeURIComponent(zoneId)}/rulesets`
      const entry = await request<CloudflareRuleset>(
        "GET",
        `${rulesets}/phases/${PHASE}/entrypoint`,
      )
      if (entry.status === 404) {
        // La zona todavía no tiene reglas personalizadas: su entrada nace con esta.
        resultOf(
          await request("POST", rulesets, {
            name: "default",
            kind: "zone",
            phase: PHASE,
            rules: [{ action: "block", ...rule, enabled: true }],
          }),
        )
        return "creada"
      }
      const ruleset = resultOf(entry)
      if (!ruleset?.id)
        throw new CloudflareApiError(entry.status, "sin la entrada de las reglas personalizadas")
      const base = `${rulesets}/${encodeURIComponent(ruleset.id)}/rules`
      const current = ruleset.rules?.find((one) => one.description === rule.description)
      if (!current) {
        resultOf(await request("POST", base, { action: "block", ...rule, enabled: true }))
        return "creada"
      }
      if (current.expression === rule.expression) return "igual"
      resultOf(
        await request("PATCH", `${base}/${encodeURIComponent(current.id)}`, {
          // Lo que no tiene (undefined) no sale en el JSON.
          action: current.action ?? "block",
          action_parameters: current.action_parameters,
          logging: current.logging,
          ...rule,
          enabled: current.enabled ?? true,
        }),
      )
      return "cambiada"
    },
  }
}
