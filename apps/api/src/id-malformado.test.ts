import { expect, it } from "vitest"
import { idMalformadoEnLaDireccion } from "./app.js"

const postgresUuid = (valor: string) =>
  Object.assign(new Error(`invalid input syntax for type uuid: "${valor}"`), { code: "22P02" })

it("un id que no es uuid en la dirección cuenta como inexistente", () => {
  expect(idMalformadoEnLaDireccion(postgresUuid("HTTP"), "/api/patients/HTTP")).toBe(true)
  // Drizzle envuelve el error de Postgres.
  expect(
    idMalformadoEnLaDireccion(
      new Error("Failed query", { cause: postgresUuid("abc") }),
      "/api/patients/not-a-uuid/encounters/abc",
    ),
  ).toBe(true)
})

it("un uuid inválido que viene del cuerpo sigue siendo un error interno", () => {
  expect(idMalformadoEnLaDireccion(postgresUuid("zzz"), "/api/patients")).toBe(false)
  expect(idMalformadoEnLaDireccion(new Error("otro"), "/api/patients/HTTP")).toBe(false)
})
