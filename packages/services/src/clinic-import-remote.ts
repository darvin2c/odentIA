/**
 * La skill de carga contra producción (ADR 0183): corre la orden dentro del contenedor de la
 * API por SSH (`apps/api/src/cli/carga.ts`, con la base, el almacenamiento y el correo de
 * producción). El archivo va por la entrada estándar de la conexión: no queda copia en el
 * servidor, ni aunque se corte.
 *
 *   pnpm --filter @odentia/services import:produccion -- <orden> <slug> [<archivo>|<número>] --como <correo>
 *     [--enviado-el <AAAA-MM-DD>] [--con-nombres] [--host vps] [--contenedor openship-odentia-api]
 *
 * Órdenes: ensayo, cargar, pacientes-ensayo, pacientes-cargar, informe-ver, informe-enviar,
 * informe-registrar, informe-salio y registro (lo que hace cada una, en `carga.ts`). Lo que
 * escribe en producción (cargar, pacientes-cargar, informe-enviar, informe-registrar,
 * informe-salio) se corre solo con la aprobación del plan o del informe, como dice la skill.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const cwd = process.env.INIT_CWD ?? process.cwd()
const SWITCHES = new Set(["--con-nombres"])
const args = process.argv.slice(2).filter((arg) => arg !== "--")
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const positionals = args.filter((arg, index) => {
  const before = args[index - 1]
  return !arg.startsWith("--") && !(before?.startsWith("--") && !SWITCHES.has(before))
})
const [command, slug, file] = positionals

const WITH_FILE = new Set([
  "ensayo",
  "cargar",
  "pacientes-ensayo",
  "pacientes-cargar",
  "informe-ver",
  "informe-enviar",
  "informe-registrar",
])
const COMMANDS = new Set([...WITH_FILE, "informe-salio", "registro"])

// Lo que va en la línea del servidor se comprueba antes: nada de lo escrito llega a la shell sin pasar por aquí.
const SAFE = {
  slug: /^[a-z0-9][a-z0-9-]{0,62}$/,
  email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  date: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
  number: /^[1-9]\d{0,5}$/,
  name: /^[A-Za-z0-9._-]+$/,
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function main() {
  if (!command || !COMMANDS.has(command))
    fail(`Orden desconocida. Una de: ${[...COMMANDS].join(", ")}`)
  if (!slug || !SAFE.slug.test(slug))
    fail("Falta la dirección de la clínica (su slug, en minúsculas y guiones)")
  const as = flag("--como")?.trim().toLowerCase()
  if (!as || !SAFE.email.test(as))
    fail("--como va con el correo de quien carga, del personal de odentIA")
  const sentAt = flag("--enviado-el")
  if (command === "informe-registrar" && (!sentAt || !SAFE.date.test(sentAt)))
    fail("--enviado-el va con la fecha en que salió (AAAA-MM-DD)")
  if (command === "informe-salio" && (!file || !SAFE.number.test(file)))
    fail("informe-salio va con el número del informe")
  const host = flag("--host") ?? "vps"
  const container = flag("--contenedor") ?? "openship-odentia-api"
  if (!SAFE.name.test(host) || !SAFE.name.test(container))
    fail("--host y --contenedor van sin espacios ni signos")

  const local = WITH_FILE.has(command) ? resolve(cwd, file ?? fail("Falta el archivo")) : null
  if (local && !existsSync(local)) fail(`No existe ${local}`)

  const cli = [
    "node_modules/.bin/tsx",
    "src/cli/carga.ts",
    command,
    slug,
    ...(local ? ["-"] : command === "informe-salio" ? [file as string] : []),
    "--como",
    as,
    ...(sentAt ? ["--enviado-el", sentAt] : []),
    ...(args.includes("--con-nombres") ? ["--con-nombres"] : []),
  ]
  const result = spawnSync(
    "ssh",
    [host, `docker exec -i -w /app/apps/api ${container} ${cli.join(" ")}`],
    {
      input: local ? readFileSync(local) : "",
      stdio: ["pipe", "inherit", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (result.error) fail(`No se pudo correr ssh: ${result.error.message}`)
  process.exit(result.status ?? 1)
}

main()
