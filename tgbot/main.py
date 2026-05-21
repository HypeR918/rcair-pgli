import asyncio
import logging
import random
import sys
import httpx
from aiogram import Bot, Dispatcher, html, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message
import aiosmtplib
from email.mime.text import MIMEText

TOKEN = "8978556644:AAHAIM60gPqv4usJ1usvvcjcUiwGyqSJ0eE"
GLPI_APP_TOKEN = "n5Q4RhQnT18YfFWzuOr4FulsgAJDloFMZ2Xllvuu"
GLPI_API_URL = "http://10.230.101.47"

SMTP_HOST = "smtp.yandex.ru"          
SMTP_PORT = 465                       
SMTP_USER = "@yandex.ru"
SMTP_PASS = ""

router = Router()
authorized_users = set()

class AuthStates(StatesGroup):
    waiting_for_login = State()
    waiting_for_password = State()
    waiting_for_code = State()

async def authenticate_and_get_email(login: str, password: str) -> str | None:
    headers = {
        "App-Token": GLPI_APP_TOKEN,
        "Content-Type": "application/json"
    }
    transport = httpx.AsyncHTTPTransport(verify=False)
    async with httpx.AsyncClient(transport=transport) as client:
        try:
            init_res = await client.get(
                f"{GLPI_API_URL}/initSession", 
                headers=headers, 
                auth=(login, password)
            )
            if init_res.status_code != 200:
                return None
                
            session_token = init_res.json().get("session_token")
            
            session_headers = {
                "App-Token": GLPI_APP_TOKEN,
                "Session-Token": session_token,
                "Content-Type": "application/json"
            }
            
            user_res = await client.get(f"{GLPI_API_URL}/User/me", headers=session_headers)
            email = None
            
            if user_res.status_code == 200:
                user_data = user_res.json()
                emails = user_data.get("_emails", [])
                if isinstance(emails, list) and len(emails) > 0:
                    email = emails[0].get("email")
                elif isinstance(emails, dict):
                    email = emails.get("email")
            
            await client.get(f"{GLPI_API_URL}/killSession", headers=session_headers)
            return email
            
        except Exception as e:
            logging.error(f"GLPI API Error: {e}")
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
        f"Здравствуйте, {html.bold(message.from_user.full_name)}! Я бот для инженеров.\n"
        f"Для продолжения введите ваш {html.bold('логин')} от учетной записи GLPI:"
    )

@router.message(AuthStates.waiting_for_login)
async def process_login(message: Message, state: FSMContext) -> None:
    login = message.text.strip()
    if not login:
        await message.answer("Логин не может быть пустым. Введите корректный логин:")
        return
    await state.update_data(login=login)
    await state.set_state(AuthStates.waiting_for_password)
    await message.answer("Отлично. Теперь введите ваш метод авторизации ({html.bold('пароль')}):")

@router.message(AuthStates.waiting_for_password)
async def process_password(message: Message, state: FSMContext) -> None:
    password = message.text.strip()
    
    try:
        await message.delete()
    except Exception as e:
        logging.warning(f"Не удалось удалить сообщение с паролем: {e}")

    if not password:
        await message.answer("Пароль не может быть пустым. Пожалуйста, введите пароль:")
        return

    user_data = await state.get_data()
    login = user_data.get("login")

    status_msg = await message.answer("Проверяю учетные данные в системе GLPI...")
    
    email = await authenticate_and_get_email(login, password)
    if not email:
        await status_msg.edit_text("Неверный логин или пароль, либо у аккаунта отсутствует email в GLPI. Нажмите /start для повторной попытки.")
        await state.clear()
        return

    verification_code = random.randint(100000, 999999)
    await state.update_data(email=email, code=verification_code)
    
    try:
        await send_verification_email(email, verification_code)
        await state.set_state(AuthStates.waiting_for_code)
        masked_email = f"{email[:3]}***{email[email.find('@'):]}"
        await status_msg.edit_text(f"Успешно! Ваше сообщение с паролем удалено из чата.\nКод отправлен на вашу рабочую почту {html.code(masked_email)}. Введите 6-значный код подтверждения:")
    except Exception as e:
        logging.error(f"Ошибка отправки почты: {e}")
        await status_msg.edit_text("Произошла ошибка при отправке письма. Нажмите /start для повторной попытки.")
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
        await message.answer(f"Авторизация успешна для аккаунта {html.code(email)}! Все функции доступны.")
        await state.clear() 
    else:
        await message.answer("Неверный код. Попробуйте еще раз или введите команду /start заново.")

@router.message()
async def main_handler(message: Message) -> None:
    user_id = message.from_user.id
    if user_id not in authorized_users:
        await message.answer("Доступ ограничен. Наберите команду /start и пройдите авторизацию.")
        return
    await message.answer(f"Принято сообщение: {message.text}")

async def main() -> None:
    bot = Bot(token=TOKEN, default_bot_properties=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    asyncio.run(main())
