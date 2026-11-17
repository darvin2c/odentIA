import { setTimeout as delay } from "node:timers/promises"

interface MailpitMessageSummary {
  ID: string
  To: { Address: string }[]
  Subject: string
  Created: string
}

async function requestJson(url: string, remaining: number): Promise<unknown> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))),
    })
    if (!response.ok) throw new Error(`Mailpit respondió HTTP ${response.status}`)
    return await response.json()
  } catch (cause) {
    throw new Error("No se pudo consultar Mailpit", { cause })
  }
}

function summaries(value: unknown): MailpitMessageSummary[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("messages" in value) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("Respuesta de búsqueda Mailpit inválida")
  }
  for (const message of value.messages) {
    if (
      typeof message?.ID !== "string" ||
      typeof message.Subject !== "string" ||
      typeof message.Created !== "string" ||
      !Array.isArray(message.To) ||
      !message.To.every((to: { Address?: unknown }) => typeof to?.Address === "string")
    ) {
      throw new Error("Mensaje de búsqueda Mailpit inválido")
    }
  }
  return value.messages
}

/** El HTML del último correo para esa dirección con ese asunto: para mirar cómo se ve, no solo su enlace. */
export async function latestHtmlFor(
  email: string,
  subjectIncludes: string,
  timeoutMs = 20_000,
): Promise<string> {
  return (await latestMessageFor(email, subjectIncludes, timeoutMs)).html
}

/** Busca en el buzón del caso, aunque haya más de 50 correos ajenos recientes. */
export async function latestLinkFor(
  email: string,
  subjectIncludes: string,
  timeoutMs = 20_000,
): Promise<string> {
  const { id, html, text } = await latestMessageFor(email, subjectIncludes, timeoutMs)
  const href = html.match(/href="(https:[^"]+)"/)?.[1]
  if (href) return href
  const url = html.match(/https:\/\/[^\s<>"']+/)?.[0] ?? text.match(/https:\/\/\S+/)?.[0]
  if (url) return url.replaceAll("&amp;", "&").replace(/[.,;)]+$/, "")
  throw new Error(`Correo ${id} sin enlace https`)
}

/**
 * El último correo para esa dirección con ese asunto, tenga o no un enlace (una respuesta de la
 * administración no lo trae): su HTML ya decodificado y su texto.
 */
export async function latestMessageFor(
  email: string,
  subjectIncludes: string,
  timeoutMs = 20_000,
): Promise<{ id: string; html: string; text: string }> {
  const base = process.env.MAILPIT_API
  if (!process.env.E2E_RUN_ID || !base)
    throw new Error("Ejecuta pnpm e2e para crear un entorno aislado")
  const query = new URLSearchParams({ query: `to:${email}`, start: "0", limit: "50" })
  const deadline = performance.now() + timeoutMs
  const intervals = [100, 250, 500, 1_000]
  let attempt = 0
  while (performance.now() < deadline) {
    const messages = summaries(
      await requestJson(`${base}/search?${query}`, deadline - performance.now()),
    )
    const match = messages
      .filter(
        (message) =>
          message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()) &&
          message.Subject.includes(subjectIncludes),
      )
      .sort((a, b) => b.Created.localeCompare(a.Created))[0]
    if (match) {
      const result = await requestJson(
        `${base}/message/${encodeURIComponent(match.ID)}`,
        deadline - performance.now(),
      )
      if (
        !result ||
        typeof result !== "object" ||
        (!("HTML" in result) && !("Text" in result)) ||
        ("HTML" in result && typeof result.HTML !== "string") ||
        ("Text" in result && typeof result.Text !== "string")
      ) {
        throw new Error("Contenido de correo Mailpit inválido")
      }
      const html = ("HTML" in result ? (result.HTML as string) : "").replaceAll("&amp;", "&")
      const text = "Text" in result ? (result.Text as string) : ""
      return { id: match.ID, html, text }
    }
    await delay(
      Math.max(
        0,
        Math.min(
          intervals[Math.min(attempt++, intervals.length - 1)]!,
          deadline - performance.now(),
        ),
      ),
    )
  }
  throw new Error(`Sin correo para ${email} con asunto ~ "${subjectIncludes}" en ${timeoutMs}ms`)
}
