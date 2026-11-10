/**
 * El aviso de la pieza equivocada (entrega 8 de la atención, punto 1): la
 * «Endodoncia anterior vital» indicada en la 46 se dice junto a lo elegido y
 * ofrece la posterior si la clínica la tiene. No frena ni pregunta: quien
 * indica decide, y el paciente no ve nada de esto.
 */

import { usePermission } from "@odentia/clinic-app/lib/crm"
import { useOrgProfile } from "@odentia/clinic-app/lib/org"
import type { ToothFitNoticeProps } from "@odentia/clinic-app/product/product-ui"
import { formatMoney, isPulpNecrosis } from "@odentia/clinical"
import {
  type Dentition,
  isDentition,
  isToothGroup,
  type ToothGroup,
  toothFitNotice,
} from "@odentia/dental"
import { Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

/** Lo que llega de la API, con los grupos y la dentición que conoce `@odentia/dental`. */
export function toothAnatomyOf(value: { groups: string[]; dentition: string | null }): {
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
  diagnosisCode = null,
}: ToothFitNoticeProps): React.JSX.Element | null {
  const canConfigure = usePermission("settings.write")
  const locale = useOrgProfile().data?.locale
  const anatomy = service.toothAnatomy
  const [used, setUsed] = useState<string | null>(null)
  const siblings = (anatomy?.siblings ?? []).map((sibling) => ({
    ...sibling,
    ...toothAnatomyOf(sibling),
  }))
  const notice = toothFitNotice(
    { name: service.name, anatomy: anatomy ? toothAnatomyOf(anatomy) : null },
    place,
    siblings,
  )
  // Tras «Usar …» el aviso se va: queda una línea que dice el cambio y recibe el foco, para que no
  // caiga al principio de la página (WCAG 2.4.3, QA antes de entregar).
  // Encaja en la pieza, pero es vital y el diagnóstico dice necrosis: se ofrece la no vital de
  // su grupo (decisión B2 del 10 nov). Avisa, no frena: quien indica decide.
  if (!notice && anatomy?.family === "endodoncia-vital" && isPulpNecrosis(diagnosisCode)) {
    const nonVital = (anatomy.nonVital ?? [])
      .map((option) => ({ ...option, ...toothAnatomyOf(option) }))
      .find((option) => toothFitNotice({ name: option.name, anatomy: option }, place, []) === null)
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
      >
        <p>
          Con necrosis pulpar suele indicarse la endodoncia no vital.
          {nonVital ? null : " La clínica no tiene activa una no vital para esta pieza."}
        </p>
        {nonVital && onUse ? (
          <span className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setUsed(nonVital.name)
                onUse(nonVital)
              }}
            >
              Usar {nonVital.name}
              {locale && nonVital.priceCents != null
                ? ` · ${formatMoney(nonVital.priceCents, nonVital.currency, locale)}`
                : ""}
            </Button>
          </span>
        ) : null}
      </div>
    )
  }
  if (!notice) return used ? <UsedLine name={used} /> : null
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
            onClick={() => {
              setUsed(sibling.name)
              onUse(sibling)
            }}
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

/** «Ahora es Endodoncia posterior vital.»: dice el cambio y toma el foco al aparecer. */
function UsedLine({ name }: { name: string }): React.JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <p ref={ref} tabIndex={-1} role="status" className="text-sm text-muted-foreground outline-none">
      Ahora es «{name}».
    </p>
  )
}
