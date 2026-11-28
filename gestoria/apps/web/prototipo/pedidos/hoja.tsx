import { Button, cn } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { createContext, type ComponentProps, type ReactNode, useContext, useId } from "react"
import { createPortal } from "react-dom"

/**
 * Lo que toca se hace siempre dentro del cajón «pedido + lo que toca». Cada acción (confirmar,
 * pasar, anular, revisar…) sigue escrita como un formulario; dentro del cajón se muestra en su
 * columna, con sus botones en el lugar fijo del cajón: al pie en el celular y bajo la acción en
 * escritorio. Fuera del cajón (lo que no es de un pedido) sigue siendo un `FormDrawer`.
 */
interface Cajon {
  /** Dónde van los botones: el pie fijo (celular) o el final de la columna de la acción. */
  botones: HTMLElement | null
  /** Si la acción salió del ⋯ o de «No coincide…»: «Volver» regresa a lo que toca. */
  volver?: () => void
}
const CajonCtx = createContext<Cajon | null>(null)
export const CajonProvider = CajonCtx.Provider
export const useEnCajon = () => useContext(CajonCtx)

/** Los botones de la acción, en el lugar fijo del cajón. */
export function Botones({ children, className }: { children: ReactNode; className?: string }) {
  const c = useEnCajon()
  const fila = (
    <div
      className={cn(
        "flex w-full flex-wrap gap-2 [&>button]:h-11 [&>button]:min-w-0 [&>button]:flex-1 [&>button]:whitespace-nowrap",
        className,
      )}
    >
      {children}
    </div>
  )
  if (!c) return fila
  return c.botones ? createPortal(fila, c.botones) : null
}

type HojaProps = ComponentProps<typeof FormDrawer>

/** Un formulario de acción: en el cajón, en su columna; fuera, un `FormDrawer` como antes. */
export function Hoja(props: HojaProps) {
  const c = useEnCajon()
  const id = useId()
  if (!c) return <FormDrawer {...props} />
  const { title, description, children, onSubmit, submitLabel, submitDisabled, secondaryAction, error, hideSubmit } =
    props
  return (
    <form id={id} className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
      <div className="flex flex-col gap-0.5">
        <h3 className="font-heading text-base font-semibold">{title}</h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Botones>
        {c.volver ? (
          <Button type="button" variant="outline" onClick={c.volver}>
            Volver
          </Button>
        ) : null}
        {secondaryAction ? (
          <Button
            type="button"
            variant="outline"
            disabled={secondaryAction.disabled}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        {hideSubmit ? null : (
          <Button type="submit" form={id} disabled={submitDisabled} className="basis-40 grow-[2]">
            {submitLabel ?? "Guardar"}
          </Button>
        )}
      </Botones>
    </form>
  )
}
