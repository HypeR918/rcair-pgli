export const State = {
  IDLE: 'IDLE',

  WAIT_UNLOCK_EMAIL: 'WAIT_UNLOCK_EMAIL',
  WAIT_NEW_USER_EMAIL: 'WAIT_NEW_USER_EMAIL',
  WAIT_EMAIL_VERIFICATION_CODE: 'WAIT_EMAIL_VERIFICATION_CODE',

  WAIT_SDS_ORG: 'WAIT_SDS_ORG',
  WAIT_SDS_DEPT: 'WAIT_SDS_DEPT',
  WAIT_SDS_FIO: 'WAIT_SDS_FIO',
  WAIT_SDS_POSITION: 'WAIT_SDS_POSITION',
  WAIT_SDS_PHONE: 'WAIT_SDS_PHONE',
  WAIT_SDS_ISSUE: 'WAIT_SDS_ISSUE',
  WAIT_SDS_APPROVAL: 'WAIT_SDS_APPROVAL',

  WAIT_NEW_TICKET_TITLE: 'WAIT_NEW_TICKET_TITLE',
  WAIT_NEW_TICKET_DESCRIPTION: 'WAIT_NEW_TICKET_DESCRIPTION',

  // Оставляем для совместимости, если где-то осталась старая логика.
  WAIT_NEW_TICKET_CONTENT: 'WAIT_NEW_TICKET_CONTENT',

  WAIT_TICKET_COMMENT: 'WAIT_TICKET_COMMENT',
  WAIT_REJECT_SOLUTION_REASON: 'WAIT_REJECT_SOLUTION_REASON',
};

export const GlpiTicketStatus = {
  NEW: 1,
  PROCESSING: 2,
  PLANNED: 3,
  WAITING: 4,
  SOLVED: 5,
  CLOSED: 6,
};

export const approveWords = [
  'ПОДТВЕРДИТЬ',
  'ПОДТВЕРЖДЕНО',
  'ПОДТВЕРЖДАЮ',
  'ПОДТВЕРЖДАЕМ',
  'ОДОБРЕНО',
  'ОДОБРИТЬ',
  'СОГЛАСОВАНО',
  'СОГЛАСОВАТЬ',
  'СОГЛАСЕН',
  'СОГЛАСНЫ',
  'ДОСТУП РАЗРЕШЕН',
  'ДОСТУП ПРЕДОСТАВЛЕН',
  'РАЗРЕШЕНО',
  'РАЗРЕШИТЬ',
];

export const rejectWords = [
  'ОТКАЗАТЬ',
  'ОТКАЗАНО',
  'ОТКАЗ',
  'ОТКАЗЫВАЕМ',
  'ОТКЛОНЕНО',
  'ОТКЛОНИТЬ',
  'ОТКЛОНЯЕМ',
  'НЕ СОГЛАСОВАНО',
  'НЕ ПОДТВЕРЖДЕНО',
  'ДОСТУП ЗАПРЕЩЕН',
  'ДОСТУП НЕ РАЗРЕШЕН',
  'ЗАПРЕЩЕНО',
];