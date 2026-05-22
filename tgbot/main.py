import asyncio
import logging
import random
import sys
import aiomysql
import aiosmtplib
from aiogram import Bot, Dispatcher, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message
from email.mime.text import MIMEText

DB_CONFIG = {
    "host": "10.230.101.47",
    "port": 3306,
    "user": "glpi",
    "password": "glpi_password",
    "db": "glpi",
    "charset": "utf8mb4",
    "autocommit": True
}
BOT_TOKEN = "8978556644:AAHAIM60gPqv4usJ1usvvcjcUiwGyqSJ0eE"
PROXY_URL = "socks5://kDZwvW:nvE8AF@45.130.131.24:8000"

SMTP_HOST = "smtp.yandex.ru"
SMTP_PORT = 465
SMTP_USER = "egor3mel@yandex.ru"
SMTP_PASS = "flvvfyvzjnyhixju"

router = Router()
authorized_users = set()


class AuthStates(StatesGroup):
    waiting_for_login = State()
    waiting_for_code = State()


async def get_user_email_by_login(login: str) -> str | None:
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor(aiomysql.DictCursor) as cursor:
                sql = """
                    SELECT u.id, u.name, ue.email
                    FROM glpi_users u
                    LEFT JOIN glpi_useremails ue 
                        ON u.id = ue.users_id AND ue.is_default = 1
                    WHERE u.is_active = 1 
                      AND (u.name = %s OR ue.email = %s)
                    LIMIT 1
                """
                await cursor.execute(sql, (login, login))
                result = await cursor.fetchone()
                
                if result:
                    logging.info(f"Найден пользователь: {result['name']} (ID: {result['id']}, Email: {result['email']})")
                    return result.get('email')
                
                logging.warning(f"Пользователь '{login}' не найден в БД")
                return None
        finally:
            conn.close()
            
    except Exception as e:
        logging.error(f"Ошибка при работе с БД: {e}")
        return None


async def send_verification_email(to_email: str, code: int) -> None:
    msg = MIMEText(
        f"Ваш код подтверждения для Telegram-бота инженеров GLPI: {code}",
        "plain",
        "utf-8"
    )
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
        await message.answer(f"Приветствую, {message.from_user.full_name}! Вы уже авторизованы.")
        return

    await state.set_state(AuthStates.waiting_for_login)
    await message.answer(
        f"Здравствуйте, {message.from_user.full_name}! Я бот техподдержки GLPI.\n"
        f"Введите ваш логин в системе для отправки одноразового кода:"
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
            f"Логин подтвержден!\n"
            f"Код безопасности отправлен на почту {masked_email}.\n"
            f"Введите полученный 6-значный код:"
        )

    except Exception as e:
        logging.error(f"Ошибка отправки почты: {e}")
        await status_msg.edit_text(
            "Не удалось отправить письмо с кодом. Пожалуйста, обратитесь к администратору или нажмите /start."
        )
        await state.clear()


@router.message(AuthStates.waiting_for_code)
async def process_code(message: Message, state: FSMContext) -> None:
    user_input_code = message.text.strip()
    user_data = await state.get_data()
    
    if user_input_code == str(user_data.get("code")):
        authorized_users.add(message.from_user.id)
        await message.answer(
            f"Авторизация успешно завершена для {user_data.get('email')}! Доступ открыт."
        )
        await state.clear()
    else:
        await message.answer("Неверный код доступа. Попробуйте ввести еще раз или сбросьте процесс командой /start.")


@router.message()
async def main_handler(message: Message) -> None:
    if message.from_user.id not in authorized_users:
        await message.answer("Доступ заблокирован. Пожалуйста, пройдите авторизацию с помощью команды /start.")
        return

    await message.answer(f"Ваш запрос обрабатывается: {message.text}")


async def main() -> None:
    session = AiohttpSession(proxy=PROXY_URL)
    bot = Bot(
        token=BOT_TOKEN,
        session=session
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
