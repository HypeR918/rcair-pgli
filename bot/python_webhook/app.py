"""Минимальная реализация MAX webhook для сравнения с Node.js."""

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import re
import sys
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, web
from maxapi import Bot
from maxapi.client.default import DefaultConnectionProperties
from maxapi.types import CallbackButton
from maxapi.utils.inline_keyboard import InlineKeyboardBuilder

TYPES = ("message_created", "message_callback", "bot_started")
LOG = logging.getLogger("python_webhook")


class BadEvent(Exception):
    """Ошибка входящего JSON, не ошибка исходящего SDK."""


@dataclass(frozen=True)
class Config:
    token: str = field(repr=False)
    secret: str = field(repr=False)
    url: str
    port: int = 3000
    timeout: float = 30.0

    def __post_init__(self):
        url = urlsplit(self.url)
        if not self.token or not re.fullmatch(r"[\x21-\x7e]{5,256}", self.secret):
            raise ValueError("Нужны BOT_TOKEN и WEBHOOK_SECRET (5–256 ASCII без пробелов)")
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or not url.path or url.path in {"/health", "/diagnostics"}):
            raise ValueError("WEBHOOK_URL должен быть HTTPS URL callback без query и учётных данных")
        if not 1 <= self.port <= 65535 or not math.isfinite(self.timeout) or not 0 < self.timeout <= 300:
            raise ValueError("Недопустимый порт или таймаут MAX")

    @classmethod
    def from_env(cls, env):
        if env.get("BOT_TRANSPORT", "webhook").strip().lower() != "webhook":
            raise ValueError("Python-вариант поддерживает только webhook")
        return cls(token=env.get("BOT_TOKEN", ""), secret=env.get("WEBHOOK_SECRET", ""),
                   url=env.get("WEBHOOK_URL", "").strip(), port=int(env.get("PORT", "3000")),
                   timeout=float(env.get("PYTHON_MAX_TIMEOUT_SECONDS", "30")))


class WebhookBot(Bot):
    async def get_updates(self, *args, **kwargs):
        raise RuntimeError("Получение /updates запрещено: используется только webhook")


class Runtime:
    def __init__(self, config, api_url):
        self.config = config
        self.bot = WebhookBot(
            config.token, auto_requests=False, after_upload_attempts=1,
            default_connection=DefaultConnectionProperties(
                timeout=config.timeout, max_retries=0, trust_env=True,
            ),
        )
        self.bot.set_api_url(api_url)
        self.ready = False
        self.instance = str(uuid.uuid4())
        self.started = time.monotonic()
        self.counts = dict.fromkeys(("received", "authorized", "processed", "duplicate", "ignored", "rejected", "failed"), 0)
        self.types = dict.fromkeys((*TYPES, "unsupported"), 0)
        self.replies = dict.fromkeys(("attempted", "confirmed", "failed"), 0)
        self.active = {}
        self.recent = deque(maxlen=20)
        self.inflight = {}
        self.completed = OrderedDict()

    async def lifespan(self, app):
        try:
            try:
                async with asyncio.timeout(self.config.timeout * 2):
                    me = await self.bot.get_me()
                    subs = await self.bot.get_subscriptions()
            except Exception as error:
                raise RuntimeError(f"MAX API при старте: {type(error).__name__}") from None
            if (len(subs.subscriptions) != 1 or subs.subscriptions[0].url != self.config.url
                    or not set(TYPES).issubset(subs.subscriptions[0].update_types or [])):
                raise RuntimeError("Ожидается одна действующая подписка на WEBHOOK_URL и три события")
            self.ready = True
            LOG.info("Python webhook готов, бот=%s; подписка сохранена", me.username)
            yield
        finally:
            self.ready = False
            tasks = list(self.inflight.values())
            if tasks:
                _, pending = await asyncio.wait(tasks, timeout=15)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            await self.bot.close_session()

    def snapshot(self):
        now = time.monotonic()
        oldest = min((entry["started"] for entry in self.active.values()), default=now)
        return {
            **self.counts, "types": dict(self.types), "replies": dict(self.replies),
            "implementation": "python-minimal", "instance_id": self.instance, "ready": self.ready,
            "active": len(self.active), "oldest_active_ms": int((now - oldest) * 1000),
            "uptime_ms": int((now - self.started) * 1000), "recent_events": list(self.recent),
        }

    async def health(self, request):
        return web.json_response({"ok": self.ready, "service": "max-bot", "transport": "webhook",
                                  "implementation": "python-minimal"}, status=200 if self.ready else 503)

    async def diagnostics(self, request):
        return web.json_response(self.snapshot())

    @staticmethod
    def target(update):
        message = update.get("message") or {}
        user = (update.get("callback") or {}).get("user") or update.get("user") or message.get("sender") or {}
        if user.get("is_bot"):
            return None
        user_id = user.get("user_id")
        if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
            raise BadEvent("В событии нет пользователя")
        recipient = message.get("recipient") or {}
        if recipient.get("chat_type") not in (None, "dialog"):
            return None
        chat_id = update.get("chat_id", recipient.get("chat_id"))
        return {"chat_id": chat_id} if isinstance(chat_id, int) and not isinstance(chat_id, bool) else {"user_id": user_id}

    async def dispatch(self, update, entry):
        target = self.target(update)
        if target is None:
            return "ignored"
        kind = update["update_type"]
        message = update.get("message") or {}
        identity = ((message.get("body") or {}).get("mid") if kind == "message_created"
                    else (update.get("callback") or {}).get("callback_id") if kind == "message_callback"
                    else [update.get("timestamp"), update.get("chat_id"), update.get("user"), update.get("payload")])
        key = hashlib.sha256(json.dumps([kind, identity if identity else uuid.uuid4().hex], sort_keys=True).encode()).hexdigest()
        now = time.monotonic()
        while self.completed and next(iter(self.completed.values())) < now - 600:
            self.completed.popitem(last=False)
        if key in self.completed:
            return "duplicate"
        if key in self.inflight:
            await asyncio.shield(self.inflight[key])
            return "duplicate"

        async def send():
            try:
                text = "Бот отвечает. Сейчас включён тестовый режим."
                if kind == "message_callback":
                    text = "Кнопка работает. Сейчас включён тестовый режим."
                keyboard = InlineKeyboardBuilder()
                keyboard.row(CallbackButton(text="Проверить ответ", payload="python:ping"))
                entry["replies"]["attempted"] += 1
                self.replies["attempted"] += 1
                LOG.info("[PYTHON_WEBHOOK] %s", json.dumps({"event": entry["event"], "stage": "send"}))
                try:
                    async with asyncio.timeout(self.config.timeout):
                        reply = await self.bot.send_message(text=text, attachments=[keyboard.as_markup()], **target)
                    if not reply or not reply.message or not reply.message.body or not reply.message.body.mid:
                        raise RuntimeError("MAX не подтвердил отправку")
                except Exception:
                    entry["replies"]["failed"] += 1
                    self.replies["failed"] += 1
                    raise
                entry["replies"]["confirmed"] += 1
                self.replies["confirmed"] += 1
                self.completed[key] = time.monotonic()
                if len(self.completed) > 10000:
                    self.completed.popitem(last=False)
            finally:
                self.inflight.pop(key, None)

        task = asyncio.create_task(send())
        self.inflight[key] = task
        await asyncio.shield(task)
        return "processed"

    async def callback(self, request):
        self.counts["received"] += 1
        event = self.counts["received"]
        entry = {"event": event, "started": time.monotonic(), "replies": dict.fromkeys(self.replies, 0)}
        self.active[event] = entry
        status, result, kind, error_code = 200, "ignored", None, None
        LOG.info("[PYTHON_WEBHOOK] %s", json.dumps({"event": event, "stage": "request"}))
        try:
            if not hmac.compare_digest(request.headers.get("X-Max-Bot-Api-Secret", "").encode(), self.config.secret.encode()):
                status, result = 403, "rejected"
                return web.json_response({"ok": False}, status=status)
            self.counts["authorized"] += 1
            if not self.ready:
                status, result = 503, "rejected"
                return web.json_response({"ok": False}, status=status)
            if request.content_type != "application/json":
                status = 415
                return web.json_response({"ok": False}, status=status)
            try:
                update = await request.json()
            except (ValueError, UnicodeDecodeError) as error:
                raise BadEvent("Некорректный JSON") from error
            if (not isinstance(update, dict) or not isinstance(update.get("update_type"), str)
                    or type(update.get("timestamp")) not in (int, float) or not math.isfinite(update["timestamp"])):
                raise BadEvent("Некорректное событие")
            kind = update["update_type"] if update["update_type"] in TYPES else "unsupported"
            self.types[kind] += 1
            if kind in TYPES:
                result = await self.dispatch(update, entry)
            body = {"ok": True}
            if update["update_type"] == "diagnostic_probe" and re.fullmatch(r"[a-f0-9-]{36}", str(update.get("probe_id", ""))):
                body.update(probe_id=update["probe_id"], instance_id=self.instance)
            return web.json_response(body)
        except web.HTTPRequestEntityTooLarge:
            status = 413
        except BadEvent:
            status = 400
        except Exception as error:
            status = 500
            # Исключение SDK может содержать ответ MAX: выводим только имя класса.
            error_code = type(error).__name__
        finally:
            duration = int((time.monotonic() - entry["started"]) * 1000)
            self.active.pop(event, None)
            outcome = result if result == "rejected" or status < 400 else "failed"
            self.counts[outcome] += 1
            summary = {"event": event, "type": kind, "status": status, "result": outcome,
                       "duration_ms": duration, "replies": entry["replies"]}
            if error_code:
                summary["error"] = error_code
            if kind in TYPES:
                self.recent.append(summary)
            LOG.info("[PYTHON_WEBHOOK] %s", json.dumps(summary))
        return web.json_response({"ok": False}, status=status)


def create_app(config, *, api_url="https://platform-api2.max.ru"):
    runtime = Runtime(config, api_url)
    app = web.Application(client_max_size=1024 * 1024)
    app.cleanup_ctx.append(runtime.lifespan)
    app.router.add_get("/health", runtime.health)
    app.router.add_get("/diagnostics", runtime.diagnostics)
    app.router.add_post(urlsplit(config.url).path, runtime.callback)
    return app


async def diagnose(port):
    async with ClientSession(timeout=ClientTimeout(total=5), trust_env=False) as session:
        async with session.get(f"http://127.0.0.1:{port}/diagnostics") as response:
            response.raise_for_status()
            data = await response.json()
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if sys.argv[1:] == ["diagnose"]:
            asyncio.run(diagnose(int(os.environ.get("PORT", "3000"))))
        elif sys.argv[1:]:
            raise ValueError("Использование: python app.py [diagnose]")
        else:
            config = Config.from_env(os.environ)
            web.run_app(create_app(config), host="0.0.0.0", port=config.port, access_log=None, print=None, shutdown_timeout=15)
    except Exception as error:
        # Не печатаем repr/str SDK-исключений, где могут быть данные ответа.
        LOG.error("Python webhook не запущен: %s", type(error).__name__)
        sys.exit(1)
