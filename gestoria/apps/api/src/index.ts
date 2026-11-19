import { createAppDb, createOwnerDb } from "@gestoria/db"
import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { reviewAccountCopies } from "./cuenta.js"
import { readEnv } from "./env.js"
import { defaultLinkAdapters } from "./link-de-pago.js"
import { readSecretsKey } from "./secretos.js"

const env = readEnv()
const ownerDb = createOwnerDb(env.GESTORIA_DATABASE_URL)
const appDb = createAppDb(env.GESTORIA_APP_DATABASE_URL)
const account = { url: env.GESTORIA_ACCOUNT_URL, eventsSecret: env.GESTORIA_ACCOUNT_EVENTS_SECRET }

// El link de pago necesita la llave de las credenciales y la dirección pública del servidor.
const secretsKey = env.GESTORIA_API_URL ? readSecretsKey(env.GESTORIA_SECRETS_KEY) : null
if (!secretsKey)
  console.warn(
    "gestoria-api: sin GESTORIA_SECRETS_KEY y GESTORIA_API_URL no se puede conectar un link de pago.",
  )
const link = {
  adapters: defaultLinkAdapters(),
  secretsKey,
  apiURL: env.GESTORIA_API_URL ?? env.GESTORIA_WEB_URL,
}
const app = createApp({ appDb, ownerDb, account, webURL: env.GESTORIA_WEB_URL, link })
serve({ fetch: app.fetch, port: env.GESTORIA_PORT }, (info) => {
  console.log(`gestoria-api: escuchando en el puerto ${info.port}`)
})

// La revisión diaria de la copia de las cuentas: cada hora toma las que no se revisaron en el
// día. Sin el secreto de los avisos no hay revisión (lo dice al arrancar).
if (!account.eventsSecret)
  console.warn(
    "gestoria-api: sin GESTORIA_ACCOUNT_EVENTS_SECRET no llegan los avisos de la cuenta ni corre la revisión diaria.",
  )
const HOUR = 3_600_000
async function review() {
  try {
    const run = await reviewAccountCopies(ownerDb, account)
    if (run.reviewed > 0 || run.failed)
      console.log(
        `gestoria-api: revisión de cuentas, ${run.reviewed} revisada(s)${run.failed ? "; la cuenta no respondió" : ""}`,
      )
  } catch (error) {
    console.error("gestoria-api: la revisión de cuentas falló", error)
  }
}
setTimeout(() => void review(), 60_000).unref()
setInterval(() => void review(), HOUR).unref()
