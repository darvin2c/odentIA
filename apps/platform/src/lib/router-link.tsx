import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

/**
 * Link del router con el contrato que esperan `AppShell` y `SectionNav`
 * (`ShellLinkComponent`). Reenvía las props que inyecta el patrón —`aria-current`
 * para el ítem activo, `title`, `onClick`— al `<a>` que renderiza `Link`.
 */
export function RouterLink({
  to,
  search,
  className,
  children,
  title,
  onClick,
  ...rest
}: {
  to: string
  search?: Record<string, string>
  className?: string
  children: ReactNode
  title?: string
  onClick?: () => void
}) {
  return (
    <Link to={to} search={search} className={className} title={title} onClick={onClick} {...rest}>
      {children}
    </Link>
  )
}
