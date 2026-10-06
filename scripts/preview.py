#!/usr/bin/env python3
"""Gestor del VPS: recibe JSON por stdin, nunca comandos remotos ni secretos de CI."""

import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def api(path, method="GET", body=None):
    command = [str(Path.home() / ".openship/bin/openship"), "--json", "api", path]
    if method != "GET":
        command += ["--method", method]
    if body is not None:
        command += ["--data", json.dumps(body)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        # La salida de una mutación de variables puede contener secretos.
        raise RuntimeError(f"OpenShip rechazó {method} {path} (código {result.returncode})")
    response = json.loads(result.stdout)
    if isinstance(response, dict) and response.get("success") is False:
        raise RuntimeError(f"OpenShip rechazó {method} {path}")
    return response.get("data", response) if isinstance(response, dict) else response


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {"action", "pr", "branch", "sha"}:
        raise ValueError("Solicitud de preview inválida")
    if request["action"] not in {"deploy", "close"}:
        raise ValueError("Acción de preview inválida")
    if type(request["pr"]) is not int or not 1 <= request["pr"] <= 2147483647:
        raise ValueError("Número de PR inválido")
    branch = request["branch"]
    if not isinstance(branch, str) or not branch or len(branch) > 200 or branch == "main":
        raise ValueError("El preview requiere una rama distinta de main")
    if not isinstance(request["sha"], str) or not re.fullmatch(r"[a-f0-9]{40}", request["sha"]):
        raise ValueError("El preview requiere el SHA completo")


def configure_vars(project_id, root):
    existing = api(f"/projects/{project_id}/env?environment=preview")
    keys = {row["key"] for row in existing}
    secret_keys = {
        "POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "DATABASE_URL", "APP_DATABASE_URL",
        "BETTER_AUTH_SECRET", "SECRETS_KEY", "S3_SECRET_KEY",
    }
    if keys & secret_keys and not secret_keys <= keys:
        raise RuntimeError("El preview tiene secretos incompletos; requiere intervención")
    variables = {
        "POSTGRES_DB": "dentalagent", "POSTGRES_USER": "dentalagent",
        "BETTER_AUTH_URL": f"https://api.{root}", "WEB_URL": f"https://app.{root}",
        "COOKIE_DOMAIN": root,
        "TRUSTED_ORIGINS": ",".join(f"https://{name}.{root}" for name in ["app", "api", "dental-smile", "clinica-norte"]),
        "GOOGLE_CLIENT_ID": "", "GOOGLE_CLIENT_SECRET": "",
        "SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_USER": "", "SMTP_PASS": "",
        "SMTP_FROM": "odentIA preview <no-reply@example.com>",
        "S3_ENDPOINT": f"https://storage.{root}", "S3_REGION": "us-east-1",
        "S3_ACCESS_KEY": "preview", "S3_BUCKET": "avatars", "S3_ATTACHMENTS_BUCKET": "attachments",
        "S3_PUBLIC_URL": f"https://storage.{root}/avatars",
        "CHANNEL_VALIDATE_EXTERNAL": "false", "CHANNEL_SENDER_MODE": "mock", "LLM_MODEL": "fake",
        "VITE_API_URL": f"https://api.{root}", "VITE_BASE_DOMAIN": root, "PORT": "3001",
    }
    if not keys & secret_keys:
        owner, app = secrets.token_hex(24), secrets.token_hex(24)
        variables.update({
            "POSTGRES_PASSWORD": owner, "POSTGRES_APP_PASSWORD": app,
            "DATABASE_URL": f"postgres://dentalagent:{owner}@postgres:5432/dentalagent",
            "APP_DATABASE_URL": f"postgres://dentalagent_app:{app}@postgres:5432/dentalagent",
            "BETTER_AUTH_SECRET": secrets.token_hex(32), "SECRETS_KEY": secrets.token_hex(32),
            "S3_SECRET_KEY": secrets.token_hex(32),
        })
    api(f"/projects/{project_id}/env", "PATCH", {
        "environment": "preview", "deletes": [],
        "upserts": [{"key": key, "value": value, "isSecret": key in secret_keys} for key, value in variables.items()],
    })
    return {key: value for key, value in variables.items() if key not in secret_keys}


def configure_services(project_id, parent, request, root, variables):
    prepared = api("/deployments/prepare", "POST", {
        "source": "github", "owner": parent["gitOwner"], "repo": parent["gitRepo"],
        "branch": request["branch"], "composePath": "compose.preview.yaml", "env": variables,
    })
    config = prepared.get("config", prepared)
    services = config["services"]
    routes = {
        "api": (3001, ["api"]), "panel": (3000, ["app"]),
        "platform": (3000, ["dental-smile", "clinica-norte"]), "minio": (9000, ["storage"]),
    }
    for service in services:
        route = routes.get(service["name"])
        service["exposed"] = bool(route)
        if route:
            port, names = route
            endpoints = [{"port": port, "domainType": "custom", "customDomain": f"{name}.{root}"} for name in names]
            service.update({"exposedPort": str(port), "domainType": "custom", "customDomain": endpoints[0]["customDomain"], "publicEndpoints": endpoints})
        else:
            service.update({"domainType": "custom", "publicEndpoints": []})
    api(f"/projects/{project_id}/services/sync", "POST", {"services": services})


def wait_deployment(deployment_id):
    deadline = time.monotonic() + 1800
    previous = None
    while time.monotonic() < deadline:
        deployment = api(f"/deployments/{deployment_id}")
        status = deployment["status"]
        if status != previous:
            print(f"Estado de preview: {status}", flush=True)
            previous = status
        if status in {"ready", "no_changes"}:
            return
        if status in {"failed", "cancelled", "partial_failure", "action_required"}:
            raise RuntimeError(f"Despliegue {deployment_id}: {status}; consultar logs en OpenShip")
        time.sleep(10)
    raise RuntimeError(f"El despliegue {deployment_id} no alcanzó READY")


def check_http(root):
    for name, path in [("api", "/health"), ("app", "/"), ("dental-smile", "/"), ("clinica-norte", "/"), ("storage", "/minio/health/ready")]:
        url = f"https://{name}.{root}{path}"
        with urllib.request.urlopen(url, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"El preview no sirve {url}")
        print(f"HTTP verificado: {url}", flush=True)


def main():
    if os.environ.get("SSH_ORIGINAL_COMMAND"):
        raise ValueError("Esta clave no permite ejecutar comandos")
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("Solicitud de preview demasiado grande")
    request = json.loads(raw)
    validate_request(request)
    settings = json.loads((Path.home() / ".local/share/odentia-preview/config.json").read_text())
    parent_id = settings["parentId"]
    base_domain = settings["baseDomain"]
    if not re.fullmatch(r"[a-z0-9.-]+", base_domain):
        raise ValueError("Dominio de preview inválido")
    parent = api(f"/projects/{parent_id}")
    if parent["environmentType"] != "production" or (parent["gitOwner"], parent["gitRepo"]) != ("darvin2c", "odentIA"):
        raise RuntimeError("El proyecto base no corresponde a odentIA")
    slug = f"pr-{request['pr']}"
    environments = api(f"/projects/{parent_id}/environments")
    preview = next((item for item in environments if item["slug"] == slug), None)
    if preview and (preview["id"] == parent_id or preview["type"] != "preview"):
        raise RuntimeError("El destino no es un preview; operación rechazada")
    if request["action"] == "close":
        if preview:
            api(f"/projects/{preview['id']}/deletion-preview")
            api(f"/projects/{preview['id']}?wipeVolumes=true", "DELETE")
        print(f"PREVIEW_RESULT={json.dumps({'state': 'closed', 'pr': request['pr']})}", flush=True)
        return
    if not preview:
        preview = api(f"/projects/{parent_id}/environments", "POST", {
            "environmentName": f"PR #{request['pr']}", "environmentSlug": slug,
            "environmentType": "preview", "sourceMode": "branch", "gitBranch": request["branch"],
        })
    project_id = preview["id"]
    project = api(f"/projects/{project_id}")
    if project["environmentType"] != "preview" or project["groupId"] != parent["groupId"] or project["environmentSlug"] != slug:
        raise RuntimeError("El proyecto no cumple el aislamiento del PR")
    api(f"/projects/{project_id}", "PATCH", {"composePath": "compose.preview.yaml", "rootDirectory": "", "gitBranch": request["branch"], "publicEndpoints": []})
    # Solo Actions dispara builds, después del gate de CI; no auto-deploy por push.
    api(f"/projects/{project_id}/auto-deploy", "POST", {"enabled": False})
    root = f"{slug}.{base_domain}"
    variables = configure_vars(project_id, root)
    configure_services(project_id, parent, request, root, variables)
    deployment = api("/deployments", "POST", {
        "projectId": project_id, "branch": request["branch"], "commitSha": request["sha"],
        "environment": "preview", "serverId": parent["serverId"], "smartRoute": True,
    })
    deployment_id = deployment["deployment_id"]
    print(f"Deployment de preview: {deployment_id}", flush=True)
    wait_deployment(deployment_id)
    check_http(root)
    print("PREVIEW_RESULT=" + json.dumps({
        "state": "ready", "pr": request["pr"], "projectId": project_id, "deploymentId": deployment_id,
        "sha": request["sha"], "panel": f"https://app.{root}",
        "platform": f"https://dental-smile.{root}", "api": f"https://api.{root}",
    }), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Preview fallido: {error}", file=sys.stderr)
        sys.exit(1)
