import { platformPathPermission } from "@odentia/auth/permissions"
import { expect, it } from "vitest"

// Que cada pantalla del árbol tenga su regla lo prueba cada app contra su árbol
// (`lib/route-tree-checks.ts`, ADR 0086).

it("«Pendientes» la abre quien la abría como «Aprobaciones»: también quien solo decide por el agente", () => {
  // Recepción decide por el agente (`agent.decide`) sin supervisarlo (`agent.read`):
  // con la regla genérica de `/agent` se quedaría fuera de sus casos derivados.
  expect(platformPathPermission("/agent/pendientes")).toEqual(platformPathPermission("/agent/approvals"))
})

it("la ficha y Contactos redirigen con la misma regla que la página de la persona", () => {
  // Odontología y caja no leen el CRM: una dirección vieja de Contactos no puede dejarlos fuera.
  expect(platformPathPermission("/contacts/123")).toEqual(platformPathPermission("/people/123"))
  expect(platformPathPermission("/patients/123")).toEqual(platformPathPermission("/people/123"))
})
