import { env } from '../config/env.js';
import { State } from '../utils/constants.js';
import { normalizeEmail } from '../utils/textUtils.js';
import { isValidEmail } from '../utils/validation.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';

import {
  generateEmailVerificationCode,
  sendEmailVerificationCode,
} from '../services/emailService.js';

import {
  isMaxIdBlocked,
  blockMaxId,
  unblockMaxId,
  findGlpiUserByMaxId,
  linkMaxIdToGlpiUser,
} from '../services/dbService.js';

import {
  importUserFromSdsViaGlpi,
} from '../services/sdsService.js';

import {
  cleanupDownloadedFiles,
} from '../services/maxFileService.js';

import {
  getSession,
  setSession,
  deleteSession,
} from '../state/sessionStore.js';

export async function showWelcomeAndMenu(ctx, user) {
  const maxUserId = ctx.user.user_id;

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  const fio =
    `${user.firstname || ''} ${user.realname || ''}`.trim() ||
    user.name ||
    'пользователь';

  await ctx.reply(`Добро пожаловать, ${fio}!`, {
    attachments: [mainMenuKeyboard()],
  });
}

export async function showMenu(ctx) {
  const maxUserId = ctx.user.user_id;
  const session = getSession(maxUserId);

  if (session?.ticketDraft?.files?.length > 0) {
    await cleanupDownloadedFiles(session.ticketDraft.files);
  }

  const user = await findGlpiUserByMaxId(maxUserId);

  if (!user) {
    await ctx.reply('Учетная запись не найдена. Отправьте /start для входа.');
    return;
  }

  setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  await ctx.reply('Главное меню:', {
    attachments: [mainMenuKeyboard()],
  });
}

export async function startEmailVerification(ctx, email, flow) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(email);
  const code = generateEmailVerificationCode();

  setSession(maxUserId, {
    state: State.WAIT_EMAIL_VERIFICATION_CODE,
    verificationEmail: normalizedEmail,
    verificationCode: code,
    verificationAttempts: 0,
    verificationExpiresAt: Date.now() + 10 * 60 * 1000,
    verificationFlow: flow,
  });

  await sendEmailVerificationCode(normalizedEmail, code);
  await ctx.reply('Код подтверждения отправлен на email. Введите код из письма:');
}

export async function proceedAfterVerification(ctx, verifiedEmail) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(verifiedEmail);

  await ctx.reply('Проверяю наличие учетной записи в SDS-helpdesk...');

  const importResult = await importUserFromSdsViaGlpi(normalizedEmail);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId, normalizedEmail);

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await ctx.reply('Учетная запись найдена в SDS-helpdesk и успешно привязана.');
      await showWelcomeAndMenu(ctx, user);
      return;
    }
  }

  setSession(maxUserId, {
    state: State.WAIT_SDS_ORG,
    verifiedEmail: normalizedEmail,
    sdsData: {},
  });

  await ctx.reply('Учетная запись не найдена в SDS-helpdesk. Начинаем регистрацию.');
  await ctx.reply('Введите название организации:');
}

export async function entryPoint(ctx) {
  const maxUserId = ctx.user.user_id;

  await ctx.reply('Проверка доступа...');

  try {
    const blocked = await isMaxIdBlocked(maxUserId);

    if (blocked) {
      setSession(maxUserId, {
        state: State.WAIT_UNLOCK_EMAIL,
        attempts: 0,
      });

      await ctx.reply('Ваш MAX ID заблокирован. Для разблокировки нужно подтвердить корпоративный email.');
      await ctx.reply('Введите ваш корпоративный email:');
      return;
    }

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await showWelcomeAndMenu(ctx, user);
      return;
    }

    setSession(maxUserId, {
      state: State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply('Ваш MAX ID не найден в системе SDS-helpdesk.');
    await ctx.reply('Введите ваш корпоративный email для входа:');
  } catch (error) {
    console.error('entryPoint error:', error);
    await ctx.reply('Ошибка подключения к базе данных.');
  }
}

export async function handleEmailInput(ctx, email, flow) {
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    await ctx.reply('Некорректный формат email. Попробуйте снова:');
    return;
  }

  if (env.EMAIL_VERIFICATION_ENABLED) {
    await startEmailVerification(ctx, normalizedEmail, flow);
    return;
  }

  setSession(ctx.user.user_id, {
    state: State.IDLE,
  });

  await proceedAfterVerification(ctx, normalizedEmail);
}

export async function handleVerificationCode(ctx, session, text) {
  const maxUserId = ctx.user.user_id;

  if (Date.now() > session.verificationExpiresAt) {
    setSession(maxUserId, {
      state:
        session.verificationFlow === State.WAIT_UNLOCK_EMAIL
          ? State.WAIT_UNLOCK_EMAIL
          : State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply('Срок действия кода истек. Введите email заново:');
    return;
  }

  if (text !== session.verificationCode) {
    const attempts = Number(session.verificationAttempts || 0) + 1;
    session.verificationAttempts = attempts;

    if (attempts >= 2) {
      await blockMaxId(maxUserId);
      deleteSession(maxUserId);

      await ctx.reply('Код введен неверно два раза. Ваш MAX ID заблокирован.');
      return;
    }

    setSession(maxUserId, session);
    await ctx.reply('Код неверный. Попробуйте еще раз:');
    return;
  }

  const verifiedEmail = session.verificationEmail;
  const wasUnlockFlow = session.verificationFlow === State.WAIT_UNLOCK_EMAIL;

  if (wasUnlockFlow) {
    await unblockMaxId(maxUserId);
    await ctx.reply('MAX ID разблокирован.');
  }

  setSession(maxUserId, {
    state: State.IDLE,
  });

  await proceedAfterVerification(ctx, verifiedEmail);
}

export function registerUserHandlers(bot) {
  bot.on('bot_started', async ctx => {
    await entryPoint(ctx);
  });

  bot.command('start', async ctx => {
    await entryPoint(ctx);
  });

  bot.command('menu', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    await showMenu(ctx);
  });
}