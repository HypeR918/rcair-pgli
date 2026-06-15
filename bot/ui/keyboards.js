import { Keyboard } from '@maxhub/max-bot-api';
import { GlpiTicketStatus } from '../utils/constants.js';

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

  if (normalizedStatus === GlpiTicketStatus.SOLVED) {
    rows.push([
      Keyboard.button.callback('Удовлетворительно', `ticket:accept:${ticketId}`),
    ]);
    rows.push([
      Keyboard.button.callback('Неудовлетворительно', `ticket:reject:${ticketId}`, {
        intent: 'negative',
      }),
    ]);
  } else if (normalizedStatus !== GlpiTicketStatus.CLOSED) {
    rows.push([
      Keyboard.button.callback('Добавить комментарий', `ticket:comment:${ticketId}`),
    ]);
  }

  rows.push([Keyboard.button.callback('Назад к списку', 'menu:list')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketListKeyboard(tickets) {
  const rows = tickets.map(ticket => {
    const title = ticket.title ? ` — ${ticket.title}` : '';
    return [
      Keyboard.button.callback(
        `№${ticket.ticketId}${title} [${ticket.statusLabel}]`,
        `ticket:open:${ticket.ticketId}`
      ),
    ];
  });

  rows.push([Keyboard.button.callback('Назад', 'menu:back')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketDraftKeyboard(filesCount = 0) {
  const normalizedFilesCount = Number(filesCount || 0);
  const rows = [];

  if (normalizedFilesCount > 0) {
    const fileWord = normalizedFilesCount > 1
      ? (normalizedFilesCount < 5 ? 'файла' : 'файлов')
      : 'файл';
    rows.push([
      Keyboard.button.callback(`Создать (${normalizedFilesCount} ${fileWord})`, 'ticket:create_with_files'),
    ]);
  }

  rows.push([
    Keyboard.button.callback('Создать без файлов', 'ticket:create_without_files'),
  ]);

  rows.push([Keyboard.button.callback('Назад', 'menu:back')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketAttachKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Прикрепить файлы', 'ticket:start_files')],
    [Keyboard.button.callback('Создать без файлов', 'ticket:create_without_files')],
    [Keyboard.button.callback('Назад', 'menu:back')],
  ]);
}