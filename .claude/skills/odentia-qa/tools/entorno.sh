#!/usr/bin/env bash
# La demo local de la QA en un solo comando: base, almacenamiento y correo propios en contenedores,
# la semilla de demostración, un proxy propio y las apps en puertos fijos. Cada ronda toma un lugar
# libre (sus puertos y sus contenedores qa<N>-*), así que no choca con otras sesiones ni con el
# `pnpm dev` de siempre, y no cambia el `.env` del repositorio.
#
# Uso (Git Bash, desde la raíz del repositorio):
#   bash .claude/skills/odentia-qa/tools/entorno.sh up <ronda> [odentia] [web]   levanta y se queda corriendo: va en segundo plano
#   bash .claude/skills/odentia-qa/tools/entorno.sh esperar <ronda>              espera a que esté listo y dice las direcciones
#   bash .claude/skills/odentia-qa/tools/entorno.sh down <ronda>                 apaga todo y borra sus contenedores
#
# <ronda> es la carpeta de la ronda en ~/odentia-qa (p. ej. 2026-11-25-mesa-agenda). Lo del entorno
# va en su subcarpeta entorno/: el .env (con las claves, por eso fuera del repositorio), los registros
# y las direcciones. Sin sistemas levanta odentia: la API, el panel y la app de la clínica dental.
# `web` suma la web. latidIA y vistIA no se levantan aquí: se revisan por el código común.
# El .env sale de infra/dev/.env de esta copia del repositorio (o de QA_ENV_BASE); los envíos quedan
# siempre simulados (CHANNEL_SENDER_MODE=mock).
set -uo pipefail

TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$TOOLS/../../../.." && pwd)
QA=${QA_DIR:-$HOME/odentia-qa}
P=${QA_PODMAN:-podman}
cmd=${1:-}
ronda=${2:-}
if [ -z "$cmd" ] || [ -z "$ronda" ]; then
  sed -n '7,10p' "${BASH_SOURCE[0]}" | sed 's/^# //'
  exit 2
fi
R="$QA/$ronda/entorno"
LUGARES="$QA/entornos"

falla() { echo "entorno: $*" >&2; [ -d "$R" ] && echo "$*" > "$R/fallo"; exit 1; }

# Los puertos de un lugar (10 a 99).
puertos() {
  local b=$1
  PROXY=$((1400 + b)) API=$((3800 + b)) WEB=$((5700 + b)) PANEL=$((5800 + b)) DENTAL=$((5900 + b))
  PG=$((55800 + b)) S3=$((59800 + b)) S3C=$((56800 + b)) SMTP=$((51800 + b)) CORREO=$((58800 + b))
  TODOS="$PROXY $API $WEB $PANEL $DENTAL $PG $S3 $S3C $SMTP $CORREO"
}

escuchando() { netstat -ano 2>/dev/null | tr -d '\r' | grep -E "LISTENING" ; }

# Los PID de Windows que escuchan en un puerto.
pids_en() { escuchando | grep -E "[:.]$1[[:space:]]" | awk '{print $NF}' | sort -u; }

# Toma el primer lugar libre: ningún puerto en uso ni reservado por Windows, y sin contenedores.
elegir_lugar() {
  mkdir -p "$LUGARES"
  local en_uso excluidos inicio b ocupado p
  en_uso=$(escuchando)
  excluidos=$(netsh int ipv4 show excludedportrange protocol=tcp 2>/dev/null | tr -d '\r' | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $1, $2}')
  inicio=$(( $(printf '%s' "$ronda" | cksum | cut -d' ' -f1) % 90 ))
  for k in $(seq 0 89); do
    b=$(( (inicio + k) % 90 + 10 ))
    puertos "$b"
    ocupado=0
    for p in $TODOS; do
      if echo "$en_uso" | grep -qE "[:.]$p[[:space:]]"; then ocupado=1; break; fi
      if echo "$excluidos" | awk -v p="$p" '$1 <= p && p <= $2 {f=1} END {exit !f}'; then ocupado=1; break; fi
    done
    [ $ocupado = 1 ] && continue
    $P container exists "qa$b-pg" 2>/dev/null && continue
    mkdir "$LUGARES/$b" 2>/dev/null || continue
    echo "$ronda" > "$LUGARES/$b/ronda"
    LUGAR=$b
    return 0
  done
  return 1
}

# Cambia o agrega una variable en el .env de la ronda, sin interpretar el valor.
pon() {
  awk -v k="$1" -v v="$2" 'BEGIN {h = 0} index($0, k "=") == 1 {print k "=" v; h = 1; next} {print} END {if (!h) print k "=" v}' "$E" > "$E.tmp" && mv "$E.tmp" "$E"
}
quita() { awk -v k="$1" 'index($0, k "=") != 1' "$E" > "$E.tmp" && mv "$E.tmp" "$E"; }
valor() { awk -v k="$1" 'index($0, k "=") == 1 {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' "$E"; }

# Exporta el .env sin pasarlo por el shell: un valor con espacios o «<» no se ejecuta.
cargar_env() {
  local linea k v
  while IFS= read -r linea || [ -n "$linea" ]; do
    [[ $linea =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    k=${linea%%=*}
    v=${linea#*=}
    if [[ $v =~ ^\"(.*)\"$ ]] || [[ $v =~ ^\'(.*)\'$ ]]; then v=${BASH_REMATCH[1]}; fi
    export "$k=$v"
  done < "$1"
}

codigo() { curl -sk -o /dev/null -w "%{http_code}" --max-time 20 --resolve "$1:$PROXY:127.0.0.1" "https://$1:$PROXY${2:-/}" 2>/dev/null; }

up() {
  local sistemas="${*:-odentia}" s
  for s in $sistemas; do
    case $s in odentia | web) ;; *) falla "no sé levantar «$s»: solo odentia y web" ;; esac
  done
  mkdir -p "$R"
  rm -f "$R/listo" "$R/fallo"
  if [ -f "$R/lugar" ] && [ -d "$LUGARES/$(cat "$R/lugar")" ]; then
    falla "la ronda ya tiene un entorno en el lugar $(cat "$R/lugar"): primero down"
  fi

  # Lo que hace falta antes de empezar.
  $P info >/dev/null 2>&1 || falla "Podman no responde (podman machine start)"
  [ -d "$REPO/node_modules" ] || falla "faltan las dependencias: pnpm install en la raíz"
  [ -f "$HOME/.portless/ca.pem" ] || falla "falta la CA de portless en ~/.portless: corre una vez pnpm dev"
  local libres
  libres=$(powershell.exe -NoProfile -Command '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)' 2>/dev/null | tr -d '\r')
  echo "memoria libre: ${libres:-?} GB"
  if ! $P image exists localhost/dentalagent-postgres:18.6; then
    echo "construyendo la imagen de la base…"
    $P build -t dentalagent-postgres:18.6 "$REPO/infra/dev/postgres" > "$R/imagen.log" 2>&1 || falla "no se pudo construir la imagen de la base ($R/imagen.log)"
  fi

  elegir_lugar || falla "no hay un lugar libre"
  local b=$LUGAR
  puertos "$b"
  echo "$b" > "$R/lugar"
  cat /proc/$$/winpid > "$R/pid" 2>/dev/null || echo $$ > "$R/pid"
  echo "lugar $b: proxy $PROXY, API $API, panel $PANEL, clínica $DENTAL, web $WEB, base $PG"

  # El .env de la ronda.
  E="$R/.env"
  local base=${QA_ENV_BASE:-$REPO/infra/dev/.env}
  if [ -f "$base" ]; then cp "$base" "$E"; else
    cp "$REPO/infra/dev/.env.example" "$E"
    echo "aviso: sin infra/dev/.env; uso .env.example (modelo de prueba, sin claves)"
  fi
  sed -i 's/\r$//' "$E"
  local H=":$PROXY" pgdb pgu pgp pgapp s3k s3s b1 b2
  pgdb=$(valor POSTGRES_DB); pgdb=${pgdb:-dentalagent}
  pgu=$(valor POSTGRES_USER); pgu=${pgu:-dentalagent}
  pgp=$(valor POSTGRES_PASSWORD); pgp=${pgp:-dentalagent}
  pgapp=$(valor POSTGRES_APP_PASSWORD); pgapp=${pgapp:-dentalagent_app}
  s3k=$(valor S3_ACCESS_KEY); s3k=${s3k:-minioadmin}
  s3s=$(valor S3_SECRET_KEY); s3s=${s3s:-minioadmin}
  b1=$(valor S3_BUCKET); b1=${b1:-dentalagent-dev}
  b2=$(valor S3_ATTACHMENTS_BUCKET); b2=${b2:-dentalagent-attachments}
  pon POSTGRES_PORT "$PG"
  pon DATABASE_URL "postgres://$pgu:$pgp@127.0.0.1:$PG/$pgdb"
  pon APP_DATABASE_URL "postgres://dentalagent_app:$pgapp@127.0.0.1:$PG/$pgdb"
  pon BETTER_AUTH_URL "https://api.odentia.localhost$H"
  pon WEB_URL "https://app.odentia.localhost$H"
  pon ADMIN_URL "https://admin.odentia.localhost$H"
  pon COOKIE_DOMAIN "odentia.localhost"
  # Las clínicas de la demo van con su nombre además del comodín, como en las rondas anteriores.
  local origenes="https://odentia.localhost$H,https://app.odentia.localhost$H,https://api.odentia.localhost$H,https://admin.odentia.localhost$H,https://www.odentia.localhost$H,https://*.odentia.localhost$H" o
  for o in dental-smile clinica-norte seed-dental-sonrisa-lince bocas-felices-demo orto-lima-demo; do origenes="$origenes,https://$o.odentia.localhost$H"; done
  pon TRUSTED_ORIGINS "$origenes"
  pon SMTP_HOST 127.0.0.1
  pon SMTP_PORT "$SMTP"
  pon MAILPIT_SMTP_PORT "$SMTP"
  pon MAILPIT_HTTP_PORT "$CORREO"
  pon S3_API_PORT "$S3"
  pon S3_CONSOLE_PORT "$S3C"
  pon S3_ENDPOINT "http://127.0.0.1:$S3"
  pon S3_PUBLIC_URL "http://127.0.0.1:$S3/$b1"
  pon VITE_API_URL "https://api.odentia.localhost$H"
  pon VITE_BASE_DOMAIN "odentia.localhost"
  pon VITE_BASE_PORT "$PROXY"
  pon CHANNEL_SENDER_MODE mock
  for o in MEDICAL_DOMAIN OPTICAL_DOMAIN VITE_DENTAL_DOMAIN VITE_MEDICAL_DOMAIN VITE_OPTICAL_DOMAIN PORTLESS_PORT PORTLESS_STATE_DIR; do quita "$o"; done
  local llm
  llm=$(valor LLM_MODEL)
  if [ "$llm" = fake ] || [ -z "$(valor LLM_OPENAI_API_KEY)" ]; then echo "modelo: de prueba (la Ayuda, Sofi, Clío y Argos no cuentan)"; else echo "modelo: real"; fi

  # Base, almacenamiento y correo.
  echo "contenedores…"
  $P network create "qa$b-net" >/dev/null 2>&1
  $P run -d --name "qa$b-pg" -p "127.0.0.1:$PG:5432" \
    -e POSTGRES_DB="$pgdb" -e POSTGRES_USER="$pgu" -e POSTGRES_PASSWORD="$pgp" -e POSTGRES_APP_PASSWORD="$pgapp" \
    -v "qa$b-pgdata:/var/lib/postgresql" \
    localhost/dentalagent-postgres:18.6 postgres -c shared_preload_libraries=pg_cron -c cron.database_name="$pgdb" >/dev/null \
    || falla "no arrancó la base"
  $P run -d --name "qa$b-s3" --network "qa$b-net" --network-alias storage -p "127.0.0.1:$S3:9000" -p "127.0.0.1:$S3C:9001" \
    -e RUSTFS_ACCESS_KEY="$s3k" -e RUSTFS_SECRET_KEY="$s3s" -v "qa$b-s3data:/data" docker.io/rustfs/rustfs:1.0.1 >/dev/null \
    || falla "no arrancó el almacenamiento"
  $P run -d --name "qa$b-mail" -p "127.0.0.1:$SMTP:1025" -p "127.0.0.1:$CORREO:8025" docker.io/axllent/mailpit:latest >/dev/null \
    || falla "no arrancó el correo"
  local i ok=0
  for i in $(seq 1 90); do $P exec "qa$b-pg" pg_isready -h 127.0.0.1 -U "$pgu" -d "$pgdb" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] || falla "la base no respondió en 90 s"
  ok=0
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$S3/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] || falla "el almacenamiento no respondió en 60 s"
  MSYS_NO_PATHCONV=1 $P run --rm --network "qa$b-net" -e AWS_ACCESS_KEY_ID="$s3k" -e AWS_SECRET_ACCESS_KEY="$s3s" \
    -e AWS_DEFAULT_REGION=us-east-1 -e AWS_ENDPOINT_URL=http://storage:9000 -e S3_BUCKET="$b1" -e S3_ATTACHMENTS_BUCKET="$b2" \
    -v "$(cygpath -w "$REPO/infra/dev/storage-init.sh"):/storage-init.sh:ro" --entrypoint /bin/sh \
    docker.io/amazon/aws-cli:2.37.9 /storage-init.sh > "$R/almacenamiento.log" 2>&1 || falla "no se crearon los buckets ($R/almacenamiento.log)"

  # La semilla de demostración.
  echo "semilla…"
  cargar_env "$E"
  (
    cd "$REPO" || exit 1
    pnpm --filter @odentia/db migrate || { sleep 10; pnpm --filter @odentia/db migrate; } || exit 1
    pnpm --filter @odentia/db seed:diagnoses && pnpm --filter @odentia/db seed:procedures && pnpm --filter @odentia/services seed:dev
  ) > "$R/semilla.log" 2>&1 || falla "la semilla falló ($R/semilla.log)"

  # El proxy propio, con la CA de siempre para que el navegador confíe.
  mkdir -p "$R/portless"
  cp "$HOME/.portless/ca.pem" "$HOME/.portless/ca-key.pem" "$R/portless/"
  for o in ca.trusted ca-openssl.cnf; do [ -f "$HOME/.portless/$o" ] && cp "$HOME/.portless/$o" "$R/portless/"; done
  {
    echo "["
    echo " { \"hostname\": \"api.odentia.localhost\", \"port\": $API, \"pid\": 0 },"
    echo " { \"hostname\": \"app.odentia.localhost\", \"port\": $PANEL, \"pid\": 0 },"
    echo " { \"hostname\": \"www.odentia.localhost\", \"port\": $WEB, \"pid\": 0 },"
    echo " { \"hostname\": \"odentia.localhost\", \"port\": $DENTAL, \"pid\": 0 }"
    echo "]"
  } > "$R/portless/routes.json"
  (
    PORTLESS_STATE_DIR="$(cygpath -w "$R/portless")" PORTLESS_PORT=$PROXY PORTLESS_HTTP_REDIRECT=0 PORTLESS_SYNC_HOSTS=0 PORTLESS_WILDCARD=1 \
      exec node "$REPO/node_modules/portless/dist/cli.js" proxy start --foreground
  ) > "$R/proxy.log" 2>&1 &

  # Lo que vite regenera al arrancar: down deja como estaba lo que estaba limpio.
  git -C "$REPO" ls-files -- '*routeTree.gen.ts' | while read -r f; do
    [ -z "$(git -C "$REPO" status --porcelain -- "$f")" ] && echo "$f"
  done > "$R/arboles-limpios"

  # Las apps.
  echo "apps…"
  export NODE_OPTIONS="--use-system-ca --require $(cygpath -w "$TOOLS/localhost-dns.cjs")"
  (cd "$REPO/apps/api" && PORT=$API exec npx tsx watch src/index.ts) > "$R/api.log" 2>&1 &
  if [[ " $sistemas " == *" odentia "* ]]; then
    (cd "$REPO/apps/panel" && PORT=$PANEL exec npx vite dev --port "$PANEL" --strictPort) > "$R/panel.log" 2>&1 &
    (cd "$REPO/apps/dental-clinic" && PORT=$DENTAL exec npx vite dev --port "$DENTAL" --strictPort) > "$R/clinica.log" 2>&1 &
  fi
  if [[ " $sistemas " == *" web "* ]]; then
    (cd "$REPO/apps/web" && PORT=$WEB exec npx astro dev --port "$WEB") > "$R/web.log" 2>&1 &
  fi

  # Listo cuando cada parte responde por el proxy (la primera carga de vite tarda).
  local pruebas="api.odentia.localhost/health"
  [[ " $sistemas " == *" odentia "* ]] && pruebas="$pruebas app.odentia.localhost/ dental-smile.odentia.localhost/"
  [[ " $sistemas " == *" web "* ]] && pruebas="$pruebas www.odentia.localhost/"
  local t pendiente c host ruta
  for t in $(seq 1 100); do
    pendiente=""
    for t2 in $pruebas; do
      host=${t2%%/*}; ruta=/${t2#*/}
      c=$(codigo "$host" "$ruta")
      case $c in 2* | 3*) ;; *) pendiente="$pendiente $host($c)" ;; esac
    done
    [ -z "$pendiente" ] && break
    sleep 3
  done
  if [ -n "$pendiente" ]; then
    falla "no respondieron:$pendiente (registros en $R)"
  fi
  {
    echo "lugar: $b"
    echo "API: https://api.odentia.localhost$H"
    [[ " $sistemas " == *" odentia "* ]] && echo "panel (entrar): https://app.odentia.localhost$H" && echo "Dental Smile: https://dental-smile.odentia.localhost$H"
    [[ " $sistemas " == *" web "* ]] && echo "web: https://www.odentia.localhost$H"
    echo "correos: http://127.0.0.1:$CORREO"
    grep -m1 -o "credenciales[^\"]*" "$R/semilla.log" || echo "cuentas: docs/development.md (contraseña Demo1234)"
    echo "apagar: bash .claude/skills/odentia-qa/tools/entorno.sh down $ronda"
  } > "$R/listo"
  echo "LISTO"
  cat "$R/listo"
  wait
}

esperar() {
  local i
  for i in $(seq 1 300); do
    if [ -f "$R/listo" ]; then cat "$R/listo"; return 0; fi
    if [ -f "$R/fallo" ]; then echo "falló: $(cat "$R/fallo")"; return 1; fi
    sleep 3
  done
  echo "sigue sin estar listo tras 15 min: mira los registros en $R"
  return 1
}

down() {
  [ -f "$R/lugar" ] || { echo "la ronda no tiene entorno"; return 0; }
  local b p pid
  b=$(cat "$R/lugar")
  puertos "$b"
  if [ -f "$R/pid" ]; then taskkill //T //F //PID "$(cat "$R/pid")" >/dev/null 2>&1; fi
  for p in $PROXY $API $WEB $PANEL $DENTAL; do
    for pid in $(pids_en "$p"); do [ "$pid" != 0 ] && taskkill //T //F //PID "$pid" >/dev/null 2>&1; done
  done
  $P rm -f -v "qa$b-pg" "qa$b-s3" "qa$b-mail" >/dev/null 2>&1
  $P volume rm "qa$b-pgdata" "qa$b-s3data" >/dev/null 2>&1
  $P network rm "qa$b-net" >/dev/null 2>&1
  if [ -f "$R/arboles-limpios" ]; then
    # Vite los vuelve a escribir aunque queden iguales: git los ve cambiados igual.
    while read -r f; do [ -n "$(git -C "$REPO" status --porcelain -- "$f")" ] && git -C "$REPO" checkout -- "$f"; done < "$R/arboles-limpios"
  fi
  rm -rf "$LUGARES/$b"
  rm -f "$R/lugar" "$R/pid" "$R/listo" "$R/fallo"
  local quedan=""
  for p in $TODOS; do [ -n "$(pids_en "$p")" ] && quedan="$quedan $p"; done
  local cont
  cont=$($P ps -a --format '{{.Names}}' 2>/dev/null | grep -c "^qa$b-")
  echo "apagado el lugar $b: puertos que siguen en uso:${quedan:- ninguno}; contenedores que quedan: $cont"
}

case $cmd in
  up) shift 2; up "$@" ;;
  esperar) esperar ;;
  down) down ;;
  *) sed -n '7,10p' "${BASH_SOURCE[0]}" | sed 's/^# //'; exit 2 ;;
esac
