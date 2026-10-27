#!/usr/bin/env python3
"""Fix MAX/GLPI ticket polling: visit every tracked ticket in bounded pages.

Usage: python3 fix_ticket_notifications_all.py /path/to/project
Optional: --check-only, --container max_bot

Only the two functions supplied on 2026-10-06 are replaced. Unexpected
source versions are rejected before any file is written. Existing delivery
flags and follow-up records are preserved. The script does not restart Docker.
"""

import argparse
import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


OLD_DB = '''export async function getActiveBotUserTickets(limit = 50) {
  const [rows] = await botPool.execute(
    `SELECT id, max_id, glpi_ticket_id, solution_notified, closed_notified
     FROM bot_user_tickets
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  return rows;
}'''

NEW_DB = '''export async function getActiveBotUserTickets(limit = 50, afterId = 0, upToId = null) {
  // Freeze the upper bound on the first page of a polling cycle.
  // Tickets created during this cycle will be visited on the next cycle.
  let snapshotMaxId = upToId;

  if (snapshotMaxId === null) {
    const [maxRows] = await botPool.execute(
      'SELECT COALESCE(MAX(id), 0) AS max_id FROM bot_user_tickets'
    );
    snapshotMaxId = Number(maxRows[0]?.max_id || 0);
  }

  const [rows] = await botPool.execute(
    `SELECT id, max_id, glpi_ticket_id, solution_notified, closed_notified,
            ? AS polling_max_id
     FROM bot_user_tickets
     WHERE id > ? AND id <= ?
     ORDER BY id ASC
     LIMIT ?`,
    [snapshotMaxId, afterId, snapshotMaxId, limit]
  );

  return rows;
}'''

OLD_POLLING = '''export async function pollUserTickets(bot) {
  if (ticketPollingInProgress) {
    return;
  }

  ticketPollingInProgress = true;

  try {
    const tickets = await getActiveBotUserTickets(50);

    for (const localTicket of tickets) {
      const ticketId = Number(localTicket.glpi_ticket_id || 0);

      if (!ticketId) {
        continue;
      }

      try {
        const ticket = await getGlpiTicket(ticketId);
        const status = Number(ticket.status || 0);

        await ensureBotUserTicket(localTicket.max_id, ticketId);

        await notifySolutionIfNeeded(bot, localTicket, ticketId, status);
        await notifyClosedIfNeeded(bot, localTicket, ticketId, status);
        await notifyNewFollowups(bot, localTicket, ticketId, status);
      } catch (err) {
        if (isGlpiTicketNotFoundError(err)) {
          await deleteBotUserTicketByTicketId(ticketId);
          console.log('Deleted unavailable local ticket:', ticketId);
          continue;
        }

        console.error(
          'pollUserTickets item error:',
          localTicket.glpi_ticket_id,
          err.message
        );
      }
    }
  } catch (err) {
    console.error('pollUserTickets error:', err.message);
  } finally {
    ticketPollingInProgress = false;
  }
}'''

NEW_POLLING = '''export async function pollUserTickets(bot) {
  if (ticketPollingInProgress) {
    return;
  }

  ticketPollingInProgress = true;

  const startedAt = Date.now();
  let afterId = 0;
  let upToId = null;
  let scannedCount = 0;
  let batchCount = 0;
  let errorCount = 0;

  try {
    console.log('[TICKET_POLLING] Cycle started');

    while (true) {
      const tickets = await getActiveBotUserTickets(50, afterId, upToId);

      if (tickets.length === 0) {
        break;
      }

      if (upToId === null) {
        upToId = Number(tickets[0].polling_max_id);
      }

      const nextAfterId = Number(tickets[tickets.length - 1].id);

      if (!Number.isSafeInteger(upToId)
          || !Number.isSafeInteger(nextAfterId)
          || nextAfterId <= afterId
          || nextAfterId > upToId) {
        throw new Error('Invalid ticket polling pagination cursor');
      }

      // Advance by the stable row ID, not OFFSET: deletions cannot skip a page.
      afterId = nextAfterId;
      scannedCount += tickets.length;
      batchCount += 1;

      for (const localTicket of tickets) {
        const ticketId = Number(localTicket.glpi_ticket_id || 0);

        if (!ticketId) {
          continue;
        }

        try {
          const ticket = await getGlpiTicket(ticketId);
          const status = Number(ticket.status || 0);

          await ensureBotUserTicket(localTicket.max_id, ticketId);

          await notifySolutionIfNeeded(bot, localTicket, ticketId, status);
          await notifyClosedIfNeeded(bot, localTicket, ticketId, status);
          await notifyNewFollowups(bot, localTicket, ticketId, status);
        } catch (err) {
          if (isGlpiTicketNotFoundError(err)) {
            await deleteBotUserTicketByTicketId(ticketId);
            console.log('Deleted unavailable local ticket:', ticketId);
            continue;
          }

          errorCount += 1;
          console.error(
            'pollUserTickets item error:',
            localTicket.glpi_ticket_id,
            err.message
          );
        }
      }
    }

    console.log(
      `[TICKET_POLLING] Cycle complete: rows=${scannedCount}, batches=${batchCount}, errors=${errorCount}, duration_ms=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error('pollUserTickets error:', err.message);
  } finally {
    ticketPollingInProgress = false;
  }
}'''


def locate_source(root):
    candidates = []
    for candidate in (root, root / 'bot', root / 'bot' / 'bot'):
        if ((candidate / 'services' / 'dbService.js').is_file()
                and (candidate / 'polling' / 'ticketPolling.js').is_file()):
            resolved = candidate.resolve()
            if resolved not in candidates:
                candidates.append(resolved)
    if len(candidates) != 1:
        detail = ', '.join(str(path) for path in candidates) or 'не найдены'
        raise RuntimeError(
            'Нужен один каталог с services/dbService.js и polling/ticketPolling.js. '
            'Передайте точный путь к исходникам. Кандидаты: ' + detail
        )
    return candidates[0]


def replace_expected(raw, old, new, path):
    text = raw.decode('utf-8')
    normalized = text.replace('\r\n', '\n')
    if normalized.count(new) == 1 and old not in normalized:
        return raw, False
    if normalized.count(old) != 1 or new in normalized:
        raise RuntimeError(
            'Версия функции отличается от показанного кода: ' + str(path)
            + '. Изменения не внесены.'
        )
    updated = normalized.replace(old, new, 1)
    if '\r\n' in text and '\n' not in text.replace('\r\n', ''):
        updated = updated.replace('\n', '\r\n')
    return updated.encode('utf-8'), True


def check_js(contents, path, container):
    if shutil.which('node'):
        command = ['node', '--check', '--input-type=module']
    elif shutil.which('docker'):
        command = ['docker', 'exec', '-i', container, 'node', '--check', '--input-type=module']
    else:
        raise RuntimeError('Для проверки синтаксиса нужен Node.js или запущенный контейнер ' + container)
    result = subprocess.run(command, input=contents, capture_output=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(
            'Ошибка проверки JavaScript: ' + str(path) + '\n'
            + result.stderr.decode('utf-8', errors='replace')
        )


def stage_file(path, contents):
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.notifications-', dir=path.parent)
    staged = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        shutil.copystat(path, staged)
        original_stat = path.stat()
        staged_stat = staged.stat()
        if (staged_stat.st_uid, staged_stat.st_gid) != (original_stat.st_uid, original_stat.st_gid):
            os.chown(staged, original_stat.st_uid, original_stat.st_gid)
        return staged
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', default='.', help='Каталог проекта или исходников бота')
    parser.add_argument('--container', default='max_bot', help='Контейнер для проверки JS, если на хосте нет Node.js')
    parser.add_argument('--check-only', action='store_true', help='Проверить применимость и синтаксис без записи')
    args = parser.parse_args()
    source = locate_source(Path(args.root).expanduser().resolve())
    print('Исходники: ' + str(source))

    changes = []
    for relative, old, new in (
        ('services/dbService.js', OLD_DB, NEW_DB),
        ('polling/ticketPolling.js', OLD_POLLING, NEW_POLLING),
    ):
        path = source / relative
        original = path.read_bytes()
        updated, changed = replace_expected(original, old, new, path)
        check_js(updated, path, args.container)
        print(('Будет обновлён: ' if changed else 'Уже обновлён: ') + str(path))
        if changed:
            changes.append((path, original, updated))

    if not changes:
        print('Исправление уже применено. Повторных изменений нет.')
        return 0
    if args.check_only:
        print('Проверка успешна. Файлы не изменялись.')
        return 0

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    staged_files = []
    backups = []
    written = []
    try:
        for path, original, updated in changes:
            if path.read_bytes() != original:
                raise RuntimeError('Файл изменился во время проверки: ' + str(path))
            backup = path.with_name(path.name + '.bak-notifications-' + stamp)
            with backup.open('xb') as stream:
                stream.write(original)
            shutil.copystat(path, backup)
            backups.append(backup)
            staged_files.append((path, original, stage_file(path, updated)))
        for path, original, staged in staged_files:
            if path.read_bytes() != original:
                raise RuntimeError('Файл изменился перед записью: ' + str(path))
            os.replace(staged, path)
            written.append((path, original))
    except BaseException:
        for path, original in reversed(written):
            restored = stage_file(path, original)
            os.replace(restored, path)
        raise
    finally:
        for _, _, staged in staged_files:
            staged.unlink(missing_ok=True)

    for backup in backups:
        print('Резервная копия: ' + str(backup))
    print('Готово: каждый цикл обходит все зарегистрированные заявки порциями по 50.')
    print('Отметки доставки и записи комментариев в базе не изменялись.')
    print('Теперь пересоберите compose-сервис max-bot и проверьте строки [TICKET_POLLING] в логах.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, UnicodeError, subprocess.SubprocessError) as error:
        print('ОШИБКА: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
