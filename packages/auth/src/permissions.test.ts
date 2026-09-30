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
