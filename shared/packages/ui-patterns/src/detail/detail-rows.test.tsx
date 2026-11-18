// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DetailField, DetailList, DetailSection } from "./detail-rows.js"

afterEach(cleanup)

describe("DetailSection y DetailList", () => {
  it("la sección titulada expone un encabezado", () => {
    render(
      <DetailSection title="Datos de la atención">
        <DetailList>
          <DetailField label="Paciente">María Quispe</DetailField>
        </DetailList>
      </DetailSection>,
    )

    expect(screen.getByRole("heading", { name: "Datos de la atención" })).not.toBeNull()
  })

  it("sin título ni acciones la sección no inventa encabezado", () => {
    render(
      <DetailSection>
        <DetailList>
          <DetailField label="Paciente">María Quispe</DetailField>
        </DetailList>
      </DetailSection>,
    )

    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("cada campo es un término con su definición asociada", () => {
    render(
      <DetailList>
        <DetailField label="Paciente">María Quispe</DetailField>
        <DetailField label="Odontólogo">Dra. Ramos</DetailField>
      </DetailList>,
    )

    expect(screen.getAllByRole("term")).toHaveLength(2)
    const definitions = screen.getAllByRole("definition")
    expect(definitions.map((node) => node.textContent)).toEqual(["María Quispe", "Dra. Ramos"])
    expect(screen.getAllByRole("term").map((node) => node.textContent)).toEqual([
      "Paciente",
      "Odontólogo",
    ])
  })
})

describe("DetailField", () => {
  it("sin valor muestra la raya de «sin dato»", () => {
    render(
      <DetailList>
        <DetailField label="Control indicado" />
        <DetailField label="Observaciones" />
        <DetailField label="Grupo sanguíneo">{""}</DetailField>
      </DetailList>,
    )

    const definitions = screen.getAllByRole("definition")
    expect(definitions.map((node) => node.textContent)).toEqual(["—", "—", "—"])
  })

  it("conserva un valor igual a 0 y uno booleano falso", () => {
    render(
      <DetailList>
        <DetailField label="Piezas">0</DetailField>
        <DetailField label="Requiere control">{String(false)}</DetailField>
      </DetailList>,
    )

    const definitions = screen.getAllByRole("definition")
    expect(definitions.map((node) => node.textContent)).toEqual(["0", "false"])
  })
})