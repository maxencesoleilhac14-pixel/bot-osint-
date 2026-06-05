import threading

def post_worker_init(worker):
    from app import bot_poll, init_db
    init_db()
    t = threading.Thread(target=bot_poll, daemon=True)
    t.start()
    worker.log.info("Bot polling thread started")
