import subprocess
import sys
import os

if __name__ == "__main__":
    port = os.environ.get("PORT", "8080")
    gunicorn = subprocess.Popen(
        [sys.executable, "-m", "gunicorn", "app:app",
         "--bind", f"0.0.0.0:{port}",
         "--workers", "1", "--timeout", "120"]
    )
    bot = subprocess.Popen(
        [sys.executable, "-c",
         "from app import bot_poll, init_db; init_db(); bot_poll()"]
    )
    exit_code = gunicorn.wait()
    bot.terminate()
    sys.exit(exit_code)
