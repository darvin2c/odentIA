import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@odentia/ui"
import { ArrowUpRight, Inbox, type LucideIcon } from "lucide-react"
import { common } from "./common.js"

export interface EmptyStateProps {
  icon?: LucideIcon
  title?: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  secondaryActionLabel?: string
  onSecondaryAction?: () => void
  learnMoreLabel?: string
  learnMoreHref?: string
  className?: string
}

/**
 * Estado vacío estándar (DESIGN.md): icono en caja muted, título h3, descripción,
 * acción primaria (máx. una) + secundaria opcional y enlace "learn more" con ArrowUpRight.
 * Los textos salen de los catálogos i18n de cada app; los defaults son common.states.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title = common.states.empty,
  description = common.states.emptyHint,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  learnMoreLabel,
  learnMoreHref,
  className,
}: EmptyStateProps) {
  const hasPrimary = Boolean(actionLabel && onAction)
  const hasSecondary = Boolean(secondaryActionLabel && onSecondaryAction)
  const hasLearnMore = Boolean(learnMoreLabel && learnMoreHref)

  return (
    <Empty
      className={["rounded-lg border border-dashed border-border bg-surface p-8", className]
        .filter(Boolean)
        .join(" ")}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" aria-hidden>
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {hasPrimary || hasSecondary || hasLearnMore ? (
        <EmptyContent>
          {hasPrimary || hasSecondary ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {hasPrimary ? (
                <Button type="button" variant="default" onClick={onAction}>
                  {actionLabel}
                </Button>
              ) : null}
              {hasSecondary ? (
                <Button type="button" variant="secondary" onClick={onSecondaryAction}>
                  {secondaryActionLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
          {hasLearnMore ? (
            <a
              href={learnMoreHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {learnMoreLabel}
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
          ) : null}
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
