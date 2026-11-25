// El texto de las guías admite **negrita** y [enlaces](/ruta) a la propia web (`#` incluido): lo
// justo para escribirlas en un archivo sin HTML. Un enlace a otra web no se arma: queda su texto.

export type RichPart = { text: string; bold?: true; href?: string }

const TOKEN = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** Los trozos de un texto, en orden: texto, negrita o enlace interno. */
export function richParts(text: string): RichPart[] {
  const parts: RichPart[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at) })
    const [, bold, label, href] = match
    if (bold !== undefined) parts.push({ text: bold, bold: true })
    else if (label !== undefined && href !== undefined)
      parts.push(href.startsWith("/") || href.startsWith("#") ? { text: label, href } : { text: label })
    last = at + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

/** El texto sin marcas: para Google y para contar los minutos de lectura. */
export function plainText(text: string): string {
  return richParts(text)
    .map((part) => part.text)
    .join("")
}
