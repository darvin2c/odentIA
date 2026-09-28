import { setTimeout as delay } from "node:timers/promises"

interface MailpitMessageSummary {
  ID: string
  To: { Address: string }[]
  Subject: string
  Created: string
}

async function requestJson(url: string, remaining: number): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))) })
    if (!response.ok) throw new Error(`Mailpit respondió HTTP ${response.status}`)
    return await response.json()
  } catch (cause) {
    throw new Error("No se pudo consultar Mailpit", { cause })
  }
}

function summaries(value: unknown): MailpitMessageSummary[] {
  if (!value || typeof value !== "object" || !("messages" in value) || !Array.isArray(value.messages)) {
    throw new Error("Respuesta de búsqueda Mailpit inválida")
  }
  for (const message of value.messages) {
    if (typeof message?.ID !== "string" || typeof message.Subject !== "string" || typeof message.Created !== "string" ||
        !Array.isArray(message.To) || !message.To.every((to: { Address?: unknown }) => typeof to?.Address === "string")) {
      throw new Error("Mensaje de búsqueda Mailpit inválido")
    }
  }
  return value.messages
}

/** Busca en el buzón del caso, aunque haya más de 50 correos ajenos recientes. */
export async function latestLinkFor(email: string, subjectIncludes: string, timeoutMs = 20_000): Promise<string> {
  const base = process.env.MAILPIT_API
  if (!process.env.E2E_RUN_ID || !base) throw new Error("Ejecuta pnpm e2e para crear un entorno aislado")
  const query = new URLSearchParams({ query: `to:${email}`, start: "0", limit: "50" })
  const deadline = performance.now() + timeoutMs
  const intervals = [100, 250, 500, 1_000]
  let attempt = 0
  while (performance.now() < deadline) {
    const messages = summaries(await requestJson(`${base}/search?${query}`, deadline - performance.now()))
    const match = messages.filter(message =>
      message.To.some(to => to.Address.toLowerCase() === email.toLowerCase()) && message.Subject.includes(subjectIncludes),
    ).sort((a, b) => b.Created.localeCompare(a.Created))[0]
    if (match) {
      const result = await requestJson(`${base}/message/${encodeURIComponent(match.ID)}`, deadline - performance.now())
      if (!result || typeof result !== "object" ||
          (!("HTML" in result) && !("Text" in result)) ||
          ("HTML" in result && typeof result.HTML !== "string") ||
          ("Text" in result && typeof result.Text !== "string")) {
        throw new Error("Contenido de correo Mailpit inválido")
      }
      const decoded = ("HTML" in result ? result.HTML as string : "").replaceAll("&amp;", "&")
      const text = "Text" in result ? result.Text as string : ""
      const href = decoded.match(/href="(https:[^"]+)"/)?.[1]
      if (href) return href
      const url = decoded.match(/https:\/\/[^\s<>"']+/)?.[0] ?? text.match(/https:\/\/\S+/)?.[0]
      if (url) return url.replaceAll("&amp;", "&").replace(/[.,;)]+$/, "")
      throw new Error(`Correo ${match.ID} sin enlace https`)
    }
    await delay(Math.max(0, Math.min(intervals[Math.min(attempt++, intervals.length - 1)]!, deadline - performance.now())))
  }
  throw new Error(`Sin correo para ${email} con asunto ~ "${subjectIncludes}" en ${timeoutMs}ms`)
}
