"""Настоящие HTTP и maxapi, только внешняя платформа MAX заменена локально."""

import asyncio
import io
import json
import unittest
from dataclasses import replace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from app import Config, create_app


class WebhookTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.mode = "normal"
        self.sent = asyncio.Event()
        self.config = Config(
            token="offline-token", secret="offline-secret",
            url="https://botsupport.gov70.ru/max/callback/", timeout=0.1,
        )
        api = web.Application()
        api.router.add_route("*", "/{path:.*}", self.max_api)
        self.api = TestServer(api)
        await self.api.start_server()
        self.client = TestClient(TestServer(create_app(self.config, api_url=str(self.api.make_url("")))))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.api.close()

    async def max_api(self, request):
        body = await request.json() if request.can_read_body else None
        self.calls.append((request.method, request.path, dict(request.query), body))
        if request.path == "/me":
            return web.json_response({
                "user_id": 999, "first_name": "Тест", "is_bot": True,
                "last_activity_time": 1, "username": "offline_bot",
            })
        if request.path == "/subscriptions":
            return web.json_response({"subscriptions": [{
                "url": self.config.url, "time": 1,
                "update_types": ["message_created", "message_callback", "bot_started"],
            }]})
        if request.path != "/messages" or request.method != "POST":
            return web.json_response({"code": "unexpected"}, status=500)
        self.sent.set()
        if self.mode == "fail":
            return web.json_response({"code": "offline.failure", "message": "private response"}, status=503)
        if self.mode == "unconfirmed":
            return web.json_response({"success": False})
        if self.mode == "hang" or (self.mode == "hang-first" and len(self.sends()) == 1):
            await asyncio.sleep(0.25)
        return web.json_response({"message": {
            "recipient": {"chat_id": 456, "chat_type": "dialog"}, "timestamp": 1,
            "body": {"mid": "reply.mid", "seq": 1, "text": body["text"]},
        }})

    def message(self, mid="test.mid", text="/start"):
        return {
            "update_type": "message_created", "timestamp": 1,
            "message": {
                "sender": {"user_id": 123, "is_bot": False},
                "recipient": {"chat_id": 456, "chat_type": "dialog"},
                "body": {"mid": mid, "text": text, "attachments": None},
            },
        }

    async def deliver(self, update=None, secret="offline-secret"):
        return await self.client.post("/max/callback/", json=update or self.message(), headers={
            "X-Max-Bot-Api-Secret": secret,
        })

    async def diagnostics(self):
        return await (await self.client.get("/diagnostics")).json()

    def sends(self):
        return [call for call in self.calls if call[1] == "/messages"]

    async def test_start_menu_text_and_button_use_real_python_sdk(self):
        for i, text in enumerate(["/start", "/menu", "Проверка"]):
            response = await self.deliver(self.message(f"mid.{i}", text))
            self.assertEqual(response.status, 200)
        self.assertEqual(len(self.sends()), 3)
        self.assertTrue(self.sends()[0][3]["attachments"])
        self.assertEqual(self.sends()[0][2]["chat_id"], "456")
        diag = await self.diagnostics()
        self.assertEqual(diag["replies"], {"attempted": 3, "confirmed": 3, "failed": 0})
        self.assertEqual(diag["implementation"], "python-minimal")
        self.assertTrue((await (await self.client.get("/health")).json())["ok"])
        self.assertTrue(all(call[1] in {"/me", "/subscriptions", "/messages"} for call in self.calls))
        self.assertEqual([call[0] for call in self.calls if call[1] == "/subscriptions"], ["GET"])

    async def test_callback_without_message_and_bot_started(self):
        callback = {"update_type": "message_callback", "timestamp": 1, "message": None,
                    "callback": {"callback_id": "cb.1", "payload": "python:ping", "user": {"user_id": 123}}}
        self.assertEqual((await self.deliver(callback)).status, 200)
        self.assertEqual(self.sends()[0][2]["user_id"], "123")
        self.assertEqual((await self.deliver({"update_type": "bot_started", "timestamp": 2,
                                            "chat_id": 456, "user": {"user_id": 123}})).status, 200)
        self.assertEqual(self.sends()[1][2]["chat_id"], "456")

    async def test_secret_and_body_validation(self):
        self.assertEqual((await self.deliver(secret="wrong")).status, 403)
        self.assertEqual((await self.deliver({"update_type": "message_created"})).status, 400)
        self.assertEqual((await self.client.get("/max/callback/")).status, 405)
        self.assertEqual((await self.client.post("/max/callback/", data="broken", headers={
            "X-Max-Bot-Api-Secret": self.config.secret, "Content-Type": "application/json",
        })).status, 400)
        self.assertEqual((await self.client.post("/max/callback/", data=io.BytesIO(b"x" * (1024 * 1024 + 1)), headers={
            "X-Max-Bot-Api-Secret": self.config.secret, "Content-Type": "application/json",
        })).status, 413)
        self.assertFalse(self.sends())

    async def test_probe_and_bot_messages_do_not_send_replies(self):
        response = await self.deliver({"update_type": "diagnostic_probe", "timestamp": 1,
                                      "probe_id": "123e4567-e89b-42d3-a456-426614174000"})
        body = await response.json()
        self.assertEqual(body["probe_id"], "123e4567-e89b-42d3-a456-426614174000")
        self.assertEqual(body["instance_id"], (await self.diagnostics())["instance_id"])
        update = self.message()
        update["message"]["sender"]["is_bot"] = True
        self.assertEqual((await self.deliver(update)).status, 200)
        self.assertFalse(self.sends())

    async def test_duplicates_and_failed_event_recovery(self):
        self.mode = "fail"
        self.assertEqual((await self.deliver()).status, 500)
        self.assertEqual(len(self.sends()), 1, "SDK не должен автоматически повторять отправку")
        self.mode = "normal"
        self.assertEqual((await self.deliver()).status, 200)
        self.assertEqual((await self.deliver()).status, 200)
        self.assertEqual(len(self.sends()), 2)
        diag = await self.diagnostics()
        self.assertEqual(diag["failed"], 1)
        self.assertEqual(diag["duplicate"], 1)
        self.assertEqual(diag["active"], 0)
        for private in [self.config.token, self.config.secret, "private response", "test.mid"]:
            self.assertNotIn(private, json.dumps(diag))

    async def test_http_timeout_releases_processing_and_next_event_works(self):
        self.mode = "hang"
        self.assertEqual((await self.deliver()).status, 500)
        self.mode = "normal"
        self.assertEqual((await self.deliver(self.message("next.mid"))).status, 200)
        self.assertEqual((await self.diagnostics())["replies"], {"attempted": 2, "confirmed": 1, "failed": 1})

    async def test_unconfirmed_max_reply_fails(self):
        self.mode = "unconfirmed"
        self.assertEqual((await self.deliver()).status, 500)
        self.assertEqual((await self.diagnostics())["replies"]["confirmed"], 0)

    async def test_parallel_duplicate_shares_send_and_other_user_is_not_blocked(self):
        self.mode = "hang-first"
        first = asyncio.create_task(self.deliver())
        await asyncio.wait_for(self.sent.wait(), 1)
        duplicate = asyncio.create_task(self.deliver())
        other = self.message("other.mid")
        other["message"]["sender"]["user_id"] = 321
        self.assertEqual((await self.deliver(other)).status, 200)
        self.assertEqual((await first).status, 500)
        self.assertEqual((await duplicate).status, 500)
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual((await self.diagnostics())["active"], 0)

    async def test_startup_refuses_other_subscription_without_changing_it(self):
        wrong = replace(self.config, url="https://other.example/max/callback/")
        client = TestClient(TestServer(create_app(wrong, api_url=str(self.api.make_url("")))))
        try:
            with self.assertRaisesRegex(RuntimeError, "одна действующая подписка"):
                await client.start_server()
        finally:
            await client.close()
        self.assertTrue(all(call[0] == "GET" for call in self.calls if call[1] == "/subscriptions"))


class ConfigTests(unittest.TestCase):
    def test_env_is_only_read_from_injected_mapping(self):
        config = Config.from_env({"BOT_TOKEN": "offline", "WEBHOOK_SECRET": "offline-secret",
                                  "WEBHOOK_URL": "https://botsupport.gov70.ru/max/callback/"})
        self.assertEqual(config.port, 3000)
        for change in [{"url": "http://example.test/hook"}, {"secret": ""}, {"port": 0}]:
            with self.assertRaises(ValueError):
                replace(config, **change)
        with self.assertRaises(ValueError):
            Config.from_env({"BOT_TRANSPORT": "polling"})


if __name__ == "__main__":
    unittest.main()
