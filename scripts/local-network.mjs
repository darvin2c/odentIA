import { lookup } from "node:dns"
import { Agent, setGlobalDispatcher } from "undici"

// Solo los procesos iniciados con este preload reciben resolución local.
setGlobalDispatcher(new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (hostname.endsWith(".localhost")) {
        if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
        else callback(null, "127.0.0.1", 4)
        return
      }
      lookup(hostname, options, callback)
    },
  },
}))

// La URL file funciona también con unidades Windows y espacios escapados.
const preload = `--import=${import.meta.url}`
const inherited = process.env.NODE_OPTIONS ?? ""
if (!inherited.split(/\s+/).includes(preload)) {
  process.env.NODE_OPTIONS = [inherited, preload].filter(Boolean).join(" ")
}
