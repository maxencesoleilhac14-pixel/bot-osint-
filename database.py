from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import secrets

db = SQLAlchemy()

class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    is_active = db.Column(db.Boolean, default=True)
    is_banned = db.Column(db.Boolean, default=False)
    status = db.Column(db.String(20), default="actif")
    api_key = db.Column(db.String(64), unique=True, default=lambda: secrets.token_hex(32))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)
    display_name = db.Column(db.String(80), nullable=True)
    bio = db.Column(db.String(280), nullable=True)
    reg_ip = db.Column(db.String(45), nullable=True)
    reg_user_agent = db.Column(db.String(512), nullable=True)
    reg_headers = db.Column(db.Text, nullable=True)
    last_ip = db.Column(db.String(45), nullable=True)
    telegram_id = db.Column(db.String(64), nullable=True, unique=True)
    telegram_username = db.Column(db.String(80), nullable=True)
    telegram_first_name = db.Column(db.String(80), nullable=True)
    telegram_last_name = db.Column(db.String(80), nullable=True)
    telegram_photo_url = db.Column(db.String(512), nullable=True)

    subscription = db.relationship("Subscription", backref="user", uselist=False, lazy=True)
    search_logs = db.relationship("SearchLog", backref="user", lazy="dynamic")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def has_active_subscription(self):
        if self.is_admin:
            return True
        if self.subscription and self.subscription.is_active:
            return True
        return False

    def get_daily_quota(self):
        if self.is_admin:
            return 999999
        if self.subscription and self.subscription.is_active:
            return self.subscription.requests_per_day
        return 3

    def get_today_usage(self):
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        return SearchLog.query.filter(
            SearchLog.user_id == self.id,
            SearchLog.created_at >= today_start
        ).count()

    def get_remaining_requests(self):
        return self.get_daily_quota() - self.get_today_usage()

class Subscription(db.Model):
    __tablename__ = "subscriptions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=False)
    plan = db.Column(db.String(20), nullable=False)
    requests_per_day = db.Column(db.Integer, default=50)
    start_date = db.Column(db.DateTime, default=datetime.utcnow)
    end_date = db.Column(db.DateTime, nullable=True)
    is_active = db.Column(db.Boolean, default=False)
    payment_method = db.Column(db.String(50), nullable=True)
    payment_status = db.Column(db.String(20), default="pending")
    payment_proof = db.Column(db.String(256), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @property
    def is_expired(self):
        if self.end_date is None:
            return False
        return datetime.utcnow() > self.end_date

    @property
    def days_remaining(self):
        if self.end_date is None:
            return 9999
        remaining = (self.end_date - datetime.utcnow()).days
        return max(0, remaining)

class SearchLog(db.Model):
    __tablename__ = "search_logs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    query_type = db.Column(db.String(20), nullable=False)
    query_data = db.Column(db.Text, nullable=True)
    results_count = db.Column(db.Integer, default=0)
    response_time_ms = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class PaymentProof(db.Model):
    __tablename__ = "payment_proofs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    plan = db.Column(db.String(20), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    filename = db.Column(db.String(256), nullable=False)
    status = db.Column(db.String(20), default="pending")
    notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship("User", backref="payment_proofs")
