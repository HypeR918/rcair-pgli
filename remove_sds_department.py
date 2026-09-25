#!/usr/bin/env python3
"""Убрать вопрос о подразделении из регистрации СДС MAX-бота.

Запуск на сервере: python3 remove_sds_department.py
Другой каталог: python3 remove_sds_department.py --bot-dir /путь/к/bot
Только проверка: python3 remove_sds_department.py --check
"""

import argparse
import os
import shutil
import stat
import tempfile
from datetime import datetime
from pathlib import Path


FILES = (
    "controllers/sdsController.js",
    "services/dbService.js",
    "services/glpiService.js",
)


def replace_once(text, old, new, label, already_done):
    count = text.count(old)
    if count == 1:
        return text.replace(old, new, 1)
    if count == 0 and already_done(text):
        return text
    raise ValueError(f"{label}: ожидаемый фрагмент найден {count} раз; файл не изменён")


def prepare(relative_path, raw):
    text = raw.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"

    def lines(value):
        return value.replace("\n", newline)

    if relative_path == "controllers/sdsController.js":
        old = lines("""    session.sdsData.org = text;
    session.state = State.WAIT_SDS_DEPT;
    setSession(maxUserId, session);

    await ctx.reply('Введите подразделение:');""")
        new = lines("""    session.sdsData.org = text;
    session.state = State.WAIT_SDS_FIO;
    setSession(maxUserId, session);

    await ctx.reply('Введите ФИО полностью:');""")
        text = replace_once(text, old, new, relative_path, lambda value: new in value)

        old = lines("""  if (session.state === State.WAIT_SDS_DEPT) {
    session.sdsData.dept = text;
    session.state = State.WAIT_SDS_FIO;""")
        new = lines("""  if (session.state === State.WAIT_SDS_DEPT) {
    session.state = State.WAIT_SDS_FIO;""")
        text = replace_once(text, old, new, relative_path, lambda value: new in value)

    elif relative_path == "services/dbService.js":
        old = lines("""(max_id, email, org, dept, fio, position, phone, issue, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')""")
        new = lines("""(max_id, email, org, fio, position, phone, issue, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')""")
        text = replace_once(text, old, new, relative_path, lambda value: new in value)

        old = lines("""      data.org,
      data.dept,
      data.fio,""")
        new = lines("""      data.org,
      data.fio,""")
        text = replace_once(text, old, new, relative_path, lambda value: new in value)

    elif relative_path == "services/glpiService.js":
        old = lines("    `Подразделение: ${data.dept || '-'}`,\n")
        text = replace_once(
            text,
            old,
            "",
            relative_path,
            lambda value: "    `ФИО: ${data.fio || '-'}`" in value
            and "`Подразделение: ${data.dept" not in value,
        )

    return text.encode("utf-8")


def write_atomically(path, data):
    mode = stat.S_IMODE(path.stat().st_mode)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(data)
            temp.flush()
            os.fsync(temp.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bot-dir", type=Path, default=Path("/opt/max-bot/rcair-pgli/bot"))
    parser.add_argument("--check", action="store_true", help="Проверить файлы без изменения")
    args = parser.parse_args()
    bot_dir = args.bot_dir.expanduser().resolve()

    # Проверяем все три файла до первой записи, чтобы не оставить неполную правку.
    originals = {}
    changed = {}
    for name in FILES:
        path = bot_dir / name
        raw = path.read_bytes()
        result = prepare(name, raw)
        originals[name] = raw
        if result != raw:
            changed[name] = result

    if not changed:
        print("Правки уже применены. Ничего не изменено.")
        return
    print("Будут изменены: " + ", ".join(changed))
    if args.check:
        print("Проверка прошла, файлы не изменены.")
        return

    backup = Path.home() / ("sds-department-backup-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    for name in changed:
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bot_dir / name, target)

    written = []
    try:
        for name, data in changed.items():
            write_atomically(bot_dir / name, data)
            written.append(name)
    except Exception:
        for name in reversed(written):
            write_atomically(bot_dir / name, originals[name])
        raise

    print("Готово. Резервные копии: " + str(backup))
    print("Проверьте git diff и пересоберите контейнер бота: простой docker restart не обновит код в образе.")


if __name__ == "__main__":
    main()
