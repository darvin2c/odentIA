// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { useAppForm, useFormSurface } from "./app-form.js"
import { INCOMPLETE_PHONE } from "./fields.js"
import { FormPanel } from "./form-panel.js"
import { setSubmitErrors } from "./server-errors.js"
import { SUBMIT_ERROR_WORDS } from "./submit-error.js"

// Base UI ScrollArea/Select y jsdom necesitan polyfills mínimos
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

/** El `ApiError` de las apps: estado HTTP y cuerpo `{ error }`. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    public shape: { code?: string; message?: string; fields?: Record<string, string> },
  ) {
    super(shape.message)
  }
}

interface Branch {
  name: string
  phone: string | null
}

function BranchForm({ save }: { save: (value: Branch) => Promise<void> }) {
  const form = useAppForm({
    defaultValues: { name: "", phone: null } as Branch,
    validators: {
      // Como un esquema Zod (Standard Schema): cada campo recibe una lista de issues.
      onSubmit: ({ value }) => (value.name.trim() ? undefined : { fields: { name: [{ message: "Escribe el nombre" }] } }),
    },
    onSubmit: async ({ value }) => save(value),
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Nueva sede" onClose={() => {}}>
      <form.AppField name="name">{(field) => <field.TextField label="Nombre" />}</form.AppField>
      <form.AppField name="phone">
        {(field) => <field.PhoneField label="Teléfono" defaultCountry="PE" showCountrySelect={false} />}
      </form.AppField>
    </FormPanel>
  )
}

/** Un dato que se elige con botones, obligatorio al salir del grupo. */
function KindForm() {
  const form = useAppForm({ defaultValues: { kind: "", note: "" } })
  return (
    <form>
      <form.AppField name="kind" validators={{ onBlur: ({ value }) => (value ? undefined : "Elige una clase") }}>
        {(field) => (
          <field.Group legend="Clase">
            {() => (
              <div>
                <button type="button" onClick={() => field.handleChange("regla")}>
                  Regla
                </button>
                <button type="button" onClick={() => field.handleChange("ejemplo")}>
                  Ejemplo
                </button>
              </div>
            )}
          </field.Group>
        )}
      </form.AppField>
      <form.AppField name="note">{(field) => <field.TextField label="Nota" />}</form.AppField>
    </form>
  )
}

/** Un dato que se abre para corregir: el campo aparece con lo guardado. */
function FixForm() {
  const [open, setOpen] = useState(false)
  const form = useAppForm({ defaultValues: { text: "" } })
  return (
    <form>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          form.reset({ text: "Prefiere citas por la tarde" })
        }}
      >
        Corregir
      </button>
      {open ? <form.AppField name="text">{(field) => <field.TextField label="Corregir el dato" />}</form.AppField> : null}
    </form>
  )
}

/** Un esquema que valida un dato sin campo en pantalla (la región). */
function HiddenFieldForm({ save }: { save: () => Promise<void> }) {
  const form = useAppForm({
    defaultValues: { name: "Centro", region: "" },
    validators: {
      onSubmit: ({ value }) => (value.region ? undefined : { fields: { region: [{ message: "Elige la región" }] } }),
    },
    onSubmit: save,
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Nueva sede" onClose={() => {}}>
      <form.AppField name="name">{(field) => <field.TextField label="Nombre" />}</form.AppField>
    </FormPanel>
  )
}

/** Una pregunta de opciones que hay que responder antes de guardar. */
function ChoiceForm() {
  const form = useAppForm({
    defaultValues: { kind: "" },
    validators: { onSubmit: ({ value }) => (value.kind ? undefined : { fields: { kind: "Elige una clase" } }) },
    onSubmit: async () => {},
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Nueva lección" onClose={() => {}}>
      <form.AppField name="kind">
        {(field) => (
          <field.Group legend="Clase">
            {() => (
              <div>
                <button type="button" onClick={() => field.handleChange("regla")}>
                  Regla
                </button>
                <button type="button" onClick={() => field.handleChange("ejemplo")}>
                  Ejemplo
                </button>
              </div>
            )}
          </field.Group>
        )}
      </form.AppField>
    </FormPanel>
  )
}

/** Invitar a varias personas seguidas: el cajón sigue con el mismo rol. */
function InviteForm() {
  const form = useAppForm({
    defaultValues: { email: "", role: "support" },
    onSubmit: async ({ value, formApi }) => formApi.reset({ email: "", role: value.role }),
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Invitar" onClose={() => {}}>
      <form.AppField name="email">{(field) => <field.TextField label="Correo" />}</form.AppField>
      <form.AppField name="role">{(field) => <field.TextField label="Rol" />}</form.AppField>
    </FormPanel>
  )
}

/** Una compra con filas que se pueden quitar; el servidor rechaza precios por fila. */
function LinesForm({ save }: { save: () => Promise<void> }) {
  const form = useAppForm({
    defaultValues: { lines: [{ price: "1" }, { price: "" }, { price: "" }] },
    onSubmit: save,
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Nueva compra" onClose={() => {}}>
      <form.AppField name="lines" mode="array">
        {(list) =>
          list.state.value.map((_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: las filas de TanStack Form se identifican por su índice
            <div key={index}>
              <form.AppField name={`lines[${index}].price`}>
                {(field) => <field.TextField label={`Precio ${index + 1}`} />}
              </form.AppField>
              <button type="button" onClick={() => list.removeValue(index)}>
                Quitar {index + 1}
              </button>
            </div>
          ))
        }
      </form.AppField>
    </FormPanel>
  )
}

/** Un dato que estuvo en pantalla y ya no; la pantalla marca su falta por su cuenta (`setSubmitErrors`). */
function ClosedSectionForm() {
  const [open, setOpen] = useState(true)
  const form = useAppForm({
    defaultValues: { name: "Centro", note: "" },
    onSubmit: async ({ formApi }) => setSubmitErrors(formApi, { fields: { note: "Escribe la nota" } }),
  })
  const surface = useFormSurface(form)
  return (
    <FormPanel {...surface} title="Nueva sede" onClose={() => {}}>
      <button type="button" onClick={() => setOpen(false)}>
        Cerrar nota
      </button>
      <form.AppField name="name">{(field) => <field.TextField label="Nombre" />}</form.AppField>
      {open ? <form.AppField name="note">{(field) => <field.TextField label="Nota" />}</form.AppField> : null}
    </FormPanel>
  )
}

describe("useAppForm", () => {
  it("lo que no pasa la validación se marca en su campo, no se envía y el foco va a él", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {})
    render(<BranchForm save={save} />)

    await user.click(screen.getByRole("button", { name: "Guardar" }))

    const name = screen.getByLabelText("Nombre")
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"))
    const errorId = name.getAttribute("aria-describedby")
    expect(errorId && document.getElementById(errorId)?.textContent).toBe("Escribe el nombre")
    expect(save).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(name))

    // Salir del campo sin corregirlo no lo borra.
    await user.tab()
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Escribe el nombre")).toBeTruthy()

    // Al corregirlo, el error se va sin esperar al próximo envío.
    await user.type(name, "Centro")
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBeNull())
    expect(screen.queryByText("Escribe el nombre")).toBeNull()
  })

  it("el rechazo del servidor cae en su campo; lo que no tiene campo, junto a los botones", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {
      throw new FakeApiError(400, {
        code: "VALIDATION",
        message: "Ya hay una sede con ese nombre",
        fields: { name: "Ya hay una sede con ese nombre", addressLine1: "Escribe la calle" },
      })
    })
    render(<BranchForm save={save} />)

    const name = screen.getByLabelText("Nombre")
    await user.type(name, "Centro")
    await user.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"))
    const errorId = name.getAttribute("aria-describedby")
    expect(errorId && document.getElementById(errorId)?.textContent).toBe("Ya hay una sede con ese nombre")
    // La calle no está en este formulario: no se pierde, se dice junto a los botones.
    const formAlert = screen.getByText("Escribe la calle")
    expect(formAlert.getAttribute("role")).toBe("alert")

    // Entrar y salir de un campo no borra lo que dijo el servidor.
    await user.click(name)
    await user.tab()
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Escribe la calle").getAttribute("role")).toBe("alert")

    await user.type(name, " Norte")
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBeNull())
  })

  it("un teléfono a medias no se guarda vacío: el campo lo dice y el envío espera", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {})
    render(<BranchForm save={save} />)

    await user.type(screen.getByLabelText("Nombre"), "Centro")
    await user.type(screen.getByLabelText("Teléfono"), "987")
    await user.click(screen.getByRole("button", { name: "Guardar" }))

    expect(await screen.findByText(INCOMPLETE_PHONE)).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it("sin respuesta del servidor no promete nada: lo dice y conserva lo escrito", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    render(<BranchForm save={save} />)

    await user.type(screen.getByLabelText("Nombre"), "Centro")
    await user.click(screen.getByRole("button", { name: "Guardar" }))

    expect(await screen.findByText(SUBMIT_ERROR_WORDS.unconfirmed)).toBeTruthy()
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Centro")
  })

  it("un grupo se da por visitado al salir de él, no al pasar de una opción a otra", async () => {
    const user = userEvent.setup()
    render(<KindForm />)

    await user.tab()
    await user.tab()
    expect(document.activeElement?.textContent).toBe("Ejemplo")
    expect(screen.queryByText("Elige una clase")).toBeNull()

    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText("Nota"))
    expect(await screen.findByText("Elige una clase")).toBeTruthy()
  })

  it("lo que deja `reset(values)` sigue en el campo aunque el hook reciba otros valores iniciales", async () => {
    const user = userEvent.setup()
    render(<FixForm />)

    await user.click(screen.getByRole("button", { name: "Corregir" }))

    expect((screen.getByLabelText("Corregir el dato") as HTMLInputElement).value).toBe("Prefiere citas por la tarde")
  })

  it("lo que no pasa en un dato sin campo en pantalla se dice junto a los botones", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {})
    render(<HiddenFieldForm save={save} />)

    await user.click(screen.getByRole("button", { name: "Guardar" }))

    expect((await screen.findByText("Elige la región")).getAttribute("role")).toBe("alert")
    expect(save).not.toHaveBeenCalled()
  })

  it("un grupo sin responder recibe el foco en su primera opción al enviar", async () => {
    const user = userEvent.setup()
    render(<ChoiceForm />)

    await user.click(screen.getByRole("button", { name: "Guardar" }))

    expect(await screen.findByText("Elige una clase")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Regla" })))
  })

  it("lo que deja `reset(values)` desde `onSubmit` sigue en el campo después de guardar", async () => {
    const user = userEvent.setup()
    render(<InviteForm />)

    const role = screen.getByLabelText("Rol") as HTMLInputElement
    await user.clear(role)
    await user.type(role, "admin")
    await user.type(screen.getByLabelText("Correo"), "ana@clinica.pe")
    await user.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() => expect((screen.getByLabelText("Correo") as HTMLInputElement).value).toBe(""))
    expect((screen.getByLabelText("Rol") as HTMLInputElement).value).toBe("admin")
  })

  it("al quitar una fila, el rechazo de las filas no queda en otra fila ni se pierde sin corregir", async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => {
      throw new FakeApiError(400, {
        code: "VALIDATION",
        message: "Revisa los precios",
        fields: { "lines[1].price": "Escribe el precio", "lines[2].price": "Escribe el precio" },
      })
    })
    render(<LinesForm save={save} />)

    await user.click(screen.getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(screen.getAllByText("Escribe el precio")).toHaveLength(2))

    await user.click(screen.getByRole("button", { name: "Quitar 1" }))

    // Las filas se movieron: ninguna lleva el aviso de otra; el próximo envío lo vuelve a decir.
    await waitFor(() => expect(screen.queryByText("Escribe el precio")).toBeNull())
    expect(screen.getByLabelText("Precio 1").getAttribute("aria-invalid")).toBeNull()
    expect(screen.getByLabelText("Precio 2").getAttribute("aria-invalid")).toBeNull()
    // El servidor vuelve a señalar la fila que sigue sin precio (la que ya no existe va junto a los botones).
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(screen.getByLabelText("Precio 2").getAttribute("aria-invalid")).toBe("true"))
  })

  it("lo que se marca en un dato que ya no está en pantalla se dice junto a los botones", async () => {
    const user = userEvent.setup()
    render(<ClosedSectionForm />)

    await user.click(screen.getByRole("button", { name: "Cerrar nota" }))
    await user.click(screen.getByRole("button", { name: "Guardar" }))

    expect((await screen.findByText("Escribe la nota")).getAttribute("role")).toBe("alert")
  })
})
