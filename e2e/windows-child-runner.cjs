const { spawn } = require("node:child_process")
const { appendFileSync, closeSync, openSync } = require("node:fs")

const encoded = process.argv[2]
let payload
let logFd
let logClosed = false

function report(message) {
  const line = `${message}\n`
  if (payload?.logPath) appendFileSync(payload.logPath, line)
  else console.error(message)
}

function closeLog() {
  if (logFd !== undefined && !logClosed) {
    logClosed = true
    closeSync(logFd)
  }
}

if (!encoded) {
  report("Falta la definición del proceso hijo")
  process.exitCode = 1
} else {
  let child
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
    logFd = openSync(payload.logPath, "a")
    child = spawn(payload.cmd, payload.args, {
      cwd: payload.cwd,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    report(error instanceof Error ? error.message : String(error))
    closeLog()
    process.exitCode = 1
  }
  if (child) {
    child.once("error", (error) => {
      report(error.message)
      process.exitCode = 1
    })
    child.once("exit", (code, signal) => {
      closeLog()
      process.exitCode = signal ? 1 : (code ?? 1)
    })
  }
}
