/**
 * La firma de las personas de una demo: distinta para cada una y siempre la misma
 * para el mismo nombre. Solo la usan las semillas y las demos para presentar.
 */
import type { SignatureStrokes } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { professionalDrawnSignature } from "@odentia/db/schema/clinical-forms"

/** Un número de 0 a 1 que sale siempre igual del nombre. */
function seedOf(name: string): number {
  let hash = 7
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973
  return hash / 9973
}

const clamp = (value: number) => Math.round(Math.min(1000, Math.max(0, value)))

export function demoSignatureStrokes(name: string): SignatureStrokes {
  const seed = seedOf(name)
  const points = (count: number, at: (t: number) => [number, number]) =>
    Array.from({ length: count }, (_, index) => {
      const [x, y] = at(index / (count - 1))
      return [clamp(x), clamp(y)]
    })
  // La inicial: un rizo alto, como casi toda firma a mano.
  const initial = points(36, (t) => [
    70 + 130 * t + 55 * Math.sin(2 * Math.PI * t),
    470 - 360 * Math.sin(Math.PI * t) + 150 * Math.cos(2 * Math.PI * t) * t,
  ])
  // El apellido corrido: una ola que se va apagando.
  const waves = 7 + seed * 4
  const name2 = points(96, (t) => [
    190 + (610 + 90 * seed) * t,
    560 - (250 * (1 - t) + 40) * Math.sin(waves * Math.PI * t) - 50 * t,
  ])
  // El remate debajo del nombre.
  const flourish = points(22, (t) => [
    130 + 780 * t,
    860 - 130 * t + 45 * Math.sin(Math.PI * t * (1 + seed)),
  ])
  return [initial, name2, flourish]
}

/**
 * Con una fecha de hace años: cada papel lleva la firma que regía al emitirse, y
 * la historia de una demo tiene papeles de otros meses.
 */
export async function seedDemoSignature(
  tx: Db,
  orgId: string,
  userId: string,
  name: string,
): Promise<void> {
  await tx.insert(professionalDrawnSignature).values({
    organizationId: orgId,
    userId,
    strokes: demoSignatureStrokes(name),
    createdAt: new Date("2020-01-01T00:00:00Z"),
  })
}
