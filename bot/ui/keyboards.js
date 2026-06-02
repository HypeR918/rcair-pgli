import { Keyboard } from '@maxhub/max-bot-api';

export function mainMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Новая', 'menu:new')],
    [Keyboard.button.callback('Выбрать', 'menu:list')],
    [Keyboard.button.callback('Справка', 'menu:help')],
    [Keyboard.button.callback('Выйти', 'menu:logout', { intent: 'negative' })],
  ]);
}

export function ticketActionsKeyboard(ticketId, status) {
  const rows = [
    [Keyboard.button.callback('Добавить комментарий', `ticket:comment:${ticketId}`)],
  ];

  if (Number(status) === 5) {
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