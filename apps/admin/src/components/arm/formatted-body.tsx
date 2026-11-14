/**
 * El formato básico de un correo que escribe el equipo (responder y
 * «Escribir» por correo): negrita, cursiva, enlaces y listas, con las mismas
 * reglas que el envío (`@odentia/mail/markdown`). Los botones solo escriben
 * las marcas en el texto, así que escribirlas a mano da lo mismo; «Vista
 * previa» lo muestra como le llega al cliente. Se dibuja con elementos de
 * React, nunca con HTML: nada de lo escrito se vuelve código.
 */
import { type MarkdownBlock, type MarkdownInline, parseMarkdown } from "@odentia/mail/markdown"
import { Button } from "@odentia/ui"
import { Bold, Eye, EyeOff, Italic, Link2 } from "lucide-react"
import { Fragment, type ReactNode, useState } from "react"

function Inline({ nodes }: { nodes: readonly MarkdownInline[] }): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`
    if (node.kind === "text") return <Fragment key={key}>{node.text}</Fragment>
    if (node.kind === "strong")
      return (
        <strong key={key}>
          <Inline nodes={node.children} />
        </strong>
      )
    if (node.kind === "em")
      return (
        <em key={key}>
          <Inline nodes={node.children} />
        </em>
      )
    return (
      <a
        key={key}
        href={node.href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline [overflow-wrap:anywhere]"
      >
        {node.text}
      </a>
    )
  })
}

function Block({ block }: { block: MarkdownBlock }) {
  if (block.kind === "paragraph")
    return (
      <p>
        {block.lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: las líneas no tienen otra identidad.
          <Fragment key={index}>
            {index > 0 ? <br /> : null}
            <Inline nodes={line} />
          </Fragment>
        ))}
      </p>
    )
  const List = block.ordered ? "ol" : "ul"
  return (
    <List className={block.ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
      {block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: los puntos no tienen otra identidad.
        <li key={index}>
          <Inline nodes={item} />
        </li>
      ))}
    </List>
  )
}

/** El texto con su formato: en la vista previa y en lo que ya se le respondió. */
export function FormattedText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 [overflow-wrap:anywhere] ${className ?? ""}`}>
      {parseMarkdown(text).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: los bloques no tienen otra identidad.
        <Block key={index} block={block} />
      ))}
    </div>
  )
}

export interface Edit {
  value: string
  /** Lo que queda seleccionado después (para seguir escribiendo). */
  selectionStart: number
  selectionEnd: number
}

/** Envuelve lo seleccionado con `mark`, o lo quita si ya lo tenía; sin selección, deja el cursor en medio. */
export function wrapSelection(value: string, start: number, end: number, mark: string): Edit {
  const before = value.slice(0, start)
  const selected = value.slice(start, end)
  const after = value.slice(end)
  if (before.endsWith(mark) && after.startsWith(mark))
    return {
      value: `${before.slice(0, -mark.length)}${selected}${after.slice(mark.length)}`,
      selectionStart: start - mark.length,
      selectionEnd: end - mark.length,
    }
  return {
    value: `${before}${mark}${selected}${mark}${after}`,
    selectionStart: start + mark.length,
    selectionEnd: end + mark.length,
  }
}

/**
 * Un enlace: si lo seleccionado es una dirección, queda `[dirección](dirección)`;
 * si no, `[lo seleccionado](https://)` con «https://» seleccionado para pegar la dirección.
 */
export function insertLink(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end).trim()
  const isUrl = /^(https:\/\/|mailto:)\S+$/i.test(selected)
  const text = selected || "texto del enlace"
  const href = isUrl ? selected : "https://"
  const link = `[${text}](${href})`
  const next = `${value.slice(0, start)}${link}${value.slice(end)}`
  const hrefAt = start + text.length + 3
  return isUrl
    ? { value: next, selectionStart: start + link.length, selectionEnd: start + link.length }
    : { value: next, selectionStart: hrefAt, selectionEnd: hrefAt + href.length }
}

/**
 * Los botones sobre el texto (negrita, cursiva, enlace) y «Vista previa».
 * Actúan sobre el `<textarea>` con `textareaId` y devuelven el texto nuevo.
 */
export function FormatTools({
  textareaId,
  value,
  onChange,
  previewNote,
}: {
  textareaId: string
  value: string
  onChange: (value: string) => void
  /** Lo que el correo suma debajo (la firma, el correo citado). */
  previewNote?: string
}) {
  const [preview, setPreview] = useState(false)
  const apply = (edit: (value: string, start: number, end: number) => Edit) => {
    const area = document.getElementById(textareaId)
    if (!(area instanceof HTMLTextAreaElement)) return
    const next = edit(value, area.selectionStart, area.selectionEnd)
    onChange(next.value)
    requestAnimationFrame(() => {
      area.focus()
      area.setSelectionRange(next.selectionStart, next.selectionEnd)
    })
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formato">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Negrita"
          title="Negrita: **texto**"
          onClick={() => apply((v, s, e) => wrapSelection(v, s, e, "**"))}
        >
          <Bold aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cursiva"
          title="Cursiva: *texto*"
          onClick={() => apply((v, s, e) => wrapSelection(v, s, e, "*"))}
        >
          <Italic aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Enlace"
          title="Enlace: [texto](https://…)"
          onClick={() => apply(insertLink)}
        >
          <Link2 aria-hidden />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-pressed={preview}
          onClick={() => setPreview((open) => !open)}
        >
          {preview ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          Vista previa
        </Button>
      </div>
      {preview ? (
        <section aria-label="Vista previa" className="rounded-lg border bg-muted/40 p-3 text-sm">
          {value.trim() ? (
            <FormattedText text={value} />
          ) : (
            <p className="text-muted-foreground">Todavía no escribiste nada.</p>
          )}
          {previewNote ? <p className="mt-3 text-xs text-muted-foreground">{previewNote}</p> : null}
        </section>
      ) : null}
    </div>
  )
}

/** La ayuda del campo: qué formato acepta. */
export const FORMAT_HINT =
  "Puedes usar **negrita**, *cursiva*, [enlaces](https://…) y listas con «- » o «1. »."
