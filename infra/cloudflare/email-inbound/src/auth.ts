/**
 * ¿El remitente es quien dice el From? El From de un correo se puede escribir a mano: sin esto,
 * cualquiera podría mandar «de» una clínica y la administración lo ligaría a su ficha.
 *
 * Cloudflare Email Routing deja arriba del correo lo que comprobó (RFC 8601 y RFC 8617):
 * `ARC-Authentication-Results` o `Authentication-Results` con su servidor (`mx.cloudflare.net`).
 * Solo vale el de más arriba, el último que se agregó: uno que trae el correo desde afuera queda
 * debajo y no cuenta. El remitente está verificado si DMARC pasa con el dominio del From, o si SPF
 * o DKIM pasan con un dominio alineado (el mismo o uno de sus subdominios, RFC 7489 §3.1).
 * Lo que no se puede leer no se da por verificado: el correo queda para que una persona diga de
 * quién es.
 */

/** Una cabecera como la da postal-mime: nombre en minúsculas y su valor. */
export interface MailHeader {
  key: string
  value: string
}

/** El servidor de Cloudflare que firma lo que comprobó. */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net"

const RESULT_HEADERS = new Set(["arc-authentication-results", "authentication-results"])

/** Quita los comentarios entre paréntesis (pueden traer «;» o «=pass» que no son resultados). */
function withoutComments(value: string): string {
  let out = ""
  let depth = 0
  for (const char of value) {
    if (char === "(") depth++
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0) out += char
  }
  return out
}

/** «a.clinica.test» y «clinica.test» están alineados (relajado); otros dominios, no. */
function aligned(domain: string, fromDomain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "")
  return d === fromDomain || d.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${d}`)
}

/** El dominio de una dirección o de un `smtp.mailfrom` («usuario@dominio» o solo «dominio»). */
function domainOf(value: string): string {
  const at = value.lastIndexOf("@")
  return (at >= 0 ? value.slice(at + 1) : value)
    .trim()
    .toLowerCase()
    .replace(/[>;]+$/, "")
}

/**
 * Lee el resultado de más arriba de Cloudflare y dice si el remitente del From está verificado.
 * `headers` en el orden del correo (el primero es el de más arriba).
 */
export function senderVerified(
  headers: readonly MailHeader[],
  from: string,
  authservId: string = CLOUDFLARE_AUTHSERV_ID,
): boolean {
  const fromDomain = from.includes("@") ? domainOf(from) : ""
  if (!fromDomain) return false
  const top = headers.find((header) => RESULT_HEADERS.has(header.key.toLowerCase()))
  if (!top) return false
  const parts = withoutComments(top.value)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
  // En ARC, el primero es la instancia (`i=1`); después, el servidor que comprobó.
  if (parts[0] && /^i=\d+$/i.test(parts[0])) parts.shift()
  const server = (parts.shift() ?? "").split(/\s+/)[0]?.toLowerCase()
  if (server !== authservId.toLowerCase()) return false
  for (const part of parts) {
    const [result, ...props] = part.split(/\s+/)
    const [method, outcome] = (result ?? "").toLowerCase().split("=")
    if (outcome !== "pass") continue
    const prop = (name: string) =>
      props.find((p) => p.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1) ?? ""
    if (method === "dmarc" && domainOf(prop("header.from")) === fromDomain) return true
    if (method === "dkim" && prop("header.d") && aligned(prop("header.d"), fromDomain)) return true
    if (
      method === "spf" &&
      prop("smtp.mailfrom") &&
      aligned(domainOf(prop("smtp.mailfrom")), fromDomain)
    )
      return true
  }
  return false
}
