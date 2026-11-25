/**
 * La llave de los topes por dirección de las rutas públicas. Una IPv4 cuenta sola; una IPv6,
 * por su red /64, porque a una casa, un teléfono o un servidor se le da esa red entera
 * (RFC 6177): contar cada dirección dejaría que una sola máquina cambie de dirección en cada
 * envío y nunca llegue al tope. Sin dirección, una llave común.
 */
export function rateKeyOf(address: string | null | undefined): string {
  const value = address?.trim().toLowerCase()
  if (!value) return "shared"
  if (!value.includes(":")) return value
  // Una IPv4 escrita como IPv6 («::ffff:203.0.113.5») es esa IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (mapped?.[1]) return mapped[1]
  const prefix = ipv6Prefix(value.split("%")[0] ?? "")
  return prefix ? `${prefix}::/64` : value
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/
const IPV4_TAIL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Los cuatro primeros grupos de una IPv6, sin ceros a la izquierda; null si no es una. */
function ipv6Prefix(value: string): string | null {
  const halves = value.split("::")
  if (halves.length > 2) return null
  const groupsOf = (text: string) => (text ? text.split(":") : [])
  const left = groupsOf(halves[0] ?? "")
  const right = halves.length === 2 ? groupsOf(halves[1] ?? "") : []
  const all = [...left, ...right]
  const last = all.length - 1
  if (!all.every((group, index) => HEX_GROUP.test(group) || (index === last && IPV4_TAIL.test(group)))) return null
  // Una IPv4 al final («64:ff9b::192.0.2.1») ocupa dos grupos.
  const size = all.length + (IPV4_TAIL.test(all[last] ?? "") ? 1 : 0)
  if (halves.length === 1 ? size !== 8 : size > 7) return null
  const zeros = halves.length === 2 ? Array<string>(8 - size).fill("0") : []
  return [...left, ...zeros, ...right]
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")
}
