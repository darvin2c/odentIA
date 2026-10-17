import type { Db } from "@odentia/db"
import type { AdminActor } from "./admin-core.js"
import { getOrganizationPendingCounts } from "./admin-organizations.js"
import { getAdminSupportAttention } from "./admin-support.js"
import { consumerComplaintSummary } from "./consumer-complaints.js"
import { getSaasAdminAttention } from "./saas-billing.js"

export interface AdminAttentionItem {
  key: string
  label: string
  count: number
  description: string
  path: "/support" | "/billing" | "/commissions" | "/organizations" | "/users" | "/complaints"
}
export interface AdminOverview {
  items: AdminAttentionItem[]
}

/** Inicio interno: soporte no recibe ningún importe ni pendiente de cobros. */
export async function getBackofficeOverview(tx: Db, actor: AdminActor): Promise<AdminOverview> {
  const support = await getAdminSupportAttention(tx)
  const organizations = await getOrganizationPendingCounts(tx, actor)
  const complaints = await consumerComplaintSummary(tx, actor)
  const items: AdminAttentionItem[] = [
    {
      key: "complaints",
      label: "Libro de Reclamaciones por responder",
      count: complaints.pending,
      description:
        complaints.overdue > 0
          ? `${complaints.overdue} con el plazo vencido`
          : complaints.dueSoon > 0
            ? `${complaints.dueSoon} ${complaints.dueSoon === 1 ? "vence" : "vencen"} en 5 días hábiles o menos`
            : "Plazo de 15 días hábiles desde que llega cada hoja",
      path: "/complaints",
    },
    {
      key: "support-open",
      label: "Casos de soporte por atender",
      count: support.openCount,
      description: "Preguntas y problemas abiertos o en atención",
      path: "/support",
    },
    {
      key: "support-waiting",
      label: "Esperando a la clínica",
      count: support.waitingClinicCount,
      description: "Casos que necesitan una respuesta del cliente",
      path: "/support",
    },
    {
      key: "onboarding",
      label: "Altas por completar",
      count: organizations.incompleteProvisioning,
      description: "Organizaciones que aún no terminaron su puesta en marcha",
      path: "/organizations",
    },
  ]
  if (actor.role === "admin") {
    const billing = await getSaasAdminAttention(tx)
    items.push(
      {
        key: "payments",
        label: "Comprobantes por confirmar",
        count: billing.pendingPaymentCount,
        description: "Revisa el abono antes de acreditar el pago",
        path: "/billing",
      },
      {
        key: "overdue",
        label: "Cargos vencidos",
        count: billing.overdueCount,
        description: "Cobros con saldo pendiente después del vencimiento",
        path: "/billing",
      },
      {
        key: "trials",
        label: "Pruebas por terminar",
        count: billing.trialEndingCount,
        description: "Terminan dentro de los próximos tres días",
        path: "/organizations",
      },
      {
        key: "commissions",
        label: "Comisiones por liquidar",
        count: billing.pendingCommissionCount,
        description: "Movimientos pendientes de vendedores y socios",
        path: "/commissions",
      },
      {
        key: "recovery",
        label: "Solicitudes de recuperación",
        count: organizations.pendingRecoveryCases,
        description: "Verificación de identidad y autoridad pendiente",
        path: "/users",
      },
    )
  }
  return { items }
}
