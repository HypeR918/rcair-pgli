import { Keyboard } from '@maxhub/max-bot-api';
import { GlpiTicketStatus } from '../utils/constants.js';
import { env } from '../config/env.js';

export function startKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Авторизоваться', 'menu:start_auth')],
  ]);
}

export function mainMenuKeyboard(maxUserId) {
  const rows = [
    [Keyboard.button.callback('Новая', 'menu:new')],
    [Keyboard.button.callback('Выбрать', 'menu:list')],
    [Keyboard.button.callback('Справка', 'menu:help')],
  ];

  if (maxUserId && Number(maxUserId) === Number(env.ADMIN_ID)) {
    rows.push([Keyboard.button.callback('Выйти', 'menu:logout', { intent: 'negative' })]);
  }

  return Keyboard.inlineKeyboard(rows);
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
      Keyboard.button.callback('Да, закрыть заявку', `ticket:accept:${ticketId}`),
    ]);
    rows.push([
      Keyboard.button.callback('Нет, вернуть в работу', `ticket:reject:${ticketId}`, {
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

export function ticketSolutionNotificationKeyboard(ticketId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Да, закрыть заявку', `ticket:accept:${ticketId}`)],
    [Keyboard.button.callback('Нет, вернуть в работу', `ticket:reject:${ticketId}`, {
      intent: 'negative',
    })],
    [Keyboard.button.callback('Назад к списку', 'menu:list')],
  ]);
}

export function ticketRateChoiceKeyboard(ticketId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Да', `ticket:rate:${ticketId}:1`)],
    [Keyboard.button.callback('Нет', `ticket:rate_negative:${ticketId}`)],
  ]);
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

export function ticketFilesKeyboard(filesCount = 0) {
  const normalizedFilesCount = Number(filesCount || 0);
  const rows = [];

  if (normalizedFilesCount > 0) {
    const fileWord = normalizedFilesCount > 1
      ? (normalizedFilesCount < 5 ? 'файла' : 'файлов')
      : 'файл';
    rows.push([
      Keyboard.button.callback(`Создать (${normalizedFilesCount} ${fileWord})`, 'ticket:create_with_files'),
    ]);
  } else {
    rows.push([
      Keyboard.button.callback('Создать заявку', 'ticket:create_with_files'),
    ]);
  }

  rows.push([Keyboard.button.callback('Назад', 'menu:back')]);

  return Keyboard.inlineKeyboard(rows);
}

export function ticketAttachChoiceKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Прикрепить файлы', 'ticket:start_files')],
    [Keyboard.button.callback('Создать без файлов', 'ticket:create_without_files')],
    [Keyboard.button.callback('Назад', 'menu:back')],
  ]);
}

export function ticketConfirmKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Отправить заявку', 'ticket:confirm_create')],
    [Keyboard.button.callback('Вернуться в главное меню', 'menu:back')],
  ]);
}
