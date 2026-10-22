import { cn } from "@odentia/ui"
import type { PreviewPart } from "../../../lib/whatsapp"

/** El texto con lo que pone el sistema resaltado (en negrita, no solo con color). */
export function PreviewText({ parts }: { parts: PreviewPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.data ? (
          <strong key={index} className="font-semibold text-primary-soft-foreground">
            {part.text}
          </strong>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/**
 * Un mensaje como le llega a la persona: el globo con su texto y, debajo, sus
 * botones. Los botones aquí solo se muestran: no hacen nada.
 */
export function MessagePreview({
  parts,
  buttons,
  className,
}: {
  parts: PreviewPart[]
  buttons: string[]
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl bg-muted p-3", className)}>
      <p className="max-w-80 self-start rounded-2xl rounded-tl-md bg-card px-3 py-2.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
        <PreviewText parts={parts} />
      </p>
      {buttons.length > 0 ? (
        <ul aria-label="Botones del mensaje" className="flex w-full max-w-80 flex-col gap-1 self-start">
          {buttons.map((title) => (
            <li
              key={title}
              className="flex min-h-9 items-center justify-center rounded-xl bg-card px-3 py-1.5 text-center text-sm font-semibold text-primary"
            >
              {title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
