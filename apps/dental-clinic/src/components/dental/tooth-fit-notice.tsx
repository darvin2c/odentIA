/**
 * El aviso de la pieza equivocada (entrega 8 de la atención, punto 1): la
 * «Endodoncia anterior vital» indicada en la 46 se dice junto a lo elegido y
 * ofrece la posterior si la clínica la tiene. No frena ni pregunta: quien
 * indica decide, y el paciente no ve nada de esto.
 */

import { usePermission } from "@odentia/clinic-app/lib/crm"
import { useOrgProfile } from "@odentia/clinic-app/lib/org"
import type { ToothFitNoticeProps } from "@odentia/clinic-app/product/product-ui"
import { formatMoney } from "@odentia/clinical"
import {
  type Dentition,
  isDentition,
  isToothGroup,
  type ToothGroup,
  toothFitNotice,
} from "@odentia/dental"
import { Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"

/** Lo que llega de la API, con los grupos y la dentición que conoce `@odentia/dental`. */
function anatomyOf(value: { groups: string[]; dentition: string | null }): {
  groups: ToothGroup[]
  dentition: Dentition | null
} {
  return {
    groups: value.groups.filter(isToothGroup),
    dentition: isDentition(value.dentition) ? value.dentition : null,
  }
}

export function ToothFitNotice({
  service,
  place,
  onUse,
  pending = false,
}: ToothFitNoticeProps): React.JSX.Element | null {
  const canConfigure = usePermission("settings.write")
  const locale = useOrgProfile().data?.locale
  const anatomy = service.toothAnatomy
  const siblings = (anatomy?.siblings ?? []).map((sibling) => ({
    ...sibling,
    ...anatomyOf(sibling),
  }))
  const notice = toothFitNotice(
    { name: service.name, anatomy: anatomy ? anatomyOf(anatomy) : null },
    place,
    siblings,
  )
  if (!notice) return null
  const { sibling } = notice
  // Para buscarla en la biblioteca: la primera palabra del servicio («Endodoncia», «Resina»).
  const libraryQuery = service.name.split(/[\s,]+/)[0] ?? ""
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
    >
      <p>
        {notice.message}
        {notice.missing ? ` ${notice.missing}` : null}
      </p>
      {sibling && onUse ? (
        <span className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onUse(sibling)}
          >
            Usar {sibling.name}
          </Button>
          {sibling.priceCents != null && locale ? (
            <span className="text-muted-foreground tabular-nums">
              {formatMoney(sibling.priceCents, sibling.currency, locale)}
            </span>
          ) : null}
        </span>
      ) : null}
      {!sibling && canConfigure ? (
        <Link
          to="/services/biblioteca"
          search={{ vista: "biblioteca", q: libraryQuery || undefined } as never}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "link", size: "sm", className: "self-start px-0" })}
        >
          Agregarla en Servicios y precios
        </Link>
      ) : null}
    </div>
  )
}
