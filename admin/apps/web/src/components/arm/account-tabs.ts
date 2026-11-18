/**
 * Lo que la ficha del cliente (`routes/_app/clients_.$clientId.tsx`) le pasa
 * a cada pestaña de la cuenta: Alta, Plan y pagos, Uso, Soporte y Documentos.
 * Cada pestaña pide sus propios datos; `isAdmin` solo refleja lo que el
 * servidor igual niega a Soporte.
 */
import type { ClinicalProduct } from "@odentia/clinical"

export interface ClientTabProps {
  clientId: string
  /** Nulo mientras el cliente no tiene cuenta. */
  organizationId: string | null
  organizationName: string
  product: ClinicalProduct
  isAdmin: boolean
}
