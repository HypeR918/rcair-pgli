import asyncio
import json
import logging
import random
import sys
import httpx
from aiogram import Bot, Dispatcher, html, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message
import aiosmtplib
from email.mime.text import MIMEText

TOKEN = "8978556644:AAHAIM60gPqv4usJ1usvvcjcUiwGyqSJ0eE"
GLPI_APP_TOKEN = "n5Q4RhQnT18YfFWzuOr4FulsgAJDloFMZ2Xllvuu"
GLPI_SERVICE_USER_TOKEN = "8ApqrbQHepY4OyvxUnqyWA00lHj1OuZ2mcrVAPbQ" 
GLPI_API_URL = "http://10.230.101.47/apirest.php"

SMTP_HOST = "smtp.yandex.ru"          
SMTP_PORT = 465                       
SMTP_USER = "@yandex.ru"
SMTP_PASS = ""
PROXY_URL = "socks5://kDZwvW:nvE8AF@45.130.131.24:8000"

router = Router()
authorized_users = set()

class AuthStates(StatesGroup):
    waiting_for_login = State()
    waiting_for_code = State()

async def get_user_email_by_login(login: str) -> str | None:
    headers_init = {
        "App-Token": GLPI_APP_TOKEN,
        "Authorization": f"user_token {GLPI_SERVICE_USER_TOKEN}"
    }
    
    async with httpx.AsyncClient(proxy=None, trust_env=False, verify=False, timeout=10.0) as client:
        try:
            init_res = await client.get(f"{GLPI_API_URL}/initSession", headers=headers_init)
            if init_res.status_code != 200:
                logging.error(f"Ошибка авторизации GLPI: {init_res.status_code} {init_res.text}")
                return None
            
            session_token = init_res.json().get("session_token")
            headers_api = {
                "App-Token": GLPI_APP_TOKEN,
                "Session-Token": session_token,
                "Content-Type": "application/json"
            }
            test_res = await client.get(f"{GLPI_API_URL}/search/User",headers=headers_api,params={"range": "0-10"})
            logging.info("=== ТЕСТ СПИСКА ПОЛЬЗОВАТЕЛЕЙ ===")
            logging.info(test_res.text)
            search_params = {
                "criteria[0][field]": "1",          
                "criteria[0][searchtype]": "contains",
                "criteria[0][value]": login,
                "forcedisplay[0]": "1",             
                "forcedisplay[1]": "5"              
            }

            search_res = await client.get(
                f"{GLPI_API_URL}/search/User",
                headers=headers_api,
                params=search_params
            )

            logging.info("=== РЕЗУЛЬТАТ ПОИСКА ===")
            logging.info(search_res.text)

            search_params = {
                "criteria[0][field]": "1",
                "criteria[0][searchtype]": "equals",
                "criteria[0][value]": login
            }
            search_res = await client.get(
                f"{GLPI_API_URL}/search/User", 
                headers=headers_api, 
                params=search_params
            )
            
            email = None
            if search_res.status_code == 200:
                search_data = search_res.json()
                logging.info(f"--- РЕЗУЛЬТАТ ПОИСКА ПОЛЬЗОВАТЕЛЯ '{login}' ---")
                logging.info(search_data)
                
                if search_data.get("totalcount", 0) > 0 and "data" in search_data:
                    user_item = search_data["data"][0]
                    user_id = user_item.get("2") or user_item.get("id") or user_item.get("1")
                    logging.info(f"Найден ID пользователя: {user_id}")
                    
                    if user_id:
                        user_res = await client.get(
                            f"{GLPI_API_URL}/User/{user_id}", 
                            headers=headers_api,
                            params={"expand_dps": "true"}
                        )
                        
                        if user_res.status_code == 200:
                            user_data = user_res.json()
                            logging.info(f"--- КАРТОЧКА ПОЛЬЗОВАТЕЛЯ ---")
                            logging.info({k: v for k, v in user_data.items() if 'email' in k.lower() or k == 'id' or k == 'name'})
                            
                            emails = user_data.get("_emails", [])
                            if not emails:
                                emails = user_data.get("emails", [])
                                
                            if isinstance(emails, list) and len(emails) > 0:
                                email = emails[0].get("email")
                            elif isinstance(emails, dict):
                                email = emails.get("email")
                            
                            logging.info(f"Найден email: {email}")
            
            await client.get(f"{GLPI_API_URL}/killSession", headers=headers_api)
            return email
            
        except Exception as e:
            logging.error(f"Ошибка при работе с GLPI API: {e}")
            return None

async def send_verification_email(to_email: str, code: int) -> None:
    msg = MIMEText(f"Ваш код подтверждения для Telegram-бота инженеров GLPI: {code}", "plain", "utf-8")
    msg["Subject"] = "Код подтверждения Telegram-бота"
    msg["From"] = SMTP_USER
    msg["To"] = to_email
    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        username=SMTP_USER,
        password=SMTP_PASS,
        use_tls=True
    )

@router.message(Command("start"))
async def command_start_handler(message: Message, state: FSMContext) -> None:
    user_id = message.from_user.id
    if user_id in authorized_users:
        await message.answer(f"Приветствую, {html.bold(message.from_user.full_name)}! Вы уже авторизованы.")
        return
    await state.set_state(AuthStates.waiting_for_login)
    await message.answer(
        f"Здравствуйте, {html.bold(message.from_user.full_name)}! Я бот техподдержки GLPI.\n"
        f"Введите ваш {html.bold('логин')} в системе для отправки одноразового кода:"
    )

@router.message(AuthStates.waiting_for_login)
async def process_login(message: Message, state: FSMContext) -> None:
    login = message.text.strip()
    if not login:
        await message.answer("Логин не может быть пустым. Пожалуйста, введите логин:")
        return
    status_msg = await message.answer("Запрос к GLPI... Проверяю наличие учетной записи.")
    email = await get_user_email_by_login(login)
    if not email:
        await status_msg.edit_text(
            "Не удалось найти пользователя с таким логином или у аккаунта отсутствует рабочий email в GLPI.\n"
            "Проверьте правильность ввода и нажмите /start для новой попытки."
        )
        await state.clear()
        return
    verification_code = random.randint(100000, 999999)
    await state.update_data(login=login, email=email, code=verification_code)
    try:
        await send_verification_email(email, verification_code)
        await state.set_state(AuthStates.waiting_for_code)
        masked_email = f"{email[:3]}***{email[email.find('@'):]}"
        await status_msg.edit_text(
            f"Логин подтвержден!\nКод безопасности отправлен на почту {html.code(masked_email)}.\n"
            f"Введите полученный 6-значный код:"
        )
    except Exception as e:
        logging.error(f"Ошибка отправки почты: {e}")
        await status_msg.edit_text("Не удалось отправить письмо с кодом. Пожалуйста, обратитесь к администратору или нажмите /start.")
        await state.clear()

@router.message(AuthStates.waiting_for_code)
async def process_code(message: Message, state: FSMContext) -> None:
    user_input_code = message.text.strip()
    user_data = await state.get_data()
    correct_code = user_data.get("code")
    email = user_data.get("email")
    if user_input_code == str(correct_code):
        user_id = message.from_user.id
        authorized_users.add(user_id)
        await message.answer(f"Авторизация успешно завершена для {html.code(email)}! Доступ открыт.")
        await state.clear() 
    else:
        await message.answer("Неверный код доступа. Попробуйте ввести еще раз или сбросьте процесс командой /start.")

@router.message()
async def main_handler(message: Message) -> None:
    user_id = message.from_user.id
    if user_id not in authorized_users:
        await message.answer("Доступ заблокирован. Пожалуйста, пройдите авторизацию с помощью команды /start.")
        return
    await message.answer(f"Ваш запрос обрабатывается: {message.text}")

async def main() -> None:
    session = AiohttpSession(proxy=PROXY_URL)
    bot = Bot(
        token=TOKEN, 
        session=session,
        default_bot_properties=DefaultBotProperties(parse_mode=ParseMode.HTML)
    )
    dp = Dispatcher()
    dp.include_router(router)
    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    asyncio.run(main())
