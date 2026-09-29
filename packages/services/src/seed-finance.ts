/**
 * Semilla de finanzas para `seed-dev` (la conecta el padre).
 * Determinista e idempotente: si el turno, el proveedor, el gasto o los cargos
 * demo ya existen, se reutilizan en lugar de duplicarse. No toca históricos
 * de otros dominios: solo crea un turno, un proveedor, un gasto de caja chica,
 * dos cargos manuales demo con su pago aplicado y un plan de cuotas.
 */
import type { Db } from "@odentia/db"
import { applyPayment, createCharge, createPayment } from "./payments.js"
import {
  createExpense,
  createInstallmentPlan,
  listExpenses,
  listInstallmentPlans,
  listShifts,
  getReceivables,
  openShift,
  refreshInstallmentPlan,
  registerPaymentInShift,
} from "./finance.js"
import { createSupplier, listSuppliers } from "./inventory.js"

export async function seedFinance(
  tx: Db,
  input: {
    orgId: string
    ownerUserId: string
    branchId: string
    patientId: string
    contactId: string
  },
): Promise<void> {
  const { orgId, ownerUserId, branchId, patientId } = input

  // Turno abierto PEN de la sede (reutiliza el existente si ya hay uno).
  const open = await listShifts(tx, orgId, { branchId, status: "abierta" })
  const shift =
    open.find((s) => s.currency === "PEN") ??
    (await openShift(tx, orgId, ownerUserId, {
      branchId,
      currency: "PEN",
      openingCents: 50000,
      notes: "Apertura demo de caja",
    }))

  // Proveedor demo (reutiliza por número de documento).
  const suppliers = await listSuppliers(tx, orgId)
  const supplierRow =
    suppliers.find((s) => s.docNumber === "20654321098") ??
    (await createSupplier(tx, orgId, ownerUserId, {
      name: "Depósito Dental Lima",
      docType: "RUC",
      docNumber: "20654321098",
      email: "ventas@deposito-dental-lima.pe",
      phone: "+5115550198",
    }))

  // Gasto de caja chica (una sola vez por concepto demo).
  const expenses = await listExpenses(tx, orgId, { branchId, limit: 200 })
  if (!expenses.some((e) => e.concept === "Guantes y mascarillas demo")) {
    await createExpense(tx, orgId, ownerUserId, {
      branchId,
      supplierId: supplierRow.id,
      concept: "Guantes y mascarillas demo",
      amountCents: 8550,
      currency: "PEN",
      receiptKind: "boleta",
      receiptNumber: "B001-000123",
      shiftId: shift.id,
    })
  }

  // Cargos manuales demo para cuentas por cobrar (una sola vez por descripción).
  const receivables = await getReceivables(tx, orgId, { patientId })
  const has = (description: string): boolean =>
    receivables.some((r) => r.charge.description === description)
  if (!has("Limpieza demo caja")) {
    await createCharge(tx, orgId, ownerUserId, patientId, {
      description: "Limpieza demo caja",
      amountCents: 20000,
      currency: "PEN",
    })
  }
  const cuotasCharge = receivables.find((r) => r.charge.description === "Obturación demo cuotas")
  if (!cuotasCharge) {
    const charge = await createCharge(tx, orgId, ownerUserId, patientId, {
      description: "Obturación demo cuotas",
      amountCents: 30000,
      currency: "PEN",
    })
    const payment = await createPayment(tx, orgId, ownerUserId, patientId, {
      amountCents: 10000,
      currency: "PEN",
      paidAt: new Date().toISOString(),
      method: "efectivo",
      reference: "caja-demo",
    })
    await applyPayment(tx, orgId, ownerUserId, patientId, payment.id, {
      chargeId: charge.id,
      amountCents: 10000,
    })
    await registerPaymentInShift(tx, orgId, ownerUserId, shift.id, payment.id)
    const plan = await createInstallmentPlan(tx, orgId, ownerUserId, patientId, {
      chargeId: charge.id,
      installments: 3,
      firstDueAt: new Date().toISOString().slice(0, 10),
      notes: "Plan demo de caja",
    })
    await refreshInstallmentPlan(tx, orgId, ownerUserId, plan.id)
  } else {
    const plans = await listInstallmentPlans(tx, orgId, { patientId })
    if (!plans.some((p) => p.plan.chargeId === cuotasCharge.charge.id)) {
      const plan = await createInstallmentPlan(tx, orgId, ownerUserId, patientId, {
        chargeId: cuotasCharge.charge.id,
        installments: 3,
        firstDueAt: new Date().toISOString().slice(0, 10),
        notes: "Plan demo de caja",
      })
      await refreshInstallmentPlan(tx, orgId, ownerUserId, plan.id)
    }
  }
}
