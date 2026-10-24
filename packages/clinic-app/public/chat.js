/*
 * Chat de la clínica para su sitio (fase 6 del pulido de la Bandeja). Se pega
 * una sola línea, que no cambia aunque la clínica cambie el color o el saludo:
 *
 *   <script src="https://<clínica>.<dominio>/chat.js" async></script>
 *
 * La clínica sale de la dirección del script; la API vive en `api.<dominio>`.
 * Al cargar pregunta si el chat responde en este sitio: el primero se permite
 * solo y los demás esperan el sí de la clínica, mientras tanto dice «No
 * disponible». La conversación vive en la ventana del chat (`/embed`), que el
 * navegador solo deja mostrar en los sitios permitidos.
 */
;(() => {
  if (window.__odentiaChat) return
  window.__odentiaChat = true
  var script = document.currentScript
  if (!script?.src) return
  var src = new URL(script.src)
  var dot = src.hostname.indexOf(".")
  if (dot < 0) return
  var slug = src.hostname.slice(0, dot)
  var port = src.port ? `:${src.port}` : ""
  var api = `${src.protocol}//api.${src.hostname.slice(dot + 1)}${port}`
  var site = window.location.origin
  var Z = 2147483000

  function el(tag, style, attrs) {
    var node = document.createElement(tag)
    Object.assign(node.style, style || {})
    for (var key in attrs || {}) node.setAttribute(key, attrs[key])
    return node
  }

  var ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>'
  var CLOSE =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'

  function start(info) {
    var color = /^#[0-9a-fA-F]{6}$/.test(info.color || "") ? info.color : "#0f766e"
    var name = info.clinicName || "la clínica"
    var small = window.matchMedia("(max-width: 480px)")
    var button = el(
      "button",
      {
        position: "fixed",
        right: "20px",
        bottom: "20px",
        width: "56px",
        height: "56px",
        borderRadius: "50%",
        border: "0",
        background: color,
        color: "#fff",
        boxShadow: "0 6px 20px rgba(0,0,0,.2)",
        cursor: "pointer",
        zIndex: String(Z),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      { type: "button", "aria-label": `Abrir el chat de ${name}`, "aria-expanded": "false" },
    )
    button.innerHTML = ICON
    var panel = el("div", {
      position: "fixed",
      right: "20px",
      bottom: "88px",
      width: "380px",
      height: "600px",
      maxWidth: "calc(100vw - 32px)",
      maxHeight: "calc(100vh - 112px)",
      borderRadius: "16px",
      overflow: "hidden",
      boxShadow: "0 12px 40px rgba(0,0,0,.25)",
      background: "#fff",
      zIndex: String(Z),
      display: "none",
    })
    var frame = null
    var open = false

    function layout() {
      // En el celular la ventana ocupa la pantalla entera.
      var full = small.matches
      Object.assign(
        panel.style,
        full
          ? {
              right: "0",
              bottom: "0",
              width: "100vw",
              height: "100dvh",
              maxWidth: "none",
              maxHeight: "none",
              borderRadius: "0",
            }
          : {
              right: "20px",
              bottom: "88px",
              width: "380px",
              height: "600px",
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "calc(100vh - 112px)",
              borderRadius: "16px",
            },
      )
      button.style.display = full && open ? "none" : "flex"
    }

    function show(next) {
      open = next
      if (open && !frame) {
        if (info.available) {
          frame = el(
            "iframe",
            { width: "100%", height: "100%", border: "0", display: "block" },
            {
              src: `${src.origin}/embed?site=${encodeURIComponent(site)}&ticket=${encodeURIComponent(info.ticket || "")}`,
              title: `Chat de ${name}`,
              allow: "clipboard-write",
            },
          )
        } else {
          // Sin permiso en este sitio, desactivado o sin chat: se dice, sin abrir nada.
          frame = el("div", {
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "24px",
            font: "16px system-ui, sans-serif",
            color: "#334155",
            textAlign: "center",
          })
          frame.innerHTML =
            "<strong>No disponible</strong><span style='font-size:14px'>El chat de " +
            name.replace(/[<>&]/g, "") +
            " no está disponible aquí.</span>"
        }
        panel.appendChild(frame)
      }
      panel.style.display = open ? "block" : "none"
      button.innerHTML = open ? CLOSE : ICON
      button.setAttribute("aria-expanded", open ? "true" : "false")
      button.setAttribute("aria-label", `${open ? "Cerrar" : "Abrir"} el chat de ${name}`)
      layout()
      if (!open) button.focus()
    }

    button.addEventListener("click", () => show(!open))
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && open) show(false)
    })
    // La ventana del chat pide cerrarse (su botón o Esc dentro de ella).
    window.addEventListener("message", (event) => {
      if (event.origin !== src.origin || !event.data || event.data.type !== "odentia-chat:close")
        return
      show(false)
    })
    small.addEventListener("change", layout)
    document.body.appendChild(panel)
    document.body.appendChild(button)
  }

  function boot() {
    fetch(`${api}/api/webchat/${encodeURIComponent(slug)}/site`, {
      method: "POST",
      // Sin cuerpo ni credenciales: el navegador no pregunta antes (sin preflight)
      // y el sitio lo dice él mismo, en la cabecera Origin.
      credentials: "omit",
    })
      .then((response) => response.json())
      .then((body) => start(body?.data || {}))
      .catch(() => start({ available: false }))
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
  else boot()
})()
