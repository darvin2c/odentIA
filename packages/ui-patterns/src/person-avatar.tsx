import { Avatar, AvatarFallback, AvatarImage, cn } from "@odentia/ui"

/** Tratamientos que no son parte del nombre: «Dra. Ana Torres» es «AT», no «DA». */
const TITLE = /^(dra?|doctora?|lic|lcda?|sra?|srta|od|ing)\.?$/i
/** Partículas de un apellido compuesto: «de la Cruz» se lee por «Cruz». */
const PARTICLE = /^(de|del|la|las|los|y|e)$/i

function words(text: string | null | undefined): string[] {
  return (text ?? "").trim().split(/\s+/).filter(Boolean)
}

function initialOf(word: string | undefined): string {
  return word ? word.charAt(0).toLocaleUpperCase("es") : ""
}

/**
 * Dos iniciales de una persona: la de sus nombres y la de su primer apellido,
 * sin el tratamiento («Dra.») ni las partículas («de», «del», «la», «los»).
 * Con los nombres y los apellidos por separado no se adivina nada: «María José
 * Pérez» es «MP». Con solo el nombre completo se supone un nombre de pila
 * («Rosa Quispe Mamani» → «RQ», «Juan de la Cruz Ríos» → «JC»).
 */
export function personInitials(
  person: string | { name?: string | null; givenNames?: string | null; familyName?: string | null },
): string {
  const parts = typeof person === "string" ? { name: person } : person
  const given = words(parts.givenNames).filter((word) => !TITLE.test(word))
  const family = words(parts.familyName).filter((word) => !PARTICLE.test(word))
  if (given.length > 0 && family.length > 0) return initialOf(given[0]) + initialOf(family[0])
  const named = words(parts.name).filter((word) => !TITLE.test(word))
  const [first, ...rest] = named
  if (!first) return initialOf(given[0]) || "?"
  return initialOf(first) + initialOf(rest.find((word) => !PARTICLE.test(word)))
}

/** El nombre con que se saluda, sin el tratamiento: «Dra. Ana Torres» es «Ana». */
export function personFirstName(name: string | null | undefined): string | undefined {
  return words(name).find((word) => !TITLE.test(word))
}

export interface PersonAvatarProps {
  /** Nombre completo, para las iniciales y el texto alternativo de la foto. */
  name: string
  /** Nombres y apellidos por separado, cuando se tienen: las iniciales salen exactas. */
  givenNames?: string | null
  familyName?: string | null
  /** Foto subida; sin ella, las iniciales. */
  src?: string | null
  /** Clases de tamaño (`size-9`, `size-16`…) y de forma. */
  className?: string
  /** Texto de las iniciales (tamaño de letra). */
  fallbackClassName?: string
  /** Sin texto alternativo cuando el nombre ya está escrito al lado. */
  decorative?: boolean
}

/**
 * Un solo avatar para una persona en toda la aplicación (tablero 6 del lienzo
 * de Pacientes): su foto o, sin ella, dos iniciales sobre turquesa suave. El
 * mismo círculo en la barra lateral, en Mi perfil y en la ficha.
 */
export function PersonAvatar({
  name,
  givenNames,
  familyName,
  src,
  className,
  fallbackClassName,
  decorative = false,
}: PersonAvatarProps) {
  return (
    <Avatar className={className} aria-hidden={decorative || undefined}>
      {src ? <AvatarImage src={src} alt={decorative ? "" : `Foto de ${name}`} /> : null}
      <AvatarFallback
        className={cn(
          "bg-primary-soft font-semibold text-primary-soft-foreground",
          fallbackClassName,
        )}
      >
        {personInitials({ name, givenNames, familyName })}
      </AvatarFallback>
    </Avatar>
  )
}
