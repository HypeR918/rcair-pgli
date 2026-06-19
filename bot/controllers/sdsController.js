import { State } from '../utils/constants.js';
import { normalizeEmail } from '../utils/textUtils.js';
import { setSession, deleteSession } from '../state/sessionStore.js';

import {
  createSdsRequest,
  updateSdsRequestGlpiTicketId,
  approveSdsRequest,
  rejectSdsRequest,
  findGlpiUserByMaxId,
  linkMaxIdToGlpiUser,
} from '../services/dbService.js';

import {
  createGlpiRegistrationTicket,
} from '../services/glpiService.js';

import {
  importUserFromSdsViaGlpi,
} from '../services/sdsService.js';

import {
  showWelcomeAndMenu,
} from './userController.js';

export async function handleSdsTextState(ctx, session, text) {
  const maxUserId = ctx.user.user_id;

  if (session.state === State.WAIT_SDS_ORG) {
    session.sdsData.org = text;
    session.state = State.WAIT_SDS_DEPT;
    setSession(maxUserId, session);

    await ctx.reply('Введите подразделение:');
    return true;
  }

  if (session.state === State.WAIT_SDS_DEPT) {
    session.sdsData.dept = text;
    session.state = State.WAIT_SDS_FIO;
    setSession(maxUserId, session);

    await ctx.reply('Введите ФИО полностью:');
    return true;
  }

  if (session.state === State.WAIT_SDS_FIO) {
    session.sdsData.fio = text;
    session.state = State.WAIT_SDS_POSITION;
    setSession(maxUserId, session);

    await ctx.reply('Введите должность:');
    return true;
  }

  if (session.state === State.WAIT_SDS_POSITION) {
    session.sdsData.position = text;
    session.state = State.WAIT_SDS_PHONE;
    setSession(maxUserId, session);

    await ctx.reply('Введите телефон:');
    return true;
  }

  if (session.state === State.WAIT_SDS_PHONE) {
    session.sdsData.phone = text;
    session.state = State.WAIT_SDS_ISSUE;
    setSession(maxUserId, session);

    await ctx.reply('Опишите содержание обращения:');
    return true;
  }

  if (session.state === State.WAIT_SDS_ISSUE) {
    session.sdsData.issue = text;

    await ctx.reply('Создаю заявку для администраторов...');

    const localRequestId = await createSdsRequest(
      maxUserId,
      session.verifiedEmail,
      session.sdsData
    );

    const glpiTicketId = await createGlpiRegistrationTicket(
      maxUserId,
      session.verifiedEmail,
      session.sdsData
    );

    await updateSdsRequestGlpiTicketId(localRequestId, glpiTicketId);

    session.state = State.WAIT_SDS_APPROVAL;
    session.sdsRequestId = localRequestId;
    session.glpiTicketId = glpiTicketId;
    setSession(maxUserId, session);

    await ctx.reply(`Заявка №${glpiTicketId} создана и передана администраторам.`);
    await ctx.reply('Ожидайте решения по заявке. Я пришлю уведомление после обработки.');
    return true;
  }

  if (session.state === State.WAIT_SDS_APPROVAL) {
    await ctx.reply('Заявка находится на рассмотрении администраторов.');
    return true;
  }

  return false;
}

export async function handleApprovedSdsRequest(bot, request) {
  const maxUserId = request.max_id;
  const email = normalizeEmail(request.email);

  await approveSdsRequest(
    request.id,
    request.decision_text || 'Заявка подтверждена',
    request.glpi_ticket_status || null
  );

  await bot.api.sendMessageToUser(
    maxUserId,
    'Заявка подтверждена'
  );

  await bot.api.sendMessageToUser(
    maxUserId,
    'Проверяю учетную запись в каталоге пользователей...'
  );

  const importResult = await importUserFromSdsViaGlpi(email);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId);

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      const fakeCtx = {
        user: { user_id: maxUserId },
        reply: (text, options) => bot.api.sendMessageToUser(maxUserId, text, options),
      };

      await bot.api.sendMessageToUser(
        maxUserId,
        'Учетная запись найдена и активирована в системе заявок.'
      );

      await showWelcomeAndMenu(fakeCtx, user);
      return;
    }
  }

  await bot.api.sendMessageToUser(
    maxUserId,
    'Заявка подтверждена, но учетная запись пока не найдена. Обратитесь к администратору:\nНаправьте заявку по email на адрес support@gov70.ru'
  );
}

export async function handleRejectedSdsRequest(bot, request) {
  const maxUserId = request.max_id;

  await rejectSdsRequest(
    request.id,
    request.decision_text || 'Заявка отклонена',
    request.glpi_ticket_status || null
  );

  deleteSession(maxUserId);

  await bot.api.sendMessageToUser(
    maxUserId,
    `По заявке получен отказ.\n\n${request.decision_text || 'Причина отказа не указана.'}`
  );
}