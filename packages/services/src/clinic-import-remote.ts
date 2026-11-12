/**
 * La skill de carga contra producción (ADR 0104): copia el archivo al servidor por SSH, lo
 * pasa al contenedor de la API, corre allí la orden (`apps/api/src/cli/carga.ts`, con la
 * base, el almacenamiento y el correo de producción) y borra las copias, salga bien o mal.
 *
 *   pnpm --filter @odentia/services import:produccion -- <orden> <slug> [<archivo>] --como <correo>
 *     [--enviado-el <AAAA-MM-DD>] [--host vps] [--contenedor openship-odentia-api]
 *
 * Órdenes: ensayo, cargar, pacientes-ensayo, pacientes-cargar, informe-ver, informe-enviar,
 * informe-registrar y registro (lo que hace cada una, en `carga.ts`). Lo que escribe en
 * producción (cargar, pacientes-cargar, informe-enviar, informe-registrar) se corre solo
 * con la aprobación del plan o del informe, como dice la skill.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const cwd = process.env.INIT_CWD ?? process.cwd()
const args = process.argv.slice(2).filter((arg) => arg !== "--")
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const positionals = args.filter(
  (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
)
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
const COMMANDS = new Set([...WITH_FILE, "registro"])

// Lo que va en la línea del servidor se comprueba antes: nada de lo escrito llega a la shell sin pasar por aquí.
const SAFE = {
  slug: /^[a-z0-9][a-z0-9-]{0,62}$/,
  email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  date: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
  name: /^[A-Za-z0-9._-]+$/,
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(program: string, programArgs: string[], inherit = false): number {
  const result = spawnSync(program, programArgs, {
    stdio: inherit ? "inherit" : ["ignore", "ignore", "inherit"],
  })
  if (result.error) fail(`No se pudo correr ${program}: ${result.error.message}`)
  return result.status ?? 1
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
  const host = flag("--host") ?? "vps"
  const container = flag("--contenedor") ?? "openship-odentia-api"
  if (!SAFE.name.test(host) || !SAFE.name.test(container))
    fail("--host y --contenedor van sin espacios ni signos")

  const local = WITH_FILE.has(command) ? resolve(cwd, file ?? fail("Falta el archivo")) : null
  if (local && !existsSync(local)) fail(`No existe ${local}`)
  const remote = `/tmp/odentia-carga-${randomUUID()}.json`

  const cli = [
    "node_modules/.bin/tsx",
    "src/cli/carga.ts",
    command,
    slug,
    ...(local ? [remote] : []),
    "--como",
    as,
    ...(sentAt ? ["--enviado-el", sentAt] : []),
  ]
  // Sin salir a mitad: `process.exit` se saltaría el borrado de las copias.
  let problem: string | null = null
  let status = 1
  try {
    if (local && run("scp", ["-q", local, `${host}:${remote}`]) !== 0)
      problem = "No se pudo copiar el archivo al servidor"
    else if (
      local &&
      run("ssh", [host, `docker cp ${remote} ${container}:${remote} && rm -f ${remote}`]) !== 0
    )
      problem = "No se pudo pasar el archivo al contenedor"
    else
      status = run(
        "ssh",
        [host, `docker exec -w /app/apps/api ${container} ${cli.join(" ")}`],
        true,
      )
  } finally {
    if (local) run("ssh", [host, `rm -f ${remote}; docker exec ${container} rm -f ${remote}`])
  }
  if (problem) fail(problem)
  process.exit(status)
}

main()
