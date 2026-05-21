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
GLPI_API_URL = "http://10.230.101.47/api.php/v2.2"


SMTP_HOST = "smtp.yandex.ru"          
SMTP_PORT = 465                       
SMTP_USER = "@yandex.ru"
SMTP_PASS = ""

router = Router()
authorized_users = set()

class AuthStates(StatesGroup):
    waiting_for_login = State()
    waiting_for_code = State()

async def get_user_email_by_login(login: str) -> str | None:
    headers = {
        "App-Token": GLPI_APP_TOKEN,
        "Authorization": f"user_token {GLPI_SERVICE_USER_TOKEN}",
        "Content-Type": "application/json"
    }
    
    transport = httpx.AsyncHTTPTransport(verify=False)
    async with httpx.AsyncClient(transport=transport) as client:
        try:
            init_res = await client.get(f"{GLPI_API_URL}/initSession", headers=headers)
            if init_res.status_code != 200:
                logging.error(f"Не удалось инициализировать сессию сервисного аккаунта: {init_res.text}")
                return None
                
            session_token = init_res.json().get("session_token")
            
            session_headers = {
                "App-Token": GLPI_APP_TOKEN,
                "Session-Token": session_token,
                "Content-Type": "application/json"
            }
            
            search_url = f"{GLPI_API_URL}/search/User?criteria[0][field]=1&criteria[0][searchtype]=equals&criteria[0][value]={login}"
            search_res = await client.get(search_url, headers=session_headers)
            
            email = None
            if search_res.status_code == 200:
                search_data = search_res.json()
                if search_data.get("totalcount", 0) > 0 and "data" in search_data:
                    user_id = search_data["data"][0].get("1")
                    
                    if user_id:
                        user_res = await client.get(f"{GLPI_API_URL}/User/{user_id}", headers=session_headers)
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
    bot = Bot(token=TOKEN, default_bot_properties=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    asyncio.run(main())
