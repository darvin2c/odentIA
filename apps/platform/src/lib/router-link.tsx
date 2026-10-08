import { Link } from "@tanstack/react-router"
import type { MouseEventHandler, ReactNode } from "react"

/**
 * Link del router con el contrato que esperan `AppShell` y `SectionNav`
 * (`ShellLinkComponent`). Reenvía las props que inyecta el patrón —`aria-current`
 * para el ítem activo, `title`, `onClick`— al `<a>` que renderiza `Link`.
 *
 * `exact` deja al patrón como única fuente del ítem activo: sin él, `Link`
 * marca además `aria-current` en cada prefijo de la ruta (`/agent` estando en
 * `/agent/approvals`) y el lector anuncia dos páginas actuales.
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
  onClick?: MouseEventHandler<HTMLAnchorElement>
}) {
  return (
    <Link
      to={to}
      search={search}
      className={className}
      title={title}
      onClick={onClick}
      activeOptions={{ exact: true }}
      {...rest}
    >
      {children}
    </Link>
  )
}
