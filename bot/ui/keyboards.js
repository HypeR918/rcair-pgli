import { Keyboard } from '@maxhub/max-bot-api';

export function mainMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Новая', 'menu:new')],
    [Keyboard.button.callback('Выбрать', 'menu:list')],
    [Keyboard.button.callback('Справка', 'menu:help')],
    [Keyboard.button.callback('Выйти', 'menu:logout', { intent: 'negative' })],
  ]);
}

export function helpKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('В меню', 'menu:back')],
  ]);
}

export function ticketActionsKeyboard(ticketId, status) {
  const normalizedStatus = Number(status || 0);

  const rows = [];

  if (normalizedStatus !== 6) {
    rows.push([
      Keyboard.button.callback('Добавить комментарий', `ticket:comment:${ticketId}`),
    ]);
  }

  if (normalizedStatus === 5) {
    rows.push([
      Keyboard.button.callback('Принять решение', `ticket:accept:${ticketId}`),
      Keyboard.button.callback('Отклонить решение', `ticket:reject:${ticketId}`, {
        intent: 'negative',
      }),
    ]);
  }

  rows.push([Keyboard.button.callback('Назад к списку', 'menu:list')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketListKeyboard(tickets) {
  const rows = tickets.map(ticket => [
    Keyboard.button.callback(
      `№${ticket.ticketId} — ${ticket.statusLabel}`,
      `ticket:open:${ticket.ticketId}`
    ),
  ]);

  rows.push([Keyboard.button.callback('Назад', 'menu:back')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketFilesKeyboard(filesCount = 0) {
  const normalizedFilesCount = Number(filesCount || 0);

  const createLabel = normalizedFilesCount > 0
    ? `Создать с файлами (${normalizedFilesCount})`
    : 'Создать заявку';

  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback(createLabel, 'ticket:create_with_files')],
    [Keyboard.button.callback('Создать без файлов', 'ticket:create_without_files')],
    [Keyboard.button.callback('Назад', 'menu:back')],
  ]);
}

export function ticketRatingKeyboard(ticketId) {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('1', `ticket:rate:${ticketId}:1`),
      Keyboard.button.callback('2', `ticket:rate:${ticketId}:2`),
      Keyboard.button.callback('3', `ticket:rate:${ticketId}:3`),
      Keyboard.button.callback('4', `ticket:rate:${ticketId}:4`),
      Keyboard.button.callback('5', `ticket:rate:${ticketId}:5`),
    ],
    [Keyboard.button.callback('В меню', 'menu:back')],
  ]);
}