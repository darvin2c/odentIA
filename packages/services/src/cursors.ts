/** Cursores opacos base64url con JSON {ts, id} para listados con cursor. */
export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), "utf8").toString("base64url")
}

export function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object" || !("ts" in parsed) || !("id" in parsed)) return null
    const { ts, id } = parsed
    if (typeof ts !== "string" || typeof id !== "string") return null
    return { ts, id }
  } catch {
    return null
  }
}
