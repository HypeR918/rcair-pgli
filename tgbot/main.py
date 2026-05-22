import asyncio
import logging
import random
import sys
import base64
import mimetypes
from io import BytesIO
import aiomysql
import aiosmtplib
import httpx
from aiogram import Bot, Dispatcher, Router, F
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message, FSInputFile
from email.mime.text import MIMEText

#БД
DB_CONFIG = {
    "host": "10.230.101.47",
    "port": 3306,
    "user": "glpi",
    "password": "glpi_password",
    "db": "glpi",
    "charset": "utf8mb4",
    "autocommit": True
}

#Telegram
BOT_TOKEN = "8978556644:AAHAIM60gPqv4usJ1usvvcjcUiwGyqSJ0eE"
PROXY_URL = "socks5://kDZwvW:nvE8AF@45.130.131.24:8000"

#SMTP
SMTP_HOST = "smtp.yandex.ru"
SMTP_PORT = 465
SMTP_USER = "egor3mel@yandex.ru"
SMTP_PASS = "flvvfyvzjnyhixju"

GLPI_API_URL = "http://10.230.101.47/apirest.php"
GLPI_APP_TOKEN = "n5Q4RhQnT18YfFWzuOr4FulsgAJDloFMZ2Xllvuu"
GLPI_USER_TOKEN = "8ApqrbQHepY4OyvxUnqyWA00lHj1OuZ2mcrVAPbQ"

router = Router()
authorized_users = set()
glpi_sessions = {}


class AuthStates(StatesGroup):
    waiting_for_login = State()
    waiting_for_code = State()


class TicketStates(StatesGroup):
    waiting_for_title = State()
    waiting_for_description = State()
    waiting_for_attachments = State()
    confirming_ticket = State()


async def ensure_telegram_id_column():
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor() as cursor:
                sql = "ALTER TABLE glpi_users ADD COLUMN telegram_id BIGINT DEFAULT NULL"
                try:
                    await cursor.execute(sql)
                    logging.info(" Колонка 'telegram_id' успешно добавлена в таблицу glpi_users.")
                except aiomysql.Error as e:
                    if e.args[0] == 1060:
                        logging.info(" Колонка 'telegram_id' уже существует в БД.")
                    else:
                        logging.error(f" Ошибка при добавлении колонки: {e}")
        finally:
            conn.close()
    except Exception as e:
        logging.error(f" Не удалось подключиться к БД для проверки колонки: {e}")


async def load_authorized_users_from_db():
    global authorized_users
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor() as cursor:
                sql = "SELECT telegram_id FROM glpi_users WHERE telegram_id IS NOT NULL"
                await cursor.execute(sql)
                results = await cursor.fetchall()
                authorized_users = {row[0] for row in results if row[0]}
                logging.info(f" Загружено {len(authorized_users)} авторизованных пользователей из БД.")
        finally:
            conn.close()
    except Exception as e:
        logging.error(f" Ошибка загрузки авторизованных пользователей: {e}")


async def check_and_restore_authorization(telegram_id: int) -> bool:
    if telegram_id in authorized_users:
        return True
    
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor() as cursor:
                sql = "SELECT id FROM glpi_users WHERE telegram_id = %s"
                await cursor.execute(sql, (telegram_id,))
                result = await cursor.fetchone()
                if result:
                    authorized_users.add(telegram_id)
                    logging.info(f" Авторизация восстановлена из БД для Telegram ID {telegram_id}.")
                    return True
        finally:
            conn.close()
    except Exception as e:
        logging.error(f" Ошибка проверки авторизации в БД: {e}")
    return False


async def get_user_info_by_login(login: str) -> dict | None:
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
                    return {"email": result.get('email'), "user_db_id": result.get('id')}
                
                logging.warning(f"Пользователь '{login}' не найден в БД")
                return None
        finally:
            conn.close()
            
    except Exception as e:
        logging.error(f" Ошибка при работе с БД: {e}")
        return None


async def save_telegram_id_to_db(user_db_id: int, telegram_id: int):
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor() as cursor:
                sql = "UPDATE glpi_users SET telegram_id = %s WHERE id = %s"
                await cursor.execute(sql, (telegram_id, user_db_id))
                logging.info(f" Telegram ID {telegram_id} сохранен для пользователя БД {user_db_id}.")
        finally:
            conn.close()
    except Exception as e:
        logging.error(f" Ошибка сохранения Telegram ID в БД: {e}")


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


async def init_glpi_session(telegram_id: int) -> str | None:
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "App-Token": GLPI_APP_TOKEN,
                "Authorization": f"user_token {GLPI_USER_TOKEN}",
                "Content-Type": "application/json"
            }
            response = await client.get(f"{GLPI_API_URL}/initSession", headers=headers)
            
            if response.status_code == 200:
                session_token = response.json().get("session_token")
                glpi_sessions[telegram_id] = session_token
                logging.info(f" Сессия GLPI инициализирована для пользователя {telegram_id}")
                return session_token
            else:
                logging.error(f" Ошибка инициализации сессии GLPI: {response.text}")
                return None
    except Exception as e:
        logging.error(f" Ошибка при инициализации сессии GLPI: {e}")
        return None


async def get_glpi_user_id(telegram_id: int) -> int | None:
    try:
        conn = await aiomysql.connect(**DB_CONFIG)
        try:
            async with conn.cursor() as cursor:
                sql = "SELECT id FROM glpi_users WHERE telegram_id = %s"
                await cursor.execute(sql, (telegram_id,))
                result = await cursor.fetchone()
                return result[0] if result else None
        finally:
            conn.close()
    except Exception as e:
        logging.error(f" Ошибка получения GLPI user ID: {e}")
        return None


async def upload_document_to_glpi(session_token: str, file_data: bytes, filename: str) -> int | None:
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "Session-Token": session_token,
                "App-Token": GLPI_APP_TOKEN
            }
            file_b64 = base64.b64encode(file_data).decode('utf-8')
            mime_type, _ = mimetypes.guess_type(filename)
            if not mime_type:
                mime_type = "application/octet-stream"
            
            data = {
                "input": {
                    "name": filename,
                    "_content": file_b64,
                    "_filename": filename,
                    "mime": mime_type
                }
            }
            
            response = await client.post(
                f"{GLPI_API_URL}/Document",
                headers=headers,
                json=data
            )
            
            if response.status_code in [200, 201]:
                doc_id = response.json().get("id")
                logging.info(f" Документ {filename} загружен в GLPI (ID: {doc_id})")
                return doc_id
            else:
                logging.error(f" Ошибка загрузки документа: {response.text}")
                return None
    except Exception as e:
        logging.error(f" Ошибка при загрузке документа: {e}")
        return None


async def create_glpi_ticket(session_token: str, title: str, description: str, 
                             requester_id: int, document_ids: list[int]) -> int | None:
    try:
        async with httpx.AsyncClient() as client:
            headers = {
                "Session-Token": session_token,
                "App-Token": GLPI_APP_TOKEN,
                "Content-Type": "application/json"
            }
            
            ticket_data = {
                "input": {
                    "name": title,
                    "content": description,
                    "_users_id_requester": requester_id,
                    "status": 1,  
                    "urgency": 3,  
                    "impact": 3,   
                    "priority": 3  
                }
            }
            
            response = await client.post(
                f"{GLPI_API_URL}/Ticket",
                headers=headers,
                json=ticket_data
            )
            
            if response.status_code in [200, 201]:
                ticket_id = response.json().get("id")
                logging.info(f" Заявка создана в GLPI (ID: {ticket_id})")
                if document_ids:
                    for doc_id in document_ids:
                        doc_link_data = {
                            "input": {
                                "documents_id": doc_id,
                                "itemtype": "Ticket",
                                "items_id": ticket_id
                            }
                        }
                        await client.post(
                            f"{GLPI_API_URL}/Document_Item",
                            headers=headers,
                            json=doc_link_data
                        )
                    logging.info(f" К заявке {ticket_id} прикреплено {len(document_ids)} документов")
                
                return ticket_id
            else:
                logging.error(f" Ошибка создания заявки: {response.text}")
                return None
    except Exception as e:
        logging.error(f" Ошибка при создании заявки: {e}")
        return None


@router.message(Command("start"))
async def command_start_handler(message: Message, state: FSMContext) -> None:
    user_id = message.from_user.id

    if await check_and_restore_authorization(user_id):
        await message.answer(
            f"Приветствую, {message.from_user.full_name}! Вы уже авторизованы.\n\n"
            f"Доступные команды:\n"
            f"/new_ticket - Создать новую заявку"
        )
        return

    await state.set_state(AuthStates.waiting_for_login)
    await message.answer(
        f"Здравствуйте, {message.from_user.full_name}! Я бот техподдержки GLPI.\n"
        f"Введите ваш логин в системе для отправки одноразового кода:"
    )


@router.message(Command("new_ticket"))
async def command_new_ticket_handler(message: Message, state: FSMContext) -> None:
    user_id = message.from_user.id

    if not await check_and_restore_authorization(user_id):
        await message.answer("Доступ заблокирован. Пожалуйста, пройдите авторизацию с помощью команды /start.")
        return

    await state.set_state(TicketStates.waiting_for_title)
    await message.answer(
        " Создание новой заявки\n\n"
        "Введите заголовок заявки (краткое описание проблемы):"
    )


@router.message(TicketStates.waiting_for_title)
async def process_ticket_title(message: Message, state: FSMContext) -> None:
    title = message.text.strip()
    
    if not title:
        await message.answer("Заголовок не может быть пустым. Пожалуйста, введите заголовок:")
        return
    
    await state.update_data(title=title)
    await state.set_state(TicketStates.waiting_for_description)
    await message.answer(
        " Заголовок принят!\n\n"
        "Теперь введите подробное описание проблемы:"
    )


@router.message(TicketStates.waiting_for_description)
async def process_ticket_description(message: Message, state: FSMContext) -> None:
    description = message.text.strip()
    
    if not description:
        await message.answer("Описание не может быть пустым. Пожалуйста, введите описание:")
        return
    
    await state.update_data(description=description, attachments=[])
    await state.set_state(TicketStates.waiting_for_attachments)
    await message.answer(
        " Описание принято!\n\n"
        "Теперь вы можете прикрепить файлы (фото, документы) к заявке.\n"
        "Отправьте файлы или напишите 'готово', если вложения не нужны:"
    )


@router.message(TicketStates.waiting_for_attachments, F.text.lower() == "готово")
async def finish_attachments(message: Message, state: FSMContext) -> None:
    await show_ticket_confirmation(message, state)


@router.message(TicketStates.waiting_for_attachments, F.document | F.photo)
async def process_ticket_attachment(message: Message, state: FSMContext) -> None:
    user_data = await state.get_data()
    attachments = user_data.get("attachments", [])
    
    try:
        buffer = BytesIO()
        if message.document:
            await message.bot.download(message.document, destination=buffer)
            filename = message.document.file_name or "document.bin"
        elif message.photo:
            photo = message.photo[-1]
            await message.bot.download(photo, destination=buffer)
            filename = f"photo_{photo.file_unique_id}.jpg"
        else:
            await message.answer("Неподдерживаемый тип файла.")
            return
        
        file_bytes = buffer.getvalue()
        buffer.close()
        
        attachments.append({
            "filename": filename,
            "data": file_bytes
        })
        
        await state.update_data(attachments=attachments)
        await message.answer(
            f" Файл '{filename}' добавлен!\n\n"
            f"Всего прикреплено файлов: {len(attachments)}\n"
            "Отправьте еще файлы или напишите 'готово' для продолжения:"
        )
        
    except Exception as e:
        logging.error(f" Ошибка обработки файла: {e}")
        await message.answer("Произошла ошибка при обработке файла. Попробуйте еще раз.")


@router.message(TicketStates.waiting_for_attachments)
async def invalid_attachment_input(message: Message, state: FSMContext) -> None:
    await message.answer(
        "Пожалуйста, отправьте файл (до 2мб) или напишите 'готово' для продолжения:"
    )


async def show_ticket_confirmation(message: Message, state: FSMContext) -> None:
    user_data = await state.get_data()
    title = user_data.get("title")
    description = user_data.get("description")
    attachments = user_data.get("attachments", [])
    
    confirmation_text = (
        " Проверьте данные заявки:\n\n"
        f"Заголовок: {title}\n\n"
        f"Описание:\n{description}\n\n"
        f"Вложения: {len(attachments)} шт.\n\n"
        "Напишите 'да' для создания заявки или 'отмена' для отмены:"
    )
    
    await state.set_state(TicketStates.confirming_ticket)
    await message.answer(confirmation_text)


@router.message(TicketStates.confirming_ticket, F.text.lower() == "да")
async def confirm_and_create_ticket(message: Message, state: FSMContext) -> None:
    user_id = message.from_user.id
    user_data = await state.get_data()
    
    status_msg = await message.answer(" Создаю заявку в GLPI...")
    
    try:
        session_token = glpi_sessions.get(user_id)
        if not session_token:
            session_token = await init_glpi_session(user_id)
            if not session_token:
                await status_msg.edit_text(" Не удалось подключиться к GLPI. Попробуйте позже.")
                await state.clear()
                return
        
        glpi_user_id = await get_glpi_user_id(user_id)
        if not glpi_user_id:
            await status_msg.edit_text(" Не удалось определить пользователя в GLPI.")
            await state.clear()
            return
        
        document_ids = []
        attachments = user_data.get("attachments", [])
        for attachment in attachments:
            doc_id = await upload_document_to_glpi(
                session_token,
                attachment["data"],
                attachment["filename"]
            )
            if doc_id:
                document_ids.append(doc_id)
        
        ticket_id = await create_glpi_ticket(
            session_token,
            user_data.get("title"),
            user_data.get("description"),
            glpi_user_id,
            document_ids
        )
        
        if ticket_id:
            await status_msg.edit_text(
                f" Заявка успешно создана!\n\n"
                f"Номер заявки: #{ticket_id}\n"
                f"Заголовок: {user_data.get('title')}\n"
                f"Прикреплено файлов: {len(document_ids)}"
            )
        else:
            await status_msg.edit_text(" Не удалось создать заявку. Попробуйте позже.")
        
    except Exception as e:
        logging.error(f" Ошибка при создании заявки: {e}")
        await status_msg.edit_text(" Произошла ошибка при создании заявки.")
    
    await state.clear()


@router.message(TicketStates.confirming_ticket, F.text.lower() == "отмена")
async def cancel_ticket_creation(message: Message, state: FSMContext) -> None:
    await message.answer(" Создание заявки отменено.")
    await state.clear()


@router.message(TicketStates.confirming_ticket)
async def invalid_confirmation_input(message: Message, state: FSMContext) -> None:
    await message.answer("Пожалуйста, напишите 'да' для создания заявки или 'отмена' для отмены:")


@router.message(AuthStates.waiting_for_login)
async def process_login(message: Message, state: FSMContext) -> None:
    login = message.text.strip()

    if not login:
        await message.answer("Логин не может быть пустым. Пожалуйста, введите логин:")
        return

    status_msg = await message.answer("Запрос к GLPI... Проверяю наличие учетной записи.")
    user_info = await get_user_info_by_login(login)

    if not user_info:
        await status_msg.edit_text(
            "Не удалось найти пользователя с таким логином или у аккаунта отсутствует рабочий email в GLPI.\n"
            "Проверьте правильность ввода и нажмите /start для новой попытки."
        )
        await state.clear()
        return

    email = user_info['email']
    user_db_id = user_info['user_db_id']
    verification_code = random.randint(100000, 999999)
    
    await state.update_data(
        login=login, 
        email=email, 
        code=verification_code,
        user_db_id=user_db_id
    )

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
        user_id = message.from_user.id
        user_db_id = user_data.get("user_db_id")
        
        await save_telegram_id_to_db(user_db_id, user_id)
        authorized_users.add(user_id)
        
        await message.answer(
            f"Авторизация успешно завершена для {user_data.get('email')}! Доступ открыт.\n\n"
            f"Доступные команды:\n"
            f"/new_ticket - Создать новую заявку"
        )
        await state.clear()
    else:
        await message.answer("Неверный код доступа. Попробуйте ввести еще раз или сбросьте процесс командой /start.")


@router.message()
async def main_handler(message: Message) -> None:
    user_id = message.from_user.id
    
    if not await check_and_restore_authorization(user_id):
        await message.answer("Доступ заблокирован. Пожалуйста, пройдите авторизацию с помощью команды /start.")
        return

    await message.answer(
        "Неизвестная команда. Доступные команды:\n"
        "/start - Начать работу\n"
        "/new_ticket - Создать новую заявку"
    )


async def main() -> None:
    await ensure_telegram_id_column()
    await load_authorized_users_from_db()
    
    session = AiohttpSession(proxy=PROXY_URL)
    bot = Bot(token=BOT_TOKEN, session=session)

    dp = Dispatcher()
    dp.include_router(router)

    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    asyncio.run(main())
