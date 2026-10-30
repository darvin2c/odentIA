// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { useAppForm, useFormSurface } from "./app-form.js"
import { INCOMPLETE_PHONE } from "./fields.js"
import { FormPanel } from "./form-panel.js"
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
})
