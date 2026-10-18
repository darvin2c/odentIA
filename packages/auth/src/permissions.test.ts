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

  it("recepción recibe la tomografía sin abrirla (ADR 0054)", () => {
    expect(canAccess("reception", "clinical.receive")).toBe(true)
    expect(canAccess("reception", "clinical.read")).toBe(false)
    expect(canAccess("cashier", "clinical.receive")).toBe(false)
    expect(canAccess("dentist", "clinical.receive")).toBe(false)
    expect(canAccess("admin", "clinical.receive")).toBe(true)
    expect(ALL_PERMISSIONS).toContain("clinical.receive")
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

  it("el tablero de oportunidades pide lo mismo que sus datos", () => {
    const pipeline = platformPathPermission("/pipeline")
    expect(pipeline).toEqual(platformPathPermission("/opportunities/abc"))
    expect(canAccessAny("reception", pipeline ?? [])).toBe(true)
    // Odontología y caja no leen el CRM: sin regla entraban y el servidor les negaba los datos.
    expect(canAccessAny("dentist", pipeline ?? [])).toBe(false)
    expect(canAccessAny("cashier", pipeline ?? [])).toBe(false)
  })

  it("la auditoría, bajo Configuración, la abre quien puede consultarla", () => {
    expect(platformPathPermission("/settings/audit")).toEqual(["audit.read"])
    expect(platformPathPermission("/settings/branches")).toEqual(["settings.read"])
    expect(platformPathPermission("/audit")).toBeNull()
  })

  it("etapas de venta y campos de contacto los abre también quien trabaja con ventas", () => {
    for (const path of ["/settings/pipelines", "/settings/fields"]) {
      const rule = platformPathPermission(path) ?? []
      expect(canAccessAny("reception", rule)).toBe(true)
      expect(canAccessAny("admin", rule)).toBe(true)
      expect(canAccessAny("dentist", rule)).toBe(false)
      expect(canAccessAny("cashier", rule)).toBe(false)
    }
    // El resto de Configuración sigue cerrado para recepción.
    expect(canAccessAny("reception", platformPathPermission("/settings/branches") ?? [])).toBe(false)
  })

  it("Sedes, Equipo e Integraciones entran con Configuración; sus direcciones antiguas piden lo mismo", () => {
    for (const path of [
      "/settings/branches",
      "/settings/team",
      "/settings/integrations",
      "/settings/integrations/whatsapp",
      "/settings/integrations/webchat",
      // Antiguas: redirigen a las de arriba.
      "/branches",
      "/members",
      "/settings/channels",
      "/settings/mail",
    ]) {
      expect(platformPathPermission(path), path).toEqual(["settings.read"])
    }
    // Recepción conversa por correo, pero no configura los buzones.
    expect(canAccessAny("reception", platformPathPermission("/settings/integrations") ?? [])).toBe(false)
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

  it("recepción lee, envía y anota el presupuesto, pero no cambia precios ni ve cuentas o comisiones", () => {
    expect(canAccess("reception", "catalog.read")).toBe(true)
    for (const permission of ["budgets.read", "budgets.send", "budgets.decide"]) {
      expect(canAccess("reception", permission)).toBe(true)
    }
    for (const permission of ["budgets.write", "commissions.read", "finance.read"]) {
      expect(canAccess("reception", permission)).toBe(false)
    }
    expect(canAccess("member", "catalog.read")).toBe(false)
  })

  it("enviar el presupuesto es un permiso aparte de armarlo: caja anota, pero no envía", () => {
    expect(ALL_PERMISSIONS).toContain("budgets.send")
    expect(canAccess("dentist", "budgets.send")).toBe(true)
    expect(canAccess("cashier", "budgets.send")).toBe(false)
    expect(canAccess("member", "budgets.send")).toBe(false)
  })

  it("la entrada de comisiones no concede acceso a otros dominios", () => {
    expect(canAccessAny("dentist", platformPathPermission("/commissions") ?? [])).toBe(true)
    expect(canAccessAny("dentist", platformPathPermission("/finance") ?? [])).toBe(false)
    expect(canAccessAny("cashier", platformPathPermission("/commissions") ?? [])).toBe(false)
    expect(canAccess("owner", "budgets.delete")).toBe(false)
  })
})

describe("tareas de toda la clínica", () => {
  it("solo propietario y administrador ven las de toda la clínica; los demás, las suyas y las de su área", () => {
    for (const role of ["owner", "admin"]) expect(canAccess(role, "tasks.all")).toBe(true)
    for (const role of ["reception", "dentist", "cashier", "member"]) {
      expect(canAccess(role, "tasks.read")).toBe(true)
      expect(canAccess(role, "tasks.all")).toBe(false)
    }
  })
})
