import type { ProductOrdersUi } from "@odentia/clinic-app/product/product-ui"
import {
  EYES,
  formatDay,
  lensText,
  PRESCRIPTION_KINDS,
  type PrescriptionLenses,
  type PupillaryDistance,
  pupillaryDistanceText,
} from "@odentia/optical"

/** La copia de la receta que guarda el pedido (`lensPrescriptionSnapshot` del servidor). */
interface PrescriptionSnapshot {
  kind?: string
  source?: string
  lenses?: PrescriptionLenses
  pupillaryDistance?: PupillaryDistance | null
  issuedOn?: string
  validUntil?: string
  prescriberName?: string
  prescriberRegistration?: string | null
  verified?: boolean
  /** Vencida o sin verificar, al copiarla: la pantalla común los dice aparte. */
  notices?: unknown
}

/** La receta copiada en el pedido, como la lee el taller: de qué es, un ojo por línea, la DP y quién la firmó. */
function prescriptionLines(snapshot: Record<string, unknown>): string[] {
  const copy = snapshot as PrescriptionSnapshot
  const kind = PRESCRIPTION_KINDS.find((item) => item.key === copy.kind)?.label ?? "Receta"
  const dates = [
    copy.issuedOn ? formatDay(copy.issuedOn) : "",
    copy.validUntil ? `vale hasta ${formatDay(copy.validUntil)}` : "",
  ]
  const lenses = copy.lenses ?? {}
  const pd = pupillaryDistanceText(copy.pupillaryDistance)
  return [
    [kind, ...dates].filter(Boolean).join(" · "),
    ...EYES.filter((eye) => lenses[eye.key]).map(
      (eye) => `${eye.short} ${lensText(lenses[eye.key])}`,
    ),
    pd ? `DP ${pd}` : "",
    copy.prescriberName
      ? `Firma: ${copy.prescriberName}${copy.prescriberRegistration ? ` · ${copy.prescriberRegistration}` : ""}`
      : "",
    // Las copias de antes no traen sus avisos: lo sin verificar se dice aquí.
    copy.source === "externa" && copy.verified === false && !Array.isArray(copy.notices)
      ? "Transcrita, sin verificar"
      : "",
  ].filter(Boolean)
}

/**
 * La venta de lentes con pedido (entrega 4 del plan, ADR 0168): la montura y los
 * lentes de contacto salen del inventario; las lunas, que el laboratorio hace a
 * medida, se escriben con su precio. Al taller le basta la receta copiada y la
 * altura de montaje de cada ojo.
 */
export const opticalOrders: ProductOrdersUi = {
  sellLabel: "Vender lentes",
  lineKinds: [
    { kind: "montura", label: "Montura", fromInventory: true },
    { kind: "lunas", label: "Lunas", fromInventory: false },
    { kind: "contacto", label: "Lentes de contacto", fromInventory: true },
    { kind: "otro", label: "Otro", fromInventory: false },
  ],
  fitting: [
    { key: "alturaOd", label: "Altura OD", unit: "mm" },
    { key: "alturaOi", label: "Altura OI", unit: "mm" },
  ],
  titlePlaceholder: "Montura y lunas progresivas",
  makerPlaceholder: "Laboratorio o taller propio",
  referenceLabel: "Receta",
  prescriptionLines,
}
