// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { submitForm, useAppForm } from "./app-form.js"
import { addSubmitErrors, setSubmitErrors } from "./server-errors.js"

afterEach(cleanup)

const OUT_OF_RANGE = "«Dolor» debe ser ≤ 10"

/** Un formulario que se guarda solo: «Finalizar» marca lo que falta y el autoguardado, lo que no vale. */
function Evaluation({ replace = false }: { replace?: boolean }) {
  const form = useAppForm({
    defaultValues: { findings: "", pain: "15" },
    validators: {
      onSubmit: ({ value }) => (value.findings ? undefined : { fields: { findings: "Responde esta pregunta para finalizar." } }),
    },
    onSubmit: async () => {},
  })
  return (
    <div>
      <form.AppField name="findings">{(field) => <field.TextField label="Hallazgos" />}</form.AppField>
      <form.AppField name="pain">{(field) => <field.TextField label="Dolor" />}</form.AppField>
      <button type="button" onClick={() => void submitForm(form)}>
        Finalizar
      </button>
      <button
        type="button"
        onClick={() => (replace ? setSubmitErrors(form, { fields: { pain: OUT_OF_RANGE } }) : addSubmitErrors(form, { pain: OUT_OF_RANGE }))}
      >
        Llega el autoguardado
      </button>
    </div>
  )
}

const invalid = (label: string) => screen.getByLabelText(label).getAttribute("aria-invalid") === "true"

describe("addSubmitErrors", () => {
  // Revisión de la entrega 3: el aviso del valor que no vale borraba las marcas de «falta responder».
  it("suma el aviso de un campo sin borrar los que ya estaban a la vista", async () => {
    render(<Evaluation />)
    await userEvent.click(screen.getByRole("button", { name: "Finalizar" }))
    await waitFor(() => expect(invalid("Hallazgos")).toBe(true))
    await userEvent.click(screen.getByRole("button", { name: "Llega el autoguardado" }))
    await waitFor(() => expect(invalid("Dolor")).toBe(true))
    expect(screen.getByText(OUT_OF_RANGE)).toBeTruthy()
    // Lo que faltaba responder sigue marcado.
    expect(invalid("Hallazgos")).toBe(true)
    expect(screen.getByText("Responde esta pregunta para finalizar.")).toBeTruthy()
  })

  it("cada aviso se va al corregir su campo, y solo el suyo", async () => {
    render(<Evaluation />)
    await userEvent.click(screen.getByRole("button", { name: "Finalizar" }))
    await userEvent.click(screen.getByRole("button", { name: "Llega el autoguardado" }))
    await waitFor(() => expect(invalid("Dolor")).toBe(true))
    await userEvent.clear(screen.getByLabelText("Dolor"))
    await userEvent.type(screen.getByLabelText("Dolor"), "5")
    await waitFor(() => expect(invalid("Dolor")).toBe(false))
    expect(invalid("Hallazgos")).toBe(true)
  })

  it("`setSubmitErrors` reemplaza todo: por eso el autoguardado no lo usa", async () => {
    render(<Evaluation replace />)
    await userEvent.click(screen.getByRole("button", { name: "Finalizar" }))
    await waitFor(() => expect(invalid("Hallazgos")).toBe(true))
    await userEvent.click(screen.getByRole("button", { name: "Llega el autoguardado" }))
    await waitFor(() => expect(invalid("Dolor")).toBe(true))
    expect(invalid("Hallazgos")).toBe(false)
  })
})
