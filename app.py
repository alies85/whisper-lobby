# app.py
from flask import Flask, send_from_directory, render_template
import os

app = Flask(__name__)

# --- تنظیمات تو ---
BASE_PATH = '/lobby'
HOST = '0.0.0.0'
PORT = 443
CERT_FILE = '/home/ubuntu/fullchain.pem'
KEY_FILE = '/home/ubuntu/privkey.pem'

# --- چک کردن وجود فایل‌ها ---
if not os.path.exists(CERT_FILE):
    raise FileNotFoundError(f"گواهی پیدا نشد: {CERT_FILE}")
if not os.path.exists(KEY_FILE):
    raise FileNotFoundError(f"کلید پیدا نشد: {KEY_FILE}")
if not os.path.exists('index.html'):
    raise FileNotFoundError("index.html در فولدر اصلی پیدا نشد!")

# --- صفحه اصلی (ریدایرکت به /myapp) ---
@app.route('/')
def root():
    return f'''
    <h3>سرور فعال است</h3>
    <a href="{BASE_PATH}/">برو به {BASE_PATH}</a>
    '''

# --- serve کردن index.html در /myapp ---
@app.route(f'{BASE_PATH}/')
def index():
    return send_from_directory('.', 'index.html')

# --- serve کردن بقیه فایل‌ها (CSS, JS, تصاویر و ...) ---
@app.route(f'{BASE_PATH}/<path:filename>')
def serve_static(filename):
    return send_from_directory('.', filename)

# --- اجرا ---
if __name__ == '__main__':
    print(f"سرور HTTPS در حال اجراست...")
    print(f"آدرس: https://سرور-شما:{PORT}{BASE_PATH}/")

    app.run(
        host=HOST,
        port=PORT,
        ssl_context=(CERT_FILE, KEY_FILE),
        threaded=True
    )
