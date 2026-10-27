#!/usr/bin/env bash
# Arranca cada servicio de la imagen de producción con su comando real y falla si
# no encuentra un módulo (p. ej. una dependencia podada que sí se usa al ejecutar).
# Sin base de datos ni claves: api, worker y migrate terminan por falta de
# configuración, y eso es lo esperado; los servidores web deben seguir vivos.
# Uso: scripts/smoke-image.sh <imagen>
set -u

imagen="${1:?Uso: smoke-image.sh <imagen>}"
fallos=0

# nombre|comando|¿debe seguir vivo? (los servidores web sí)
servicios=(
  "panel|pnpm --filter @odentia/panel start|vivo"
  "admin|pnpm --filter @odentia/admin start|vivo"
  "dental-clinic|pnpm --filter @odentia/dental-clinic start|vivo"
  "medical-clinic|pnpm --filter @odentia/medical-clinic start|vivo"
  "web|pnpm --filter @odentia/web start|vivo"
  "api|pnpm --filter @odentia/api start|-"
  "worker|pnpm --filter @odentia/worker start|-"
  "migrate|pnpm --filter @odentia/db migrate|-"
)

for entrada in "${servicios[@]}"; do
  IFS='|' read -r nombre comando espera <<<"$entrada"
  salida=$(docker run --rm --network none -e PORT=3000 "$imagen" \
    sh -c "timeout 25 $comando" 2>&1)
  codigo=$?
  if echo "$salida" | grep -qE "ERR_MODULE_NOT_FOUND|Cannot find (module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED|MODULE_NOT_FOUND|command not found|not found: "; then
    echo "::error::$nombre: falta un módulo en la imagen"
    echo "$salida" | tail -15
    fallos=$((fallos + 1))
  elif [ "$espera" = "vivo" ] && [ "$codigo" -ne 124 ]; then
    echo "::error::$nombre: debía seguir vivo y terminó con código $codigo"
    echo "$salida" | tail -15
    fallos=$((fallos + 1))
  else
    echo "ok  $nombre (código $codigo)"
  fi
done

exit "$fallos"
