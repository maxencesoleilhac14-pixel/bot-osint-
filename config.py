import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

SECRET_KEY = os.environ.get("SECRET_KEY", "scarface-secret-key-change-in-production-2026")
SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", f"sqlite:///{os.path.join(BASE_DIR, 'scarface.db')}")
SQLALCHEMY_TRACK_MODIFICATIONS = False

BRIX_API_KEY = os.environ.get("BRIX_API_KEY", "brix_MvXUIsgucxgC__UrlLkjLtnaYuEuXQZCJ79MIiaznh_zR9Us")
BRIX_BASE = os.environ.get("BRIX_BASE", "https://brixhub.net/api/v1")

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@scarface-osint.local")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

STRIPE_PUBLIC_KEY = os.environ.get("STRIPE_PUBLIC_KEY", "")
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
OXAPAY_API_KEY = os.environ.get("OXAPAY_API_KEY", "LOKABU-FCAQNE-1VJTG1-SK7WYX")
OXAPAY_BASE = os.environ.get("OXAPAY_BASE", "https://api.oxapay.com/v1")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8652772452:AAEHaR639Er5VlQHEKZCQ7xYaQdWav7-cGo")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "")

PRICING = {
    "monthly": {"name": "Mensuel", "price": 9.99, "requests_per_day": 50, "stripe_price_id": ""},
    "yearly": {"name": "Annuel", "price": 79.99, "requests_per_day": 200, "stripe_price_id": ""},
    "lifetime": {"name": "VIP À Vie", "price": 199.99, "requests_per_day": 999999, "requests_label": "Illimité", "stripe_price_id": ""},
}

FREE_REQUESTS_PER_DAY = 3
