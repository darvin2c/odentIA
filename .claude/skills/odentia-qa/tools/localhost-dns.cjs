// Solo para la demo local de la QA (entorno.sh): en Node, *.localhost resuelve a 127.0.0.1, como en el
// navegador. Windows no lo hace, y el servidor de las apps llama a la API por su nombre.
const dns = require("node:dns")
const orig = dns.lookup
dns.lookup = function (host, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  if (typeof host === "string" && (host === "localhost" || host.endsWith(".localhost"))) {
    const all = typeof options === "object" && options && options.all
    return process.nextTick(() =>
      all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4),
    )
  }
  return orig.call(this, host, options, callback)
}
