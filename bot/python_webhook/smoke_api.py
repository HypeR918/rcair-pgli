"""Локальный HTTPS MAX API только для Docker smoke; в рабочий образ не копируется."""
import ssl
from aiohttp import web

state = {"mode": "normal", "calls": []}


async def handle(request):
    if request.path == "/mode":
        state["mode"] = (await request.json())["mode"]
        return web.json_response({"ok": True})
    if request.path == "/stats":
        return web.json_response({"calls": state["calls"]})
    state["calls"].append([request.method, request.path])
    if request.path == "/me":
        return web.json_response({"user_id": 999, "first_name": "Тест", "is_bot": True,
                                  "last_activity_time": 1, "username": "offline_bot"})
    if request.path == "/subscriptions" and request.method == "GET":
        return web.json_response({"subscriptions": [{"url": "https://botsupport.gov70.ru/max/callback/",
                                  "time": 1, "update_types": ["message_created", "message_callback", "bot_started"]}]})
    if request.path == "/messages" and request.method == "POST":
        import asyncio
        body = await request.json()
        if state["mode"] == "hang":
            await asyncio.sleep(1)
        return web.json_response({"message": {"recipient": {"chat_id": 456, "chat_type": "dialog"},
                                  "timestamp": 1, "body": {"mid": "reply.mid", "seq": 1, "text": body["text"]}}})
    return web.json_response({"code": "unexpected"}, status=500)


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/test-ca.pem", "/test-key.pem")
app = web.Application()
app.router.add_route("*", "/{path:.*}", handle)
web.run_app(app, host="0.0.0.0", port=3001, ssl_context=context, access_log=None)
