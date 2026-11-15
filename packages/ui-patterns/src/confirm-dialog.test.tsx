// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { common } from "./common.js"
import { ConfirmDialog, UnsavedDialog } from "./confirm-dialog.js"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <ConfirmDialog
      open
      title="Eliminar mesa"
      description="Solo si nunca tuvo cuentas."
      confirmLabel="Eliminar"
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onConfirm, onClose }
}

describe("ConfirmDialog", () => {
  it("cerrado no renderiza nada", () => {
    renderDialog({ open: false })
    expect(screen.queryByText("Eliminar mesa")).toBeNull()
  })

  it("muestra título, consecuencia y acciones", () => {
    renderDialog()
    expect(screen.getByText("Eliminar mesa")).toBeTruthy()
    expect(screen.getByText("Solo si nunca tuvo cuentas.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy()
  })

  it("confirmar dispara onConfirm sin cerrar solo", () => {
    const { onConfirm, onClose } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
  it("destructive se ve danger; default no", () => {
    renderDialog({ variant: "destructive" })
    const destructive = screen.getByRole("button", { name: "Eliminar" })
    expect(destructive.className).toContain("bg-destructive")
    expect(destructive.className).toContain("text-destructive-foreground")
    cleanup()
    document.body.innerHTML = ""
    renderDialog({ variant: "default", confirmLabel: "Archivar" })
    const archival = screen.getByRole("button", { name: "Archivar" })
    expect(archival.className).not.toContain("bg-destructive")
  })

  it("pending bloquea ambas acciones", () => {
    const { onConfirm, onClose } = renderDialog({ pending: true })
    const confirm = screen.getByRole("button", { name: /Eliminar/ })
    expect(confirm.hasAttribute("disabled")).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// QA de la entrega 3 (14 nov): salir por el menú preguntaba con otro diálogo («Salir sin guardar los
// cambios»), decía que se perdían los cambios de la página aunque ya estaban guardados y pintaba
// «Descartar y salir» como la acción principal.
describe("UnsavedDialog", () => {
  it("dice lo que se pierde, y quedarse es lo principal: va al final y recibe el foco", async () => {
    const onStay = vi.fn()
    const onDiscard = vi.fn()
    render(
      <UnsavedDialog
        open
        lost="No se guardó «15» en «Intensidad del dolor (0–10)». Lo demás ya está guardado."
        onStay={onStay}
        onDiscard={onDiscard}
      />,
    )
    const dialog = await screen.findByRole("alertdialog", { name: common.confirm.unsaved.title })
    expect(dialog.textContent).toContain("Lo demás ya está guardado.")
    const stay = screen.getByRole("button", { name: "Seguir aquí" })
    const buttons = [...dialog.querySelectorAll("button")]
    expect(buttons.at(-1)).toBe(stay)
    await waitFor(() => expect(document.activeElement).toBe(stay))

    fireEvent.click(screen.getByRole("button", { name: "Descartar y salir" }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    fireEvent.click(stay)
    expect(onStay).toHaveBeenCalled()
  })

  it("sin saber qué se pierde, dice el texto común", async () => {
    render(<UnsavedDialog open onStay={() => {}} onDiscard={() => {}} />)
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain(common.confirm.unsaved.description)
  })
})
