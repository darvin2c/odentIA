/**
 * Un producto al lado de la lista (tablero 6, `?producto=`): cómo está en cada
 * sede, la última compra y lo usado en 30 días (el precio solo si viene), sus
 * lotes con su origen, los últimos movimientos y los servicios que lo usan.
 * Editar, Ajustar y Trasladar a la vista; lo demás en «⋯». Desactivar dice su
 * consecuencia; reactivar no pregunta.
 */
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, DetailSection } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"
import {
  dayText,
  expiryText,
  fetchProduct,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  type ProductDetail,
  purchaseQuantityText,
  setProductActive,
  stateBadge,
  stockText,
  unitsLine,
  unitsText,
  usageText,
  whenText,
  withArticle,
  clinicDayOf,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { Chip } from "./fields"
import { useInventory } from "./inventory-scope"
import { MovementWhat, movementShort } from "./movement-words"

const ROW = "flex items-start justify-between gap-3 py-2"
const SMALL = "block text-xs text-muted-foreground"

export function ProductPanel({ productId, onClose }: { productId: string | null; onClose: () => void }) {
  const scope = useInventory()
  const { branchId } = scope
  const query = useQuery({
    queryKey: inventoryKeys.product(productId ?? "", branchId),
    queryFn: () => fetchProduct(productId as string, branchId),
    enabled: productId !== null,
  })
  const detail = query.data
  return (
    <DetailDrawer
      open={productId !== null}
      onClose={onClose}
      title={detail?.name ?? "Producto"}
      description={detail ? `${usageText(detail)} · ${unitsLine(detail)}` : undefined}
      isLoading={query.isPending && productId !== null}
      headerContent={detail ? <ProductActions detail={detail} /> : undefined}
    >
      {query.isError && !detail ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} notFound="Este producto ya no está disponible." />
      ) : detail ? (
        <ProductBody detail={detail} />
      ) : null}
    </DetailDrawer>
  )
}

function ProductActions({ detail }: { detail: ProductDetail }) {
  const { can, open, branches } = useInventory()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)
  const activation = useMutation({
    mutationFn: (isActive: boolean) => setProductActive(detail.id, isActive),
    onSuccess: (_result, isActive) => {
      setConfirming(false)
      toast.success(isActive ? `${detail.name} está activo otra vez.` : `${detail.name} quedó desactivado.`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    },
    onError: (error) => toast.error(inventoryErrorMessage(error)),
  })
  const active = detail.isActive
  const buttons: Array<{ key: string; label: string; onClick: () => void }> = []
  if (can.write) buttons.push({ key: "editar", label: "Editar", onClick: () => open.productForm(detail) })
  if (can.write) buttons.push({ key: "ajustar", label: "Ajustar", onClick: () => open.action("ajustar", { productId: detail.id }) })
  if (can.write && active && branches.length > 1)
    buttons.push({ key: "trasladar", label: "Trasladar", onClick: () => open.action("trasladar", { productId: detail.id }) })
  if (!can.write && can.receive && active) buttons.push({ key: "uso", label: "Registrar uso", onClick: () => open.action("uso", { productId: detail.id }) })
  const menu: Array<{ key: string; label: string; onClick: () => void; danger?: boolean }> = []
  if (can.write && can.receive && active) menu.push({ key: "uso", label: "Registrar uso", onClick: () => open.action("uso", { productId: detail.id }) })
  if (can.write && active) menu.push({ key: "agregar", label: "Agregar sin compra", onClick: () => open.action("agregar", { productId: detail.id }) })
  if (detail.movementsTotal > 0) menu.push({ key: "movimientos", label: "Ver todos sus movimientos", onClick: () => open.movementsOf(detail.id) })
  const toggle = can.write
    ? active
      ? { label: "Desactivar", onClick: () => setConfirming(true), danger: true }
      : { label: "Reactivar", onClick: () => activation.mutate(true), danger: false }
    : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons.map((button) => (
        <Button key={button.key} type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={button.onClick}>
          {button.label}
        </Button>
      ))}
      {menu.length > 0 || toggle ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 sm:min-h-8" aria-label={`Más acciones de ${detail.name}`} />}
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menu.map((item) => (
              <DropdownMenuItem key={item.key} onClick={item.onClick}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {toggle && menu.length > 0 ? <DropdownMenuSeparator /> : null}
            {toggle ? (
              <DropdownMenuItem
                disabled={activation.isPending}
                className={toggle.danger ? "text-destructive" : undefined}
                onClick={toggle.onClick}
              >
                {toggle.label}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Desactivar «${detail.name}»`}
        description="Ya no se podrá pedir ni usar. Lo que queda sigue a la vista hasta llegar a 0."
        confirmLabel="Desactivar"
        cancelLabel="Volver"
        pending={activation.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={() => activation.mutate(false)}
      />
    </div>
  )
}

function ProductBody({ detail }: { detail: ProductDetail }) {
  const { can, open, branchName } = useInventory()
  const last = detail.lastPurchase
  const shownMovements = detail.movements.slice(0, 5)
  return (
    <div className="flex flex-col gap-6">
      {!detail.isActive ? (
        <p className="rounded-md bg-secondary px-3 py-2 text-sm">Desactivado: ya no se puede pedir ni usar. Lo que queda sigue a la vista hasta llegar a 0.</p>
      ) : null}
      {detail.unitReview ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          La unidad «{detail.unit}» no se entendió al pasar a unidades.{can.write ? " Revísala en «Editar»." : ""}
        </p>
      ) : null}

      <DetailSection title="Por sede">
        <ul className="flex flex-col divide-y text-sm">
          {detail.branches.map((sede) => {
            const badge = stateBadge(sede, detail.today)
            return (
              <li key={sede.branchId} className={ROW}>
                <span className="min-w-0">
                  <span className="block font-medium">{sede.branchName}</span>
                  <span className={SMALL}>{sede.minQuantity > 0 ? `mínimo ${formatWhole(sede.minQuantity)}` : "sin mínimo"}</span>
                </span>
                <span className="flex flex-col items-end gap-1 text-right">
                  <span className={sede.onHand < 0 ? "font-semibold whitespace-nowrap text-destructive tabular-nums" : "whitespace-nowrap tabular-nums"}>
                    {stockText(sede.onHand, detail)}
                  </span>
                  {badge ? <Chip tone={badge.tone}>{badge.label}</Chip> : null}
                </span>
              </li>
            )
          })}
        </ul>
      </DetailSection>

      <DetailSection title="Última compra">
        <ul className="flex flex-col divide-y text-sm">
          {last ? (
            <li className={ROW}>
              <span className="min-w-0">
                <span className="block">
                  {last.supplierName} ·{" "}
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => open.order(last.orderId)}>
                    {last.label}
                  </button>
                </span>
                <span className={SMALL}>
                  {dayText(clinicDayOf(last.at), detail.today)} · {purchaseQuantityText(last.quantity, { purchaseUnit: last.purchaseUnit, unit: detail.unit, unitFactor: last.unitFactor })}
                </span>
              </span>
              {can.prices && last.unitCostCents !== undefined && last.currency ? (
                <span className="text-right whitespace-nowrap tabular-nums">
                  {moneyText(last.unitCostCents, last.currency)} {withArticle(last.purchaseUnit && last.unitFactor > 1 ? last.purchaseUnit : detail.unit)}
                </span>
              ) : null}
            </li>
          ) : (
            <li className={`${ROW} text-muted-foreground`}>Todavía no se compró.</li>
          )}
          <li className={ROW}>
            <span>Usados en 30 días</span>
            <span className="whitespace-nowrap tabular-nums">{unitsText(detail.usedLast30Days, detail.unit)}</span>
          </li>
          {detail.forSale && can.prices && detail.salePriceCents != null && detail.saleCurrency ? (
            <li className={ROW}>
              <span>Se vende a</span>
              <span className="whitespace-nowrap tabular-nums">
                {moneyText(detail.salePriceCents, detail.saleCurrency)} {withArticle(detail.unit)}
              </span>
            </li>
          ) : null}
        </ul>
      </DetailSection>

      <DetailSection title={`Lotes en ${branchName}`}>
        {detail.lots.length === 0 && detail.shortage === 0 ? (
          <p className="text-sm text-muted-foreground">No hay lotes en {branchName}.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {detail.lots.map((lot) => {
              const facts: React.ReactNode[] = [lot.expiresAt ? `vence ${expiryText(lot.expiresAt, detail.today)}` : "sin vencimiento"]
              if (lot.purchaseOrderId && lot.purchaseOrderLabel) {
                facts.push(
                  <span key="compra">
                    llegó en{" "}
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => open.order(lot.purchaseOrderId as string)}>
                      {lot.purchaseOrderLabel}
                    </button>
                  </span>,
                )
              } else facts.push("sin compra")
              if (!lot.warehouseIsDefault) facts.push(lot.warehouseName)
              const code = lot.code && lot.code !== lot.purchaseOrderLabel ? lot.code : "Sin código"
              return (
                <li key={lot.id} className={ROW}>
                  <span className="min-w-0">
                    <span className="block font-medium">{code}</span>
                    <span className={SMALL}>
                      {facts.map((fact, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: datos del lote en orden fijo.
                        <React.Fragment key={index}>
                          {index > 0 ? " · " : null}
                          {fact}
                        </React.Fragment>
                      ))}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="tabular-nums">{formatWhole(lot.quantityOnHand)}</span>
                    {lot.expired ? <Chip tone="bad">Venció</Chip> : lot.expiring ? <Chip tone="soft">Por vencer</Chip> : null}
                  </span>
                </li>
              )
            })}
            {detail.shortage > 0 ? (
              <li className={ROW}>
                <span className="min-w-0">
                  <span className="block font-medium">Se usaron sin haber</span>
                  <span className={SMALL}>la próxima compra o lo que se agregue los cubre primero</span>
                </span>
                <span className="font-semibold text-destructive tabular-nums">−{formatWhole(detail.shortage)}</span>
              </li>
            ) : null}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Últimos movimientos">
        {shownMovements.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay movimientos en {branchName}.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {shownMovements.map((movement) => (
              <li key={movement.id} className={ROW}>
                <span className="min-w-0">
                  <span className="block">
                    <MovementWhat item={movement} />
                  </span>
                  <span className={SMALL}>{[whenText(movement.createdAt), movement.actorName].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="whitespace-nowrap tabular-nums">{movementShort(movement)}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.movementsTotal > 0 ? (
          <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => open.movementsOf(detail.id)}>
            Ver todos sus movimientos
          </Button>
        ) : null}
      </DetailSection>

      {detail.services.length > 0 ? (
        <DetailSection title="Lo usan estos servicios">
          <ul className="flex flex-col divide-y text-sm">
            {detail.services.map((service) => (
              <li key={service.serviceId} className={ROW}>
                <span className="min-w-0">{service.serviceName}</span>
                <span className="whitespace-nowrap tabular-nums">{unitsText(service.quantity, detail.unit)}</span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
    </div>
  )
}
