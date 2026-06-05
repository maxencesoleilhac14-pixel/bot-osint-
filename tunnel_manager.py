#!/usr/bin/env python3
"""
Tunnel Manager – gère cloudflared, met à jour config + BotFather automatiquement.
"""
import os, re, sys, json, time, subprocess, logging, requests, threading
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("tunnel")

BASE = Path(__file__).parent.resolve()
CONFIG_PY = BASE / "config.py"
STATUS_FILE = BASE / "tunnel_status.json"
TELEGRAM_BOT_TOKEN = "8652772452:AAEHaR639Er5VlQHEKZCQ7xYaQdWav7-cGo"
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
CLOUDFLARED = BASE / "cloudflared.exe"

def write_config(key, value):
    with open(CONFIG_PY, "r", encoding="utf-8") as f:
        lines = f.readlines()
    with open(CONFIG_PY, "w", encoding="utf-8") as f:
        found = False
        for line in lines:
            if line.startswith(key + " ="):
                f.write(f'{key} = "{value}"\n')
                found = True
            else:
                f.write(line)
        if not found:
            f.write(f'\n{key} = "{value}"\n')
    log.info(f"Config mis à jour: {key} = {value}")

def write_status(data):
    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def kill_all():
    for name in ("ssh", "cloudflared", "ngrok"):
        try: subprocess.run(["taskkill", "/F", "/IM", f"{name}.exe"], capture_output=True, timeout=5)
        except: pass
    time.sleep(2)

def get_cloudflared_url(timeout=60):
    proc = subprocess.Popen(
        [str(CLOUDFLARED), "tunnel", "--url", "http://127.0.0.1:5000"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    deadline = time.time() + timeout
    url = None
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        m = re.search(r'https://[a-zA-Z0-9.-]+\.trycloudflare\.com', line)
        if m:
            url = m.group(0)
            log.info(f"Tunnel cloudflared actif: {url}")
            break
    return url, proc

def set_telegram_menu(url):
    menu_url = url.rstrip("/") + "/tg-auth"
    try:
        r = requests.post(f"{TELEGRAM_API}/setChatMenuButton", json={
            "menu_button": {
                "type": "web_app",
                "text": "🔥 Scarface OSINT",
                "web_app": {"url": menu_url}
            }
        }, timeout=10)
        data = r.json()
        if data.get("ok"):
            log.info(f"Menu Button Telegram mis à jour: {menu_url}")
            return True
        log.warning(f"Erreur Telegram: {data.get('description', '?')}")
    except Exception as e:
        log.warning(f"Erreur setChatMenuButton: {e}")
    return False

def restart_flask():
    try:
        subprocess.run(
            ["powershell", "-Command",
             'Get-Process -Name "python" | Where-Object { $_.CommandLine -match "app\\.py" } | Stop-Process -Force'],
            capture_output=True, timeout=5, text=True
        )
    except: pass
    time.sleep(2)
    subprocess.Popen(
        ["python", "app.py"], cwd=str(BASE),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    log.info("Flask redémarré")

def main():
    log.info("=== Tunnel Manager (cloudflared) démarré ===")
    kill_all()
    restart_flask()
    time.sleep(3)
    while True:
        url, proc = get_cloudflared_url()
        if url:
            write_config("PUBLIC_URL", url)
            write_status({"url": url, "active": True, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            set_telegram_menu(url)
            try: proc.wait(timeout=7200)
            except subprocess.TimeoutExpired: pass
            log.warning("Session cloudflared expirée, redémarrage...")
            kill_all()
            time.sleep(3)
        else:
            log.error("Échec tunnel cloudflared, nouvelle tentative dans 10s")
            kill_all()
            time.sleep(10)

if __name__ == "__main__":
    if "--once" in sys.argv:
        kill_all()
        url, proc = get_cloudflared_url()
        if url:
            write_config("PUBLIC_URL", url)
            write_status({"url": url, "active": True, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            set_telegram_menu(url)
            print(url)
        else:
            log.error("Échec cloudflared --once")
            sys.exit(1)
    elif "--kill" in sys.argv:
        kill_all()
        log.info("Tunnels arrêtés")
    else:
        main()
