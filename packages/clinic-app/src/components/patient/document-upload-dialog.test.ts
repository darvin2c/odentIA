import { describe, expect, it } from "vitest"
import { sharedRowError, uploadWords } from "./document-upload-dialog"

// Pedido del 15 nov: tras una subida que falló, el botón decía «Subir 0» y el mismo error rojo
// salía en cada fila.
describe("la ventana de subir", () => {
  it("el botón dice cuántos archivos sube, y sin ninguno dice solo «Subir»", () => {
    expect(uploadWords(0)).toBe("Subir")
    expect(uploadWords(1)).toBe("Subir 1 archivo")
    expect(uploadWords(3)).toBe("Subir 3 archivos")
  })
  it("el mismo motivo en varias filas se dice una vez; si cada fila tiene el suyo, cada una lo dice", () => {
    expect(sharedRowError(["Se cortó la conexión.", null, "Se cortó la conexión."])).toBe("Se cortó la conexión.")
    expect(sharedRowError(["Se cortó la conexión.", null])).toBeNull()
    expect(sharedRowError(["El título es muy largo.", "Elige la categoría."])).toBeNull()
    expect(sharedRowError([null, null])).toBeNull()
  })
})
