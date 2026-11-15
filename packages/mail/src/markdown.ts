/**
 * El formato básico de lo que escribe una persona del equipo en un correo
 * (responder o escribir desde la administración): un subconjunto de Markdown
 * (CommonMark) y nada más. `**negrita**`, `*cursiva*` o `_cursiva_`,
 * `[texto](https://…)`, las direcciones sueltas como enlace y las listas con
 * «- » o «1. ». Lo demás (títulos, tablas, imágenes, código, HTML) sale como
 * texto: no rompe el molde del correo y nada que escriba alguien se vuelve
 * HTML. Solo enlaces `https:` y `mailto:` (una dirección `javascript:` o
 * `http:` queda como texto).
 *
 * Puro y sin dependencias: lo usan el envío (`renderEmail`, HTML y texto
 * plano) y la vista previa de la administración (con los mismos bloques).
 */

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "em"; children: MarkdownInline[] }
  | { kind: "link"; href: string; text: string }

export type MarkdownBlock =
  | { kind: "paragraph"; lines: MarkdownInline[][] }
  | {
      kind: "list"
      ordered: boolean
      /** El número con que empieza una lista numerada: se respeta el que escribió. */
      start: number
      items: MarkdownInline[][]
    }

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/

/** Un enlace que se acepta: https con host, o mailto con una dirección. */
export function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (/^mailto:[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/i.test(href)) return href
  try {
    const url = new URL(href)
    return url.protocol === "https:" && url.hostname ? href : null
  } catch {
    return null
  }
}

/*
 * Un solo recorrido por la línea: enlace con texto, negrita, cursiva (con * o
 * con _, que no corta palabras como «mi_archivo») y dirección suelta. Lo que no
 * cierra queda como texto, con sus marcas.
 */
const INLINE =
  /\[([^\]\n]{1,500})\]\(((?:[^()\s]|\([^()\s]{0,500}\)){1,2000})\)|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])|((?:https:\/\/|mailto:)[^\s<>"]+)/gu

/**
 * Lo que cierra una oración no es parte de la dirección suelta: «https://a.pe.»
 * o «(ver https://a.pe)». Un «)» que cierra uno de la dirección se queda:
 * «https://es.wikipedia.org/wiki/Lima_(Perú)».
 */
function trimUrl(url: string): { url: string; rest: string } {
  const count = (text: string, char: string) => text.split(char).length - 1
  let end = url.length
  while (end > 0) {
    const head = url.slice(0, end)
    const last = head.at(-1) ?? ""
    if (/[.,;:!?\]'"»]/.test(last)) end--
    else if (last === ")" && count(head, ")") > count(head, "(")) end--
    else break
  }
  return { url: url.slice(0, end), rest: url.slice(end) }
}

function pushText(out: MarkdownInline[], text: string) {
  if (!text) return
  const last = out.at(-1)
  if (last?.kind === "text") last.text += text
  else out.push({ kind: "text", text })
}

export function parseInline(line: string): MarkdownInline[] {
  const out: MarkdownInline[] = []
  let at = 0
  for (const match of line.matchAll(INLINE)) {
    const start = match.index ?? 0
    pushText(out, line.slice(at, start))
    at = start + match[0].length
    const [whole, linkText, linkHref, strong, star, under, bare] = match
    if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref)
      if (href) out.push({ kind: "link", href, text: linkText })
      else pushText(out, whole)
    } else if (strong !== undefined) {
      out.push({ kind: "strong", children: parseInline(strong) })
    } else if (star !== undefined || under !== undefined) {
      out.push({ kind: "em", children: parseInline(star ?? under ?? "") })
    } else if (bare !== undefined) {
      const { url, rest } = trimUrl(bare)
      const href = safeHref(url)
      if (href) out.push({ kind: "link", href, text: url.replace(/^mailto:/i, "") })
      else pushText(out, url)
      pushText(out, rest)
    }
  }
  pushText(out, line.slice(at))
  return out
}

/** Los bloques del texto: párrafos (separados por una línea en blanco) y listas. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph.map(parseInline) })
    paragraph = []
  }
  const flushList = () => {
    if (list)
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map(parseInline),
      })
    list = null
  }
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }
      list.items.push((numbered ? numbered[2] : bullet?.[1]) ?? "")
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}

/** El texto plano de una línea: sin marcas; un enlace con su dirección entre paréntesis. */
export function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text
      if (node.kind === "link") {
        const shown = node.href.replace(/^mailto:/i, "")
        return node.text === shown ? node.text : `${node.text} (${shown})`
      }
      return inlineText(node.children)
    })
    .join("")
}

/** El texto plano de todo (la versión de texto del correo, la vista corta de la bandeja). */
export function markdownText(blocks: readonly MarkdownBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === "paragraph"
        ? block.lines.map(inlineText).join("\n")
        : block.items
            .map(
              (item, index) =>
                `${block.ordered ? `${block.start + index}.` : "-"} ${inlineText(item)}`,
            )
            .join("\n"),
    )
    .join("\n\n")
}
