import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "./api"

/**
 * Medios de pago por clínica (contrato GET /api/org/payment-methods).
 * Caja ofrece solo los activos; apagar uno no altera cobros anteriores.
 */
export interface PaymentMethod {
  id: string
  name: string
  /** UN/CEFACT 4461: 10 efectivo, 48 tarjeta, 30 transferencia, 68 billetera, 20 cheque, 1 otro. */
  typeCode: string
  isActive: boolean
  sortOrder: number
}

export const PAYMENT_TYPE_LABELS: Record<string, string> = {
  "10": "Efectivo",
  "48": "Tarjeta",
  "30": "Transferencia",
  "68": "Billetera digital",
  "20": "Cheque",
  "1": "Otro",
}

export function paymentTypeLabel(typeCode: string): string {
  return PAYMENT_TYPE_LABELS[typeCode] ?? "Otro"
}

/** Solo el efectivo se cuenta al cerrar caja; los demás piden número de operación. */
export function isCashMethod(typeCode: string): boolean {
  return typeCode === "10"
}

export async function fetchPaymentMethods(
  activeOnly = true,
): Promise<{ data: PaymentMethod[] }> {
  return apiFetch<{ data: PaymentMethod[] }>(
    `/api/org/payment-methods?activeOnly=${activeOnly ? "1" : "0"}`,
  )
}

export function usePaymentMethods(activeOnly = true) {
  return useQuery({
    queryKey: ["payment-methods", activeOnly],
    queryFn: () => fetchPaymentMethods(activeOnly),
    staleTime: 60_000,
  })
}

export interface CreatePaymentMethodBody {
  name: string
  typeCode?: "10" | "48" | "30" | "68" | "20" | "1" | null
  sortOrder?: number | null
}

export function createPaymentMethodApi(
  body: CreatePaymentMethodBody,
): Promise<{ data: PaymentMethod }> {
  return apiFetch<{ data: PaymentMethod }>("/api/org/payment-methods", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface UpdatePaymentMethodBody {
  name?: string
  typeCode?: "10" | "48" | "30" | "68" | "20" | "1"
  sortOrder?: number | null
  isActive?: boolean
}

export function updatePaymentMethodApi(
  id: string,
  patch: UpdatePaymentMethodBody,
): Promise<{ data: PaymentMethod }> {
  return apiFetch<{ data: PaymentMethod }>(`/api/org/payment-methods/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}
