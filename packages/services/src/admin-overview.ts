import type { Db } from "@odentia/db"
import type { AdminActor } from "./admin-core.js"
import { getOrganizationPendingCounts, type OwnerPendingRow, ownersPendingRows } from "./admin-organizations.js"
import { getAdminSupportAttention, type SupportHomeRow, supportHomeRows } from "./admin-support.js"
import { consumerComplaintSummary } from "./consumer-complaints.js"
import { addressSearchesToday } from "./address-suggestions.js"
import { backupHealth, backupProblemWords } from "./platform-backups.js"
import { getSaasAdminAttention } from "./saas-billing.js"
import { businessDaysWords, currentSaasTerms } from "./saas-commercial-terms.js"
import {
  countWaitlistToReview,
  type ExpiringTermRow,
  listExpiringTerms,
  type WaitlistHomeRow,
  waitlistHomeRows,
} from "./saas-founders.js"

export interface AdminAttentionItem {
  key: string
  label: string
  count: number
  description: string
  path: "/support" | "/billing" | "/commissions" | "/organizations" | "/users" | "/complaints" | "/waitlist"
}
export interface AdminOverview {
  items: AdminAttentionItem[]
  /** Precios negociados y condiciones de Fundador que terminan pronto (issues 165 y 168); solo la administración. */
  expiring: ExpiringTermRow[]
}

/**
 * Inicio interno: soporte no recibe ningún importe ni pendiente de cobros.
 * «waitlist» y «support-open» ya son listas con nombre en Inicio
 * (`getBackofficeToday`): siguen aquí para el número del menú («Lista de
 * espera» y «Soporte»), que es el mismo que el de su sección.
 * `geoapifyDailyLimit`: las búsquedas de direcciones de pacientes que da el plan
 * de Geoapify al día (decisión 7 del lienzo del issue 36). `expectBackups`:
 * producción, donde sin backups verificados en 26 horas se avisa.
 */
export async function getBackofficeOverview(
  tx: Db,
  actor: AdminActor,
  options: { geoapifyDailyLimit?: number; expectBackups?: boolean; now?: Date } = {},
): Promise<AdminOverview> {
  const now = options.now ?? new Date()
  // Con el actor: soporte no cuenta los casos de cobro, que no ve en ningún lado.
  const support = await getAdminSupportAttention(tx, actor)
  const organizations = await getOrganizationPendingCounts(tx, actor)
  const complaints = await consumerComplaintSummary(tx, actor)
  const waitlist = await countWaitlistToReview(tx, now)
  const { waitlistAnswerDays } = await currentSaasTerms(tx, now)
  const items: AdminAttentionItem[] = [
    {
      key: "waitlist",
      label: "Prospectos por responder",
      count: waitlist,
      description: `Sin respuesta todavía o con la invitación por vencer: se responde en ${businessDaysWords(waitlistAnswerDays)}`,
      path: "/waitlist",
    },
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
      description: "Casos que nos esperan: nadie les respondió o la clínica hizo algo después de nuestra respuesta",
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
      description: "Sin perfil o sin sede",
      path: "/organizations",
    },
  ]
  if (actor.role === "admin") {
    const billing = await getSaasAdminAttention(tx)
    // Pasado el plan del día, los pacientes escriben su dirección a mano hasta mañana.
    const addressSearches = options.geoapifyDailyLimit ? await addressSearchesToday(tx, "paciente") : 0
    const addressesSpent = options.geoapifyDailyLimit !== undefined && addressSearches >= options.geoapifyDailyLimit
    const backup = backupProblemWords(await backupHealth(tx, options.expectBackups ? { expectedSince: new Date(0) } : {}))
    // Sin «Pruebas por terminar»: repetía con otra regla las pruebas por vencer de más abajo.
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
        key: "commissions",
        label: "Comisiones por liquidar",
        count: billing.pendingCommissionCount,
        description: "Movimientos pendientes de vendedores y socios",
        path: "/commissions",
      },
      {
        key: "address-suggestions",
        label: "Sugerencias de direcciones agotadas hoy",
        count: addressesSpent ? addressSearches : 0,
        description: `Se usaron las ${options.geoapifyDailyLimit ?? 0} búsquedas de Geoapify del día: hasta mañana, los pacientes escriben su dirección a mano`,
        path: "/billing",
      },
      {
        key: "backup",
        label: "Backup sin verificar",
        count: backup ? 1 : 0,
        description: backup ?? "El backup de cada día se restaura y comprueba antes de guardarse",
        path: "/support",
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
  return { items, expiring: actor.role === "admin" ? await listExpiringTerms(tx, now) : [] }
}

/** Lo que Inicio nombra fila por fila: a quién responder hoy. */
export interface BackofficeToday {
  /**
   * Prospectos: con `reason` van en «Prospectos por responder» (con su
   * seguimiento como segunda línea, si toca); sin `reason`, en «Seguimientos
   * de hoy». Una fila por solicitud.
   */
  prospects: WaitlistHomeRow[]
  /** Los casos que nos esperan, en el orden de la cola; a soporte, sin los de cobro. */
  support: SupportHomeRow[]
  /** Clínicas con la propietaria sin aceptar, con la invitación por vencer o vencida. */
  owners: OwnerPendingRow[]
  /** «2 días hábiles»: el plazo que la web promete para responder una solicitud. */
  answerWithin: string
}

/**
 * Inicio de la administración, fila por fila. Solo lee: nada se envía ni se
 * decide aquí. Lo ven administración y soporte igual, salvo lo que la regla de
 * cada lista le quita a soporte (los casos de cobro y las notas solo de
 * administración). Sin la pregunta de ningún caso ni importes, y sin
 * auditoría: son metadatos, como los conteos.
 */
export async function getBackofficeToday(tx: Db, actor: AdminActor, now = new Date()): Promise<BackofficeToday> {
  const prospects = await waitlistHomeRows(tx, actor, now)
  const support = await supportHomeRows(tx, actor, now)
  const owners = await ownersPendingRows(tx, now)
  const { waitlistAnswerDays } = await currentSaasTerms(tx, now)
  return { prospects, support, owners, answerWithin: businessDaysWords(waitlistAnswerDays) }
}
