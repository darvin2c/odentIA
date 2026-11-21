import { type KeyboardEvent, useRef, useState } from "react"

/**
 * Un buscador que también acepta lo escrito (la sustancia de una alergia, la medicación habitual):
 * Enter sin nada resaltado en la lista deja lo escrito, igual que salir del campo, y no envía el
 * formulario con el campo vacío. Con algo resaltado, Enter lo elige como siempre.
 *
 * `commit` guarda lo escrito y dice qué pasó: «guardado» (Enter no envía y la lista se cierra),
 * «queda» (hay algo escrito que no se puede guardar así: Enter no envía y la lista sigue abierta
 * para elegir) o «nada» (no hay nada escrito sin elegir: Enter hace lo de siempre).
 */
export type FreeTextCommit = "guardado" | "queda" | "nada"

export function useFreeTextCombobox(commit: () => FreeTextCommit) {
  const [open, setOpen] = useState(false)
  const highlighted = useRef(false)
  return {
    rootProps: {
      open,
      onOpenChange: (next: boolean) => setOpen(next),
      onItemHighlighted: (item: unknown) => {
        highlighted.current = item !== undefined && item !== null
      },
    },
    // `preventBaseUIHandler` lo agrega el Combobox a sus eventos: deja la lista abierta.
    onKeyDown: (event: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
      // El Enter que confirma lo compuesto con un teclado de ideogramas (Safari lo manda sin
      // `isComposing`, con el código 229) no es elegir.
      if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (open && highlighted.current) return
      const result = commit()
      if (result === "nada") return
      // Lo escrito queda en el campo: el primer Enter lo confirma, el siguiente envía.
      event.preventDefault()
      if (result === "guardado") setOpen(false)
      else event.preventBaseUIHandler?.()
    },
  }
}
