import { stopStack } from "./stack"

/** Derriba contenedores, proxy y estado del harness. */
export default async function globalTeardown(): Promise<void> {
  await stopStack()
}