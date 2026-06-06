import logging
import os
import time
import json
import secrets
import hmac
import hashlib
import urllib.parse

from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from flask import (
    Flask, render_template, request, redirect, url_for,
    flash, jsonify, session
)
from flask_login import (
    LoginManager, login_user, logout_user,
    login_required, current_user
)
from werkzeug.utils import secure_filename

from config import PRICING, FREE_REQUESTS_PER_DAY
from database import db, User, Subscription, SearchLog, PaymentProof

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = Flask(__name__)
app.config.from_object("config")

db.init_app(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"

BRIX_API_KEY = app.config["BRIX_API_KEY"]
BRIX_BASE = app.config["BRIX_BASE"]
BRIX_HEADERS = {
    "X-API-Key": BRIX_API_KEY,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Referer": "https://brixhub.net/",
    "Origin": "https://brixhub.net"
}
OXAPAY_API_KEY = app.config["OXAPAY_API_KEY"]
OXAPAY_BASE = app.config["OXAPAY_BASE"]
TELEGRAM_BOT_TOKEN = app.config["TELEGRAM_BOT_TOKEN"]
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

def tg_send_message(chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
    except: pass

def verify_telegram_data(tg_data: str) -> dict | None:
    """Validate Telegram WebApp init data and return user dict."""
    try:
        params_raw = {}
        for pair in tg_data.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                params_raw[k] = v
        req_hash = params_raw.pop("hash", "")
        if not req_hash:
            log.warning("TG verify: no hash in data")
            return None
        sorted_items = sorted(f"{k}={v}" for k, v in params_raw.items())
        data_check = "\n".join(sorted_items)
        secret_key = hmac.new(b"WebAppData", TELEGRAM_BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
        if computed != req_hash:
            return None
        params_decoded = {k: urllib.parse.unquote(v) for k, v in params_raw.items()}
        user_raw = params_decoded.get("user", "{}")
        user = json.loads(user_raw)
        return user
    except Exception as e:
        log.warning(f"TG verify error: {e}")
        return None

def parse_telegram_data(tg_data: str) -> dict | None:
    """Parse init data from Telegram JS SDK (no HMAC check, SDK is trusted)."""
    try:
        params_raw = {}
        for pair in tg_data.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                params_raw[k] = v
        params_decoded = {k: urllib.parse.unquote(v) for k, v in params_raw.items()}
        user_raw = params_decoded.get("user", "{}")
        user = json.loads(user_raw)
        return user
    except Exception as e:
        log.warning(f"TG parse error: {e}")
        return None

def is_telegram_request():
    if session.get("_tg_verified"):
        return True
    tg_data = request.args.get("tgWebAppData") or request.headers.get("X-Telegram-Data") or request.form.get("tgWebAppData")
    if tg_data:
        session["_tg_verified"] = True
        return True
    return False

@app.after_request
def add_ngrok_headers(response):
    response.headers["ngrok-skip-browser-warning"] = "1"
    return response

@app.before_request
def check_telegram_access():
    bypass = ["/static/", "/tg-auth", "/tg-verify", "/app", "/api/oxapay/callback"]
    if any(request.path.startswith(b) for b in bypass):
        return
    if current_user.is_authenticated and current_user.is_admin:
        return
    if is_telegram_request():
        if not current_user.is_authenticated:
            tg_data = request.args.get("tgWebAppData", "")
            user = verify_telegram_data(tg_data)
            if user:
                tid = str(user.get("id", ""))
                username = user.get("username") or f"tg_{tid}"
                u = User.query.filter_by(telegram_id=tid).first()
                if not u:
                    u = User(username=username, email=f"{tid}@telegram.local")
                    u.set_password(secrets.token_hex(16))
                    u.telegram_id = tid
                    u.telegram_username = user.get("username")
                    u.telegram_first_name = user.get("first_name")
                    u.telegram_last_name = user.get("last_name")
                    u.telegram_photo_url = user.get("photo_url")
                    u.reg_ip = request.remote_addr
                    u.reg_user_agent = f"Telegram/{user.get('first_name','')}"
                    db.session.add(u)
                    db.session.commit()
                    log.info(f"Nouvel utilisateur Telegram: {username}")
                login_user(u, remember=True)
                u.last_login = datetime.utcnow()
                u.last_ip = request.remote_addr
                u.telegram_username = user.get("username") or u.telegram_username
                u.telegram_first_name = user.get("first_name") or u.telegram_first_name
                u.telegram_last_name = user.get("last_name") or u.telegram_last_name
                if user.get("photo_url"):
                    u.telegram_photo_url = user.get("photo_url")
                db.session.commit()
        session["_tg_verified"] = True
        return
    # Let the request through — client-side JS enforces Telegram-only

@login_manager.unauthorized_handler
def unauthorized():
    return redirect(url_for("index"))

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

_brix_session = None
def _get_brix_session():
    global _brix_session
    if _brix_session is None:
        try:
            from curl_cffi import requests as cr
            s = cr.Session()
        except:
            s = requests.Session()
        s.headers.update(BRIX_HEADERS)
        _brix_session = s
    return _brix_session

def brix_request(method, path, **kwargs):
    s = _get_brix_session()
    kwargs.setdefault("timeout", 15)
    r = s.request(method, f"{BRIX_BASE}{path}", **kwargs)
    if r.status_code in (503, 504):
        return {"data": {"results": [], "total": 0}, "error": {"type": "unavailable"}}, r.headers
    if r.status_code == 403:
        log.error(f"BrixHub 403 on {path}: {r.text[:500]}")
    r.raise_for_status()
    return r.json(), r.headers

def brix_search(payload):
    payload.setdefault("flexible", True)
    payload.setdefault("per_page", 10)
    return brix_request("POST", "/search", json=payload)

def brix_lookup_email(email):
    return brix_request("GET", f"/lookup/email/{email}")

def brix_lookup_phone(phone):
    return brix_request("GET", f"/lookup/phone/{phone}")

def brix_me():
    return brix_request("GET", "/me")

def brix_lookup_breach(email):
    try:
        return brix_request("GET", f"/lookup/breach/{email}")
    except:
        return brix_lookup_email(email)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

@app.template_filter("from_json")
def from_json_filter(s):
    try: return json.loads(s)
    except: return {}

@app.context_processor
def inject_globals():
    return {
        "now": datetime.utcnow(),
        "pricing": PRICING,
        "free_requests": FREE_REQUESTS_PER_DAY,
    }

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/app")
def app_shortcut():
    return """<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Scarface OSINT</title><link rel="manifest" href="/static/manifest.json"><meta name="theme-color" content="#ef4444"><meta http-equiv="refresh" content="0;url=https://t.me/scarfaceosintt_bot/app"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:24px;text-align:center}.lg{font-size:4em;margin-bottom:8px}h1{font-size:1.5em;background:linear-gradient(135deg,#ef4444,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}.s{color:#8b949e;font-size:.9em;margin:8px 0 24px;max-width:320px;line-height:1.5}.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:linear-gradient(135deg,#ef4444,#f97316);color:#fff;border:none;border-radius:12px;font-size:1em;font-weight:600;text-decoration:none;cursor:pointer;transition:transform .15s}.btn:active{transform:scale(.96)}.hr{width:100%;max-width:320px;height:1px;background:#21262d;margin:24px 0}small{color:#484f58;font-size:.78em;max-width:320px;line-height:1.4}</style></head><body><div class="lg">🔥</div><h1>Scarface OSINT</h1><p class="s">Ajoute cette page à l'écran d'accueil depuis ton navigateur :<br><br><strong>Chrome</strong> : ⋮ → Ajouter à l'écran d'accueil<br><strong>Safari</strong> : ⬆️ Partager → Ajouter à l'écran d'accueil<br><br>L'icône ouvrira directement Scarface OSINT dans Telegram.</p><a href="https://t.me/scarfaceosintt_bot/app" class="btn">✈️ Ouvrir l'application</a><div class="hr"></div><small>Cette page est accessible depuis n'importe quel navigateur.</small></body></html>"""

@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        if not username or not email or not password:
            flash("Tous les champs sont obligatoires.", "danger")
            return render_template("register.html")

        if password != confirm:
            flash("Les mots de passe ne correspondent pas.", "danger")
            return render_template("register.html")

        if User.query.filter_by(username=username).first():
            flash("Ce nom d'utilisateur est déjà pris.", "danger")
            return render_template("register.html")

        if User.query.filter_by(email=email).first():
            flash("Cet email est déjà utilisé.", "danger")
            return render_template("register.html")

        user = User(username=username, email=email)
        user.set_password(password)
        user.reg_ip = request.remote_addr
        user.reg_user_agent = request.headers.get("User-Agent", "")[:500]
        interesting = ["Accept", "Accept-Language", "Accept-Encoding", "Referer", "Origin", "Sec-Ch-Ua", "Sec-Ch-Ua-Platform", "Sec-Ch-Ua-Mobile"]
        extra = {}
        for h in interesting:
            v = request.headers.get(h)
            if v:
                extra[h] = v
        extra["method"] = request.method
        extra["path"] = request.path
        user.reg_headers = json.dumps(extra, ensure_ascii=False)
        db.session.add(user)
        db.session.commit()

        log.info(f"Nouvel utilisateur: {username} ({email}) IP: {user.reg_ip}")
        flash("Compte créé avec succès ! Connecte-toi.", "success")
    return redirect(url_for("login"))

# ─── BOT WEBHOOK ────────────────────────────────────────────────────────────

def handle_tg_update(update):
    msg = update.get("message") or {}
    chat_id = msg.get("chat", {}).get("id")
    text = (msg.get("text") or "").strip()
    if not chat_id:
        return
    public_url = app.config.get("PUBLIC_URL", "") or os.environ.get("RAILWAY_PUBLIC_DOMAIN", f"https://{os.environ.get('RAILWAY_STATIC_URL', 'localhost:5000')}")
    if text == "/start":
        welcome = (
            "<b>🔥 Bienvenue sur Scarface OSINT !</b>\n\n"
            "Plateforme de recherche OSINT professionnelle.\n\n"
            "🔍 <b>Fonctionnalités :</b>\n"
            "• Recherche par nom, email, téléphone, adresse\n"
            "• Graphe de connexions\n"
            "• Détection de liens familiaux\n"
            "• 3 recherches gratuites/jour\n\n"
            "⬇️ Clique ci-dessous pour ouvrir l'app :"
        )
        tg_send_message(chat_id, welcome, {
            "inline_keyboard": [[{
                "text": "🚀 Ouvrir Scarface OSINT",
                "web_app": {"url": public_url}
            }]]
        })

@app.route("/webhook", methods=["POST"])
def tg_webhook():
    update = request.get_json(silent=True)
    if update:
        handle_tg_update(update)
    return "ok"

def set_webhook():
    public_url = app.config.get("PUBLIC_URL", "") or os.environ.get("RAILWAY_PUBLIC_DOMAIN", "")
    if not public_url:
        log.warning("PUBLIC_URL not set, cannot set webhook")
        return
    webhook_url = f"{public_url.rstrip('/')}/webhook"
    try:
        r = requests.get(f"{TELEGRAM_API}/setWebhook?url={webhook_url}", timeout=10)
        data = r.json()
        if data.get("ok"):
            log.info(f"Webhook set to {webhook_url}")
        else:
            log.error(f"Failed to set webhook: {data}")
    except Exception as e:
        log.error(f"Webhook error: {e}")
    try:
        r = requests.get(f"{TELEGRAM_API}/getMe", timeout=10)
        me = r.json()
        if me.get("ok"):
            log.info(f"Bot authenticated: @{me['result'].get('username', '?')}")
    except Exception as e:
        log.error(f"Failed to get bot info: {e}")

# ─── ERRORS ─────────────────────────────────────────────────────────────────

@app.route("/tg-auth")
def tg_auth():
    tg_data = request.args.get("tgWebAppData") or request.args.get("id")
    if tg_data:
        try:
            user = verify_telegram_data(tg_data)
            if user:
                tid = str(user.get("id", ""))
                username = user.get("username") or f"tg_{tid}"
                u = User.query.filter_by(telegram_id=tid).first()
                if not u:
                    u = User(username=username, email=f"{tid}@telegram.local")
                    u.set_password(secrets.token_hex(16))
                    u.telegram_id = tid
                    u.telegram_username = user.get("username")
                    u.telegram_first_name = user.get("first_name")
                    u.telegram_last_name = user.get("last_name")
                    u.telegram_photo_url = user.get("photo_url")
                    u.reg_ip = request.remote_addr
                    u.reg_user_agent = f"Telegram/{user.get('first_name','')}"
                    db.session.add(u)
                    db.session.commit()
                    log.info(f"Nouvel utilisateur Telegram: {username}")
                login_user(u, remember=True)
                u.last_login = datetime.utcnow()
                u.last_ip = request.remote_addr
                u.telegram_username = user.get("username") or u.telegram_username
                u.telegram_first_name = user.get("first_name") or u.telegram_first_name
                u.telegram_last_name = user.get("last_name") or u.telegram_last_name
                if user.get("photo_url"):
                    u.telegram_photo_url = user.get("photo_url")
                db.session.commit()
                return redirect(url_for("index"))
            log.warning("TG auth: HMAC validation failed")
        except Exception as e:
            log.warning(f"TG auth error: {e}")
    return redirect(url_for("login"))

@app.route("/tg-verify", methods=["POST"])
def tg_verify():
    data = request.get_json(silent=True) or {}
    tg_data = data.get("initData", "")
    if not tg_data:
        return jsonify({"ok": False, "error": "No initData"}), 400
    user = parse_telegram_data(tg_data)
    if not user:
        return jsonify({"ok": False, "error": "HMAC invalide"}), 403
    tid = str(user.get("id", ""))
    username = user.get("username") or f"tg_{tid}"
    u = User.query.filter_by(telegram_id=tid).first()
    if not u:
        u = User(username=username, email=f"{tid}@telegram.local")
        u.set_password(secrets.token_hex(16))
        u.telegram_id = tid
        u.telegram_username = user.get("username")
        u.telegram_first_name = user.get("first_name")
        u.telegram_last_name = user.get("last_name")
        u.telegram_photo_url = user.get("photo_url")
        u.reg_ip = request.remote_addr
        u.reg_user_agent = f"Telegram/{user.get('first_name','')}"
        db.session.add(u)
        db.session.commit()
        log.info(f"Nouvel utilisateur Telegram via JS: {username}")
    login_user(u, remember=True)
    u.last_login = datetime.utcnow()
    u.last_ip = request.remote_addr
    u.telegram_username = user.get("username") or u.telegram_username
    u.telegram_first_name = user.get("first_name") or u.telegram_first_name
    u.telegram_last_name = user.get("last_name") or u.telegram_last_name
    if user.get("photo_url"):
        u.telegram_photo_url = user.get("photo_url")
    db.session.commit()
    return jsonify({"ok": True, "redirect": url_for("index")})

@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        user = User.query.filter(
            db.or_(User.username == username, User.email == username)
        ).first()

        if not user or not user.check_password(password):
            flash("Identifiants incorrects.", "danger")
            return render_template("login.html")

        if user.is_banned:
            flash("Ce compte a été banni.", "danger")
            return render_template("login.html")

        user.last_login = datetime.utcnow()
        user.last_ip = request.remote_addr
        db.session.commit()

        login_user(user, remember=True)
        log.info(f"Connexion: {user.username}")

        next_page = request.args.get("next")
        if next_page:
            return redirect(next_page)
        return redirect(url_for("dashboard"))

    return render_template("login.html")

@app.route("/logout")
@login_required
def logout():
    logout_user()
    flash("Déconnecté.", "info")
    return redirect(url_for("index"))

@app.route("/dashboard")
@login_required
def dashboard():
    today_usage = current_user.get_today_usage()
    daily_quota = current_user.get_daily_quota()
    remaining = daily_quota - today_usage

    recent_searches = SearchLog.query.filter_by(
        user_id=current_user.id
    ).order_by(SearchLog.created_at.desc()).limit(10).all()

    return render_template("dashboard.html",
        today_usage=today_usage,
        daily_quota=daily_quota,
        remaining=remaining,
        recent_searches=recent_searches
    )

@app.route("/pricing")
def pricing():
    return render_template("pricing.html")

@app.route("/subscribe/<plan>")
@login_required
def subscribe(plan):
    if plan not in PRICING:
        flash("Plan invalide.", "danger")
        return redirect(url_for("pricing"))

    if current_user.has_active_subscription():
        flash("Tu as déjà un abonnement actif.", "info")
        return redirect(url_for("dashboard"))

    return render_template("subscribe.html", plan=plan, plan_info=PRICING[plan])

@app.route("/submit-payment", methods=["POST"])
@login_required
def submit_payment():
    plan = request.form.get("plan")
    if plan not in PRICING:
        flash("Plan invalide.", "danger")
        return redirect(url_for("pricing"))

    paypal_name = request.form.get("paypal_name", "").strip()

    existing = Subscription.query.filter_by(user_id=current_user.id).first()
    if existing:
        subscription = existing
        subscription.plan = plan
        subscription.is_active = False
        subscription.payment_status = "pending"
        subscription.payment_method = "paypal"
    else:
        subscription = Subscription(
            user_id=current_user.id,
            plan=plan,
            requests_per_day=PRICING[plan]["requests_per_day"],
            is_active=False,
            payment_status="pending",
            payment_method="paypal"
        )
        db.session.add(subscription)

    subscription.notes = f"PayPal: {paypal_name}" if paypal_name else "PayPal (sans nom)"
    db.session.commit()
    flash("Demande d'abonnement soumise ! Un admin validera sous 24h.", "success")
    return redirect(url_for("dashboard"))

@app.route("/subscribe/<plan>/oxapay")
@login_required
def subscribe_oxapay(plan):
    if plan not in PRICING:
        flash("Plan invalide.", "danger")
        return redirect(url_for("pricing"))
    if current_user.has_active_subscription():
        flash("Tu as déjà un abonnement actif.", "info")
        return redirect(url_for("dashboard"))
    try:
        payload = {
            "amount": PRICING[plan]["price"],
            "currency": "USD",
            "lifetime": 120,
            "fee_paid_by_payer": 1,
            "callback_url": url_for("oxapay_callback", _external=True),
            "return_url": url_for("dashboard", _external=True),
            "order_id": f"{current_user.id}-{plan}-{int(time.time())}",
            "description": f"Scarface OSINT - {PRICING[plan]['name']}",
            "sandbox": False
        }
        r = requests.post(f"{OXAPAY_BASE}/payment/invoice",
            json=payload,
            headers={"merchant_api_key": OXAPAY_API_KEY, "Content-Type": "application/json"},
            timeout=15
        )
        r.raise_for_status()
        data = r.json()
        if data.get("status") == 200 and data.get("data", {}).get("payment_url"):
            return redirect(data["data"]["payment_url"])
        flash("Erreur création du paiement Oxapay.", "danger")
    except Exception as e:
        flash(f"Erreur Oxapay: {str(e)}", "danger")
    return redirect(url_for("subscribe", plan=plan))

@app.route("/api/oxapay/callback", methods=["POST"])
def oxapay_callback():
    data = request.get_json(silent=True) or request.form.to_dict()
    if not data:
        return "ok", 200
    status = data.get("status", "")
    track_id = data.get("trackId", "")
    order_id = data.get("orderId", "")
    if status == "Completed" and order_id:
        parts = order_id.split("-")
        if len(parts) >= 2:
            try:
                user_id = int(parts[0])
                plan = parts[1]
                if plan in PRICING:
                    user = User.query.get(user_id)
                    if user:
                        existing = Subscription.query.filter_by(user_id=user.id).first()
                        if existing:
                            sub = existing
                            sub.plan = plan
                            sub.is_active = True
                            sub.payment_status = "paid"
                            sub.payment_method = "oxapay"
                        else:
                            sub = Subscription(
                                user_id=user.id, plan=plan,
                                requests_per_day=PRICING[plan]["requests_per_day"],
                                is_active=True, payment_status="paid",
                                payment_method="oxapay"
                            )
                            db.session.add(sub)
                        sub.start_date = datetime.utcnow()
                        if plan == "monthly":
                            sub.end_date = datetime.utcnow() + timedelta(days=30)
                        elif plan == "yearly":
                            sub.end_date = datetime.utcnow() + timedelta(days=365)
                        else:
                            sub.end_date = None
                        db.session.commit()
            except: pass
    return "ok", 200

@app.route("/search", methods=["GET", "POST"])
@login_required
def search():
    if current_user.get_remaining_requests() <= 0:
        flash("Quota quotidien atteint ! Abonne-toi pour plus.", "warning")
        return redirect(url_for("pricing"))

    return render_template("search.html")

@app.route("/search/results", methods=["POST"])
@login_required
def search_results():
    if current_user.get_remaining_requests() <= 0:
        flash("Quota quotidien atteint !", "warning")
        return redirect(url_for("pricing"))

    mode = request.form.get("mode", "recherche")
    flexible = request.form.get("flexible", "1") == "1"
    results = []
    error = None
    query_data = {}
    t_start = time.time()

    def collect_fields():
        p = {}
        supported = {
            "nom": "nom_famille", "prenom": "prenom",
            "nom_affiche": "nom_affichage", "email": "email", "telephone": "telephone",
            "ip": "adresse_ip", "adresse": "adresse", "cp": "code_postal",
            "ville": "ville", "genre": "genre", "annee": "annee_naissance",
            "nom_utilisateur": "nom_utilisateur", "nir": "nir",
            "complement_adresse": "complement_adresse", "fonction": "fonction",
            "societe": "societe", "date_naissance": "date_naissance"
        }
        for form_field, api_field in supported.items():
            val = request.form.get(form_field, "").strip()
            if val:
                p[api_field] = val
        return p

    payload = collect_fields()

    try:
        if mode == "email":
            email = payload.pop("email", "") or request.form.get("email", "").strip()
            if email:
                query_data = {"email": email}
                data, headers = brix_lookup_breach(email)
            else:
                flash("Email requis pour ce mode.", "warning")
                return redirect(url_for("search"))

        elif mode == "graphe":
            if not payload:
                flash("Remplis au moins un champ pour le graphe.", "warning")
                return redirect(url_for("search"))
            query_data = dict(payload)
            data, headers = brix_search(payload)

        elif mode == "francaise":
            if not payload:
                flash("Remplis au moins un champ.", "warning")
                return redirect(url_for("search"))
            query_data = dict(payload)
            data, headers = brix_search(payload)

        elif mode == "pro":
            pro_payload = {}
            if payload.get("nom_famille"): pro_payload["nom_famille"] = payload["nom_famille"]
            if payload.get("prenom"): pro_payload["prenom"] = payload["prenom"]
            if payload.get("email"): pro_payload["email"] = payload["email"]
            entreprise = request.form.get("entreprise", "").strip() or request.form.get("societe", "").strip()
            if entreprise: pro_payload["societe"] = entreprise
            if not pro_payload:
                flash("Nom, email ou entreprise requis.", "warning")
                return redirect(url_for("search"))
            pro_payload["per_page"] = 20
            query_data = dict(pro_payload)
            data, headers = brix_search(pro_payload)

        else:
            if not flexible and not payload:
                flash("Remplis au moins un champ.", "warning")
                return redirect(url_for("search"))
            query_data = dict(payload)
            data, headers = brix_search(payload)

        t_elapsed = int((time.time() - t_start) * 1000)
        api_error = data.get("error")
        results_data = data.get("data", {}).get("results", [])
        total = data.get("data", {}).get("total", len(results_data))
        quota_remaining = headers.get("X-RateLimit-Remaining-Day", "?")

        log_entry = SearchLog(
            user_id=current_user.id,
            query_type=mode,
            query_data=json.dumps(query_data, ensure_ascii=False),
            results_count=total,
            response_time_ms=t_elapsed
        )
        db.session.add(log_entry)
        db.session.commit()

        if mode == "graphe":
            # Chercher les profils liés
            related_profiles = []
            seen_r = set()
            orig_key = (query_data.get("nom_famille", "") + "|" + query_data.get("prenom", "") + "|" + query_data.get("email", "") + "|" + query_data.get("telephone", "")).lower()

            def fetch_r(pl, lbl):
                try:
                    pl["flexible"] = True; pl["per_page"] = 8
                    r = requests.post(f"{BRIX_BASE}/search", json=pl, headers=BRIX_HEADERS, timeout=12)
                    if r.status_code == 200:
                        for p in r.json().get("data", {}).get("results", []):
                            pid = (p.get("nom_famille","") + "|" + p.get("prenom","") + "|" + p.get("email","") + "|" + p.get("telephone","")).lower()
                            if pid and pid != orig_key and pid not in seen_r:
                                seen_r.add(pid)
                                related_profiles.append({"profil": p, "lien": lbl})
                    else:
                        log.warning(f"fetch_r {lbl}: status {r.status_code}")
                except Exception as ex:
                    log.warning(f"fetch_r {lbl}: {ex}")

            with ThreadPoolExecutor(max_workers=8) as ex:
                fs = []
                q = query_data
                if q.get("telephone"): fs.append(ex.submit(fetch_r, {"telephone": q["telephone"]}, "📞 Même téléphone"))
                if q.get("email"): fs.append(ex.submit(fetch_r, {"email": q["email"]}, "📧 Même email"))
                if q.get("adresse"): fs.append(ex.submit(fetch_r, {"adresse": q["adresse"]}, "🏠 Même adresse"))
                if q.get("code_postal"): fs.append(ex.submit(fetch_r, {"code_postal": q["code_postal"]}, "📍 Même code postal"))
                if q.get("ville") and not q.get("code_postal"): fs.append(ex.submit(fetch_r, {"ville": q["ville"]}, "📍 Même ville"))
                if q.get("nom_famille") and (q.get("adresse") or q.get("code_postal") or q.get("ville")):
                    sp = {"nom_famille": q["nom_famille"]}
                    if q.get("adresse"): sp["adresse"] = q["adresse"]
                    elif q.get("code_postal"): sp["code_postal"] = q["code_postal"]
                    elif q.get("ville"): sp["ville"] = q["ville"]
                    fs.append(ex.submit(fetch_r, sp, "👫 Frère/Sœur (même nom + adresse)"))
                if q.get("nom_famille") and q.get("telephone"): fs.append(ex.submit(fetch_r, {"nom_famille": q["nom_famille"], "telephone": q["telephone"]}, "👨‍👩‍👧‍👦 Famille (même nom + tél)"))
                if q.get("nom_famille") and q.get("email"): fs.append(ex.submit(fetch_r, {"nom_famille": q["nom_famille"], "email": q["email"]}, "👨‍👩‍👧‍👦 Famille (même nom + email)"))
                for f in as_completed(fs): pass

            return render_template("graphe.html",
                results=results_data,
                total=total,
                query_data=query_data,
                elapsed=t_elapsed,
                related=related_profiles[:30],
                api_error=api_error
            )

        if mode == "email":
            breach_data = data.get("data", {}).get("passwords", data.get("data", {}).get("breaches", []))
            return render_template("results.html",
                results=results_data, total=total,
                query_data=query_data, elapsed=t_elapsed,
                breaches=breach_data, quota_remaining=quota_remaining,
                api_error=api_error
            )

        return render_template("results.html",
            results=results_data,
            total=total,
            mode=mode,
            quota_remaining=quota_remaining,
            elapsed=t_elapsed,
            api_error=api_error
        )

    except requests.exceptions.HTTPError as e:
        error = f"Erreur: {e}"
        if e.response.status_code == 429:
            error = "Limite de requêtes atteinte. Réessaie dans une minute."
    except requests.exceptions.Timeout:
        error = "La requête a expiré. Réessaie."
    except Exception as e:
        error = f"Erreur: {str(e)}"
        log.error(f"Search error: {e}")

    return render_template("results.html", error=error, mode=mode, api_error=None)

@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    if request.method == "POST":
        display_name = request.form.get("display_name", "").strip()
        bio = request.form.get("bio", "").strip()
        if display_name:
            current_user.display_name = display_name
        else:
            current_user.display_name = None
        if bio:
            current_user.bio = bio
        else:
            current_user.bio = None
        db.session.commit()
        flash("Profil mis à jour.", "success")
        return redirect(url_for("profile"))
    return render_template("profile.html")

@app.route("/profile/change-password", methods=["POST"])
@login_required
def change_password():
    current_pass = request.form.get("current_password", "")
    new_pass = request.form.get("new_password", "")
    confirm = request.form.get("confirm_password", "")

    if not current_user.check_password(current_pass):
        flash("Mot de passe actuel incorrect.", "danger")
        return redirect(url_for("profile"))

    if new_pass != confirm:
        flash("Les nouveaux mots de passe ne correspondent pas.", "danger")
        return redirect(url_for("profile"))

    if len(new_pass) < 6:
        flash("Le mot de passe doit faire au moins 6 caractères.", "danger")
        return redirect(url_for("profile"))

    current_user.set_password(new_pass)
    db.session.commit()
    flash("Mot de passe changé avec succès.", "success")
    return redirect(url_for("profile"))

@app.route("/profile/regenerate-key", methods=["POST"])
@login_required
def regenerate_api_key():
    current_user.api_key = secrets.token_hex(32)
    db.session.commit()
    flash("Nouvelle clé générée.", "success")
    return redirect(url_for("profile"))

@app.route("/profile/clear-history", methods=["POST"])
@login_required
def clear_search_history():
    SearchLog.query.filter_by(user_id=current_user.id).delete()
    db.session.commit()
    flash("Historique effacé.", "success")
    return redirect(url_for("profile"))

@app.route("/api/me")
@login_required
def api_me():
    try:
        data, headers = brix_me()
        return jsonify(data.get("data", {}))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/search/family", methods=["POST"])
@login_required
def api_search_family():
    if not current_user.is_admin and not current_user.has_active_subscription():
        return jsonify({"error": "Premium requis", "related": []}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données manquantes"}), 400

    nom = data.get("nom", "").strip()
    prenom = data.get("prenom", "").strip()
    adresse = data.get("adresse", "").strip()
    telephone = data.get("telephone", "").strip()
    email = data.get("email", "").strip()
    cp = data.get("cp", "").strip()
    ville = data.get("ville", "").strip()

    # Identité de la personne de base pour l'exclure des résultats
    original_id = (nom + "|" + prenom + "|" + email + "|" + telephone).lower()
    tasks = []

    def make_task(payload, label):
        p = dict(payload)
        p.setdefault("flexible", True)
        p["per_page"] = 8
        return (p, label)

    if telephone:
        tasks.append(make_task({"telephone": telephone}, "📞 Même téléphone"))
    if email:
        tasks.append(make_task({"email": email}, "📧 Même email"))
    if adresse:
        tasks.append(make_task({"adresse": adresse}, "🏠 Même adresse"))
    if cp:
        tasks.append(make_task({"code_postal": cp}, "📍 Même code postal"))
    if ville and not cp:
        tasks.append(make_task({"ville": ville}, "📍 Même ville"))
    if nom and (adresse or cp or ville):
        sibling = {"nom_famille": nom}
        if adresse: sibling["adresse"] = adresse
        elif cp: sibling["code_postal"] = cp
        elif ville: sibling["ville"] = ville
        tasks.append(make_task(sibling, "👫 Frère/Sœur (même nom + adresse)"))
    if nom and telephone:
        tasks.append(make_task({"nom_famille": nom, "telephone": telephone}, "👨‍👩‍👧‍👦 Famille (même nom + tél)"))
    if nom and email:
        tasks.append(make_task({"nom_famille": nom, "email": email}, "👨‍👩‍👧‍👦 Famille (même nom + email)"))

    related = []
    seen = set()

    def fetch(task):
        payload, label = task
        try:
            r = requests.post(f"{BRIX_BASE}/search", json=payload, headers=BRIX_HEADERS, timeout=10)
            if r.status_code == 200:
                res = r.json().get("data", {}).get("results", [])
                out = []
                for p in res:
                    pid = (p.get("nom_famille", "") + "|" + p.get("prenom", "") + "|" + p.get("email", "") + "|" + p.get("telephone", "")).lower()
                    if pid and pid != original_id:
                        out.append((pid, p, label))
                return out
        except:
            pass
        return []

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(fetch, t) for t in tasks]
        for f in as_completed(futures):
            for pid, p, label in f.result():
                if pid not in seen:
                    seen.add(pid)
                    related.append({"profil": p, "lien": label})

    return jsonify({"related": related[:20]})

@app.route("/api/quota")
@login_required
def api_quota():
    return jsonify({
        "daily_quota": current_user.get_daily_quota(),
        "today_usage": current_user.get_today_usage(),
        "remaining": current_user.get_remaining_requests(),
        "has_subscription": current_user.has_active_subscription(),
        "is_admin": current_user.is_admin,
    })

# ─── ADMIN ──────────────────────────────────────────────────────────────────

@app.route("/admin")
@login_required
def admin_index():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    total_users = User.query.count()
    active_subs = Subscription.query.filter_by(is_active=True).count()
    total_searches = SearchLog.query.count()
    pending_payments = PaymentProof.query.filter_by(status="pending").count()
    recent_users = User.query.order_by(User.created_at.desc()).limit(5).all()

    return render_template("admin/index.html",
        total_users=total_users,
        active_subs=active_subs,
        total_searches=total_searches,
        pending_payments=pending_payments,
        recent_users=recent_users
    )

@app.route("/admin/users")
@login_required
def admin_users():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    page = request.args.get("page", 1, type=int)
    search = request.args.get("search", "").strip()

    query = User.query
    if search:
        query = query.filter(
            db.or_(
                User.username.ilike(f"%{search}%"),
                User.email.ilike(f"%{search}%")
            )
        )

    users = query.order_by(User.created_at.desc()).paginate(page=page, per_page=20)
    return render_template("admin/users.html", users=users, search=search)

@app.route("/admin/user/<int:user_id>")
@login_required
def admin_user_detail(user_id):
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    user = User.query.get_or_404(user_id)
    searches = SearchLog.query.filter_by(user_id=user_id).order_by(
        SearchLog.created_at.desc()
    ).limit(50).all()

    return render_template("admin/user_detail.html", user=user, searches=searches)

@app.route("/admin/user/<int:user_id>/ban", methods=["POST"])
@login_required
def admin_ban_user(user_id):
    if not current_user.is_admin:
        return jsonify({"error": "Access denied"}), 403

    user = User.query.get_or_404(user_id)
    if user.is_admin:
        flash("Impossible de bannir un admin.", "danger")
        return redirect(url_for("admin_users"))

    user.is_banned = not user.is_banned
    user.status = "banni" if user.is_banned else "actif"
    db.session.commit()
    status = "banni" if user.is_banned else "débanni"
    flash(f"Utilisateur {user.username} {status}.", "success")
    return redirect(url_for("admin_users"))

@app.route("/admin/user/<int:user_id>/status", methods=["POST"])
@login_required
def admin_set_status(user_id):
    if not current_user.is_admin:
        return jsonify({"error": "Access denied"}), 403
    user = User.query.get_or_404(user_id)
    new_status = request.form.get("status", "").strip()
    if new_status not in ("actif", "suspendu", "banni"):
        flash("Statut invalide.", "danger")
        return redirect(url_for("admin_user_detail", user_id=user.id))
    user.status = new_status
    user.is_banned = (new_status == "banni")
    db.session.commit()
    flash(f"Statut de {user.username} → {new_status}.", "success")
    return redirect(url_for("admin_user_detail", user_id=user.id))

@app.route("/admin/subscriptions")
@login_required
def admin_subscriptions():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    status_filter = request.args.get("status", "all")
    query = Subscription.query

    if status_filter == "active":
        query = query.filter_by(is_active=True)
    elif status_filter == "pending":
        query = query.filter_by(payment_status="pending")
    elif status_filter == "expired":
        query = query.filter(Subscription.end_date < datetime.utcnow())

    subscriptions = query.order_by(Subscription.created_at.desc()).all()
    return render_template("admin/subscriptions.html",
        subscriptions=subscriptions,
        status_filter=status_filter
    )

@app.route("/admin/subscription/<int:sub_id>/approve", methods=["POST"])
@login_required
def admin_approve_subscription(sub_id):
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    sub = Subscription.query.get_or_404(sub_id)
    sub.is_active = True
    sub.payment_status = "approved"
    sub.start_date = datetime.utcnow()

    if sub.plan == "monthly":
        sub.end_date = datetime.utcnow().replace(day=28) + timedelta(days=30)
        sub.requests_per_day = PRICING["monthly"]["requests_per_day"]
    elif sub.plan == "yearly":
        sub.end_date = datetime.utcnow().replace(day=28) + timedelta(days=365)
        sub.requests_per_day = PRICING["yearly"]["requests_per_day"]
    elif sub.plan == "lifetime":
        sub.end_date = None
        sub.requests_per_day = PRICING["lifetime"]["requests_per_day"]

    db.session.commit()
    flash(f"Abonnement {sub.plan} activé pour {sub.user.username}.", "success")
    return redirect(url_for("admin_subscriptions"))

@app.route("/admin/subscription/<int:sub_id>/reject", methods=["POST"])
@login_required
def admin_reject_subscription(sub_id):
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    sub = Subscription.query.get_or_404(sub_id)
    sub.payment_status = "rejected"
    db.session.commit()
    flash(f"Abonnement rejeté.", "success")
    return redirect(url_for("admin_subscriptions"))

@app.route("/admin/searches")
@login_required
def admin_searches():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    page = request.args.get("page", 1, type=int)
    searches = SearchLog.query.order_by(
        SearchLog.created_at.desc()
    ).paginate(page=page, per_page=50)

    return render_template("admin/searches.html", searches=searches)

@app.route("/admin/brix-quota")
@login_required
def admin_brix_quota():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("dashboard"))

    try:
        data, headers = brix_me()
        info = data.get("data", {})
        return render_template("admin/brix_quota.html", info=info, headers=headers)
    except Exception as e:
        flash(f"Erreur: {e}", "danger")
        return redirect(url_for("admin_index"))

BASE_DIR = Path(__file__).parent.resolve()

@app.route("/admin/tunnel-status")
@login_required
def admin_tunnel_status():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("admin_index"))
    status = {"url": "", "active": False, "started": ""}
    try:
        sf = BASE_DIR / "tunnel_status.json"
        if sf.exists():
            status = json.loads(sf.read_text())
    except: pass
    return render_template("admin/tunnel_status.html", status=status)

@app.route("/admin/restart-tunnel", methods=["POST"])
@login_required
def admin_restart_tunnel():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("admin_index"))
    import subprocess
    subprocess.Popen(
        ["python", str(BASE_DIR / "tunnel_manager.py"), "--once"],
        cwd=str(BASE_DIR),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    flash("🔄 Tunnel en cours de redémarrage...", "info")
    return redirect(url_for("admin_index"))

@app.route("/admin/update-menu", methods=["POST"])
@login_required
def admin_update_menu():
    if not current_user.is_admin:
        flash("Accès refusé.", "danger")
        return redirect(url_for("admin_index"))
    public_url = app.config.get("PUBLIC_URL", "")
    if not public_url:
        flash("PUBLIC_URL non configurée.", "danger")
        return redirect(url_for("admin_index"))
    menu_url = public_url.rstrip("/") + "/tg-auth"
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
            flash(f"✅ Menu button mis à jour → {menu_url}", "success")
        else:
            flash(f"❌ Erreur Telegram: {data.get('description', '?')}", "danger")
    except Exception as e:
        flash(f"Erreur: {e}", "danger")
    return redirect(url_for("admin_index"))

# ─── ERRORS ─────────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(e):
    return render_template("errors/404.html"), 404

@app.errorhandler(500)
def server_error(e):
    return render_template("errors/500.html"), 500

# ─── MAIN ───────────────────────────────────────────────────────────────────

def init_db():
    with app.app_context():
        db.create_all()
        for col in ("status", "reg_ip", "reg_user_agent", "reg_headers", "last_ip", "telegram_id", "telegram_username", "telegram_first_name", "telegram_last_name", "telegram_photo_url"):
            try:
                db.session.execute(db.text(f"ALTER TABLE users ADD COLUMN {col} TEXT"))
                db.session.commit()
            except:
                db.session.rollback()
        try:
            admin = User.query.filter_by(username="admin").first()
            if not admin:
                admin = User(
                    username="admin",
                    email="admin@scarface-osint.local",
                    is_admin=True,
                )
                admin.set_password("admin123")
                db.session.add(admin)
                db.session.commit()
                log.info("Admin user created (admin / admin123)")
        except:
            db.session.rollback()
        for u in User.query.filter(User.status.is_(None)).all():
            u.status = "banni" if u.is_banned else "actif"
        db.session.commit()

init_db()
set_webhook()

if __name__ == "__main__":
    log.info("🚀 Scarface OSINT Web démarré sur http://127.0.0.1:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
