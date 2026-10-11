import { describe, expect, it } from "vitest"
import { ALL_PERMISSIONS, canAccess, canAccessAny, platformPathPermission } from "./permissions.js"

// Límites del permiso operativo del agente: recepción decide en sus dominios
// sin administrar el agente (sin agent.write), sin lectura general (sin
// agent.read: sin configuración, proveedor ni conocimiento) y sin ver
// clínica/finanzas.
describe("permiso operativo agent.decide", () => {
  it("recepción decide propuestas, sin leer ni administrar el agente", () => {
    expect(canAccess("reception", "agent.decide")).toBe(true)
    expect(canAccess("reception", "agent.read")).toBe(false)
    expect(canAccess("reception", "agent.write")).toBe(false)
  })

  it("recepción conserva sus dominios y nada clínico ni financiero", () => {
    for (const permission of [
      "crm.read",
      "crm.write",
      "appointments.read",
      "appointments.write",
      "conversations.read",
      "conversations.write",
      "tasks.read",
      "tasks.write",
      "patients.read",
      "patients.write",
    ]) {
      expect(canAccess("reception", permission)).toBe(true)
    }
    for (const permission of [
      "clinical.read",
      "clinical.write",
      "finance.read",
      "finance.write",
      "settings.read",
      "settings.write",
      "inventory.read",
      "inventory.write",
      "reports.read",
      "reports.write",
      "audit.read",
      "audit.write",
    ]) {
      expect(canAccess("reception", permission)).toBe(false)
    }
  })

  it("recepción ve alertas de alergia sin leer la ficha clínica", () => {
    expect(canAccess("reception", "clinical.alerts")).toBe(true)
    expect(canAccess("reception", "clinical.read")).toBe(false)
    expect(canAccess("cashier", "clinical.alerts")).toBe(false)
    expect(canAccess("member", "clinical.alerts")).toBe(false)
    expect(ALL_PERMISSIONS).toContain("clinical.alerts")
  })

  it("otros roles operativos no deciden ni administran el agente", () => {
    for (const role of ["dentist", "cashier", "member"]) {
      expect(canAccess(role, "agent.decide")).toBe(false)
      expect(canAccess(role, "agent.write")).toBe(false)
      expect(canAccess(role, "agent.read")).toBe(false)
    }
  })

  it("owner/admin conservan todo, incluido decidir", () => {
    for (const role of ["owner", "admin"]) {
      expect(canAccess(role, "agent.decide")).toBe(true)
      expect(canAccess(role, "agent.write")).toBe(true)
      expect(canAccess(role, "agent.read")).toBe(true)
      expect(canAccess(role, "clinical.write")).toBe(true)
      expect(canAccess(role, "finance.write")).toBe(true)
    }
  })

  it("falla cerrado ante rol o permiso desconocido", () => {
    expect(canAccess("dueño", "agent.decide")).toBe(false)
    expect(canAccess("reception", "agent.borrar")).toBe(false)
    expect(canAccess("reception", "decide")).toBe(false)
    expect(canAccess("owner", "agent.borrar")).toBe(false)
  })

  it("agent.decide es un permiso conocido y listado", () => {
    expect(ALL_PERMISSIONS).toContain("agent.decide")
    expect(canAccessAny("reception", ["agent.write", "agent.decide"])).toBe(true)
    expect(canAccessAny("dentist", ["agent.write", "agent.decide"])).toBe(false)
  })

  it("aprobaciones con decidir; supervisión y conocimiento sin lectura general", () => {
    const approvals = platformPathPermission("/agent/approvals")
    expect(approvals).toContain("agent.decide")
    expect(canAccessAny("reception", approvals ?? [])).toBe(true)
    expect(canAccessAny("dentist", approvals ?? [])).toBe(false)
    // Sin agent.read, recepción no entra a supervisión ni a conocimiento.
    expect(canAccessAny("reception", platformPathPermission("/agent") ?? [])).toBe(false)
    expect(canAccessAny("reception", platformPathPermission("/agent/knowledge") ?? [])).toBe(false)
    expect(canAccessAny("owner", platformPathPermission("/agent/knowledge") ?? [])).toBe(true)
  })
})

describe("fronteras económicas por rol", () => {
  it("odontología presupuesta y consulta sus comisiones sin acceso a caja", () => {
    for (const permission of ["budgets.read", "budgets.write", "budgets.decide", "commissions.read"]) {
      expect(canAccess("dentist", permission)).toBe(true)
    }
    for (const permission of ["finance.read", "finance.write", "finance.close", "finance.admin", "commissions.write"]) {
      expect(canAccess("dentist", permission)).toBe(false)
    }
  })

  it("caja cierra y anota respuestas, sin cambiar presupuestos ni administrar comisiones", () => {
    for (const permission of ["finance.close", "budgets.read", "budgets.decide"]) {
      expect(canAccess("cashier", permission)).toBe(true)
    }
    for (const permission of ["budgets.write", "finance.admin", "commissions.read", "commissions.write"]) {
      expect(canAccess("cashier", permission)).toBe(false)
    }
  })

  it("recepción consulta el tarifario sin ver cuentas, presupuestos económicos ni comisiones", () => {
    expect(canAccess("reception", "catalog.read")).toBe(true)
    for (const permission of ["budgets.read", "budgets.write", "budgets.decide", "commissions.read"]) {
      expect(canAccess("reception", permission)).toBe(false)
    }
    expect(canAccess("member", "catalog.read")).toBe(false)
  })

  it("la entrada de comisiones no concede acceso a otros dominios", () => {
    expect(canAccessAny("dentist", platformPathPermission("/commissions") ?? [])).toBe(true)
    expect(canAccessAny("dentist", platformPathPermission("/finance") ?? [])).toBe(false)
    expect(canAccessAny("cashier", platformPathPermission("/commissions") ?? [])).toBe(false)
    expect(canAccess("owner", "budgets.delete")).toBe(false)
  })
})
