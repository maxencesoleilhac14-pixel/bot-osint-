import os
import sys
import gunicorn.app.wsgiapp

if __name__ == "__main__":
    port = os.environ.get("PORT", "8080")
    from app import init_db, set_webhook
    init_db()
    set_webhook()
    sys.argv = ["gunicorn", "app:app",
                "--bind", f"0.0.0.0:{port}",
                "--workers", "1", "--timeout", "120"]
    gunicorn.app.wsgiapp.run()
