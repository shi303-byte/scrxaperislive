"""A small Scrxaper bot using only the Python standard library.

Create a bot under Bots in Scrxaper, add it to a group (admins can do this by
username) or message it directly, then run:

    SCRXAPER_URL=https://your-app.onrender.com \
    BOT_TOKEN=bot_... WEBHOOK_SECRET=... PORT=8081 python3 bots/scrxaper_bot.py

and set the bot's webhook to https://<where this runs>/ in Scrxaper.
Commands: !help  !ping  !roll [sides]  !time
"""
import hashlib
import hmac
import json
import os
import random
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE_URL = os.environ.get("SCRXAPER_URL", "http://localhost:3000").rstrip("/")
TOKEN = os.environ["BOT_TOKEN"]
SECRET = os.environ["WEBHOOK_SECRET"].encode()
PORT = int(os.environ.get("PORT", "8081"))

HELP = "Commands: !help, !ping, !roll [sides], !time"


def reply_text(command, args):
    if command == "!help":
        return HELP
    if command == "!ping":
        return "pong"
    if command == "!roll":
        sides = int(args[0]) if args and args[0].isdigit() and 2 <= int(args[0]) <= 1000 else 6
        return f"Rolled a {random.randint(1, sides)} (1-{sides})"
    if command == "!time":
        return time.strftime("It is %H:%M:%S UTC", time.gmtime())
    return None


def send(path, payload):
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bot {TOKEN}"},
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except urllib.error.HTTPError as err:
        print(f"send failed: {err.code} {err.read()[:200]!r}", flush=True)


def handle_event(event):
    if event.get("type") != "message":
        return
    parts = str(event.get("body", "")).strip().split()
    answer = reply_text(parts[0].lower(), parts[1:]) if parts else None
    if not answer:
        return
    if event.get("scope") == "group":
        send("/api/group-messages", {"group": event["group"], "body": answer})
    else:
        send("/api/messages", {"to": event["from"], "body": answer})


class Webhook(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, self.headers.get("X-Scrxaper-Signature", "")):
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()
        handle_event(json.loads(raw))

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Scrxaper bot listening on :{PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Webhook).serve_forever()
