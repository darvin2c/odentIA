/**
 * Lo puro del editor de respuesta (ADR 0196): cómo se dibujan las marcas mientras se escribe, las
 * reglas de largo de cada canal, la lista con «- » y la diferencia palabra por palabra que muestra
 * «Mejorar con Kairós». Sin React, para probarlo solo.
 *
 * Las marcas son las de WhatsApp, las mismas que el correo dibuja (`@odentia/mail/markdown`):
 * `*negrita*` (y `**negrita**`), `_cursiva_`, `~tachado~`, `[texto](https://…)` y las listas.
 */

/** Cómo se ve cada trozo del texto en el editor. Las marcas se ven, más tenues. */
export type SegmentStyle = "plain" | "mark" | "bold" | "italic" | "strike" | "link" | "list"

export interface Segment {
  text: string
  style: SegmentStyle
}

/*
 * El mismo recorrido que `parseInline` del correo, pero sin quitar nada: cada carácter del texto
 * queda en un trozo, para que la copia dibujada calce letra por letra con lo que se escribe.
 */
const INLINE =
  /\[([^\]\n]{1,500})\]\(([^()\s\n]{1,2000})\)|\*\*(?=\S)([^\n]+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])([^\n]+?)(?<=[^\s*])\*(?![\w*])|(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}~])~(?=[^\s~])([^\n]+?)(?<=[^\s~])~(?![\p{L}\p{N}~])/gu

const LIST_MARKER = /^(\s{0,3}(?:[-*+•]|\d{1,9}[.)])\s+)/

function pushSegment(out: Segment[], text: string, style: SegmentStyle) {
  if (!text) return
  const last = out.at(-1)
  if (last && last.style === style) last.text += text
  else out.push({ text, style })
}

function lineSegments(line: string, out: Segment[]) {
  let rest = line
  const marker = LIST_MARKER.exec(line)
  if (marker?.[1]) {
    pushSegment(out, marker[1], "list")
    rest = line.slice(marker[1].length)
  }
  let at = 0
  for (const match of rest.matchAll(INLINE)) {
    const start = match.index ?? 0
    pushSegment(out, rest.slice(at, start), "plain")
    at = start + match[0].length
    const [, linkText, linkHref, double, star, under, tilde] = match
    if (linkText !== undefined && linkHref !== undefined) {
      pushSegment(out, "[", "mark")
      pushSegment(out, linkText, "link")
      pushSegment(out, `](${linkHref})`, "mark")
    } else {
      const inner = double ?? star ?? under ?? tilde ?? ""
      const mark = double !== undefined ? "**" : star !== undefined ? "*" : under !== undefined ? "_" : "~"
      const style: SegmentStyle =
        double !== undefined || star !== undefined ? "bold" : under !== undefined ? "italic" : "strike"
      pushSegment(out, mark, "mark")
      pushSegment(out, inner, style)
      pushSegment(out, mark, "mark")
    }
  }
  pushSegment(out, rest.slice(at), "plain")
}

/** El texto en trozos con su estilo; juntos, los trozos son exactamente el texto. */
export function editorSegments(value: string): Segment[] {
  const out: Segment[] = []
  const lines = value.split("\n")
  lines.forEach((line, index) => {
    if (index > 0) pushSegment(out, "\n", "plain")
    lineSegments(line, out)
  })
  return out
}

/** Si el texto usa marcas que un canal sin formato no muestra. */
export function hasMarks(value: string): boolean {
  return editorSegments(value).some((segment) => segment.style === "mark")
}

/** Las reglas de un canal, como las dice el servidor. */
export interface ChannelRules {
  channel: string
  maxChars: number | null
  maxBytes: number | null
  maxFiles: number
  maxTotalBytes: number | null
  files: { kind: string; types: string[]; maxBytes: number }[]
  formatting: "markdown" | "whatsapp" | "texto"
}

const bytesOf = (value: string) => new TextEncoder().encode(value).length

/** Cuánto lleva el texto y cuánto acepta el canal, para el contador. */
export function lengthOf(value: string, rules: Pick<ChannelRules, "maxChars" | "maxBytes"> | null) {
  if (rules?.maxBytes) {
    const used = bytesOf(value.trim())
    return { used, max: rules.maxBytes, unit: "bytes" as const, over: Math.max(0, used - rules.maxBytes) }
  }
  const used = [...value.trim()].length
  const max = rules?.maxChars ?? null
  return { used, max, unit: "caracteres" as const, over: max ? Math.max(0, used - max) : 0 }
}

/** Lo que falta corregir del texto para ese canal, o null si puede salir. */
export function textProblem(
  value: string,
  rules: Pick<ChannelRules, "maxChars" | "maxBytes"> | null,
  channelWords: string,
): string | null {
  const { over, unit } = lengthOf(value, rules)
  if (!over) return null
  return unit === "bytes"
    ? `Es largo para ${channelWords}: acórtalo un poco (sobran ${over} bytes; los tildes y emojis cuentan doble).`
    : `Es largo para ${channelWords}: sobran ${over} ${over === 1 ? "carácter" : "caracteres"}.`
}

export interface Edit {
  value: string
  selectionStart: number
  selectionEnd: number
}

/**
 * Pone o quita «- » al principio de cada línea tocada por la selección: si todas ya lo tienen, lo
 * quita; si no, se lo pone a las que faltan.
 */
export function toggleList(value: string, start: number, end: number): Edit {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1
  const nextBreak = value.indexOf("\n", end)
  const lineEnd = nextBreak === -1 ? value.length : nextBreak
  const block = value.slice(lineStart, lineEnd)
  // En una línea vacía empieza la lista: «Opciones:⏎» y Lista deja «- » para escribir.
  if (!block.trim()) {
    const next = `${value.slice(0, lineStart)}- ${value.slice(lineEnd)}`
    return { value: next, selectionStart: lineStart + 2, selectionEnd: lineStart + 2 }
  }
  const lines = block.split("\n")
  const all = lines.every((line) => /^\s{0,3}[-*+•]\s+/.test(line) || !line.trim())
  const next = lines
    .map((line) => {
      if (!line.trim()) return line
      return all ? line.replace(/^\s{0,3}[-*+•]\s+/, "") : /^\s{0,3}[-*+•]\s+/.test(line) ? line : `- ${line}`
    })
    .join("\n")
  const delta = next.length - block.length
  return {
    value: `${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`,
    selectionStart: start === end ? Math.max(lineStart, start + delta) : lineStart,
    selectionEnd: start === end ? Math.max(lineStart, end + delta) : lineEnd + delta,
  }
}

/** Un trozo de la diferencia entre lo que se escribió y lo que propone Kairós. */
export interface DiffPart {
  kind: "same" | "del" | "ins"
  text: string
}

const tokens = (value: string) => value.split(/(\s+)/).filter((token) => token !== "")

/**
 * La diferencia palabra por palabra (la subsecuencia común más larga). Si los textos son tan largos
 * que compararlos costaría, se muestra todo lo de antes tachado y todo lo nuevo.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length * b.length > 600_000)
    return [
      ...(before ? [{ kind: "del" as const, text: before }] : []),
      ...(after ? [{ kind: "ins" as const, text: after }] : []),
    ]
  const rows = a.length + 1
  const cols = b.length + 1
  const lcs = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * cols + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * cols + j] ?? 0, lcs[i * cols + j + 1] ?? 0)
  const out: DiffPart[] = []
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i] ?? "")
      i++
      j++
    } else if ((lcs[(i + 1) * cols + j] ?? 0) >= (lcs[i * cols + j + 1] ?? 0)) {
      push("del", a[i] ?? "")
      i++
    } else {
      push("ins", b[j] ?? "")
      j++
    }
  }
  while (i < a.length) push("del", a[i++] ?? "")
  while (j < b.length) push("ins", b[j++] ?? "")
  return out
}
