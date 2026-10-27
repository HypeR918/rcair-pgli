import { env } from '../config/env.js';
import { State } from '../utils/constants.js';
import { normalizeEmail } from '../utils/textUtils.js';
import { isValidEmail } from '../utils/validation.js';
import { mainMenuKeyboard, startKeyboard } from '../ui/keyboards.js';

import {
  generateEmailVerificationCode,
  sendEmailVerificationCode,
  hashVerificationCode,
  verifyCodeHash,
} from '../services/emailService.js';

import {
  reserveVerificationSend,
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

  await setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  const fio =
    `${user.firstname || ''} ${user.realname || ''}`.trim() ||
    user.name ||
    'пользователь';

  await ctx.reply(`Добро пожаловать, ${fio}!`, {
    attachments: [mainMenuKeyboard(maxUserId)],
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
    await ctx.reply('Учетная запись не найдена. Для входа отправьте /start');
    return;
  }

  await setSession(maxUserId, {
    state: State.IDLE,
    glpiUserId: user.id,
  });

  await ctx.reply('Главное меню:', {
    attachments: [mainMenuKeyboard(maxUserId)],
  });
}

export async function startEmailVerification(ctx, email, flow) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(email);
  const remainingMs = await reserveVerificationSend(
    maxUserId, normalizedEmail, env.EMAIL_CODE_RESEND_COOLDOWN_MS
  );
  if (remainingMs > 0) {
    await ctx.reply(`Повторную отправку можно запросить через ${Math.ceil(remainingMs / 1000)} сек.`);
    return;
  }

  const code = generateEmailVerificationCode();

  // отправляем письмо ДО сохранения сессии, чтобы код не остался в базе при сбое
  await sendEmailVerificationCode(normalizedEmail, code);

  await setSession(maxUserId, {
    state: State.WAIT_EMAIL_VERIFICATION_CODE,
    verificationEmail: normalizedEmail,
    verificationCodeHash: hashVerificationCode(code),
    verificationAttempts: 0,
    verificationExpiresAt: Date.now() + env.EMAIL_CODE_TTL_MS,
    verificationFlow: flow,
    verificationSentAt: Date.now(),
  });

  await ctx.reply('На указанную почту отправлен код подтверждения');
  await ctx.reply('Введите код подтверждения из письма');
}

export async function proceedAfterVerification(ctx, verifiedEmail) {
  const maxUserId = ctx.user.user_id;
  const normalizedEmail = normalizeEmail(verifiedEmail);

  await ctx.reply('Проверяю наличие учетной записи...');

  const importResult = await importUserFromSdsViaGlpi(normalizedEmail);

  if (importResult && importResult.id) {
    await linkMaxIdToGlpiUser(importResult.id, maxUserId, normalizedEmail);

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await ctx.reply('Учетная запись найдена и активирована в системе заявок.');
      await showWelcomeAndMenu(ctx, user);
      return;
    }
  }

  await setSession(maxUserId, {
    state: State.WAIT_SDS_ORG,
    verifiedEmail: normalizedEmail,
    sdsData: {},
  });

  await ctx.reply('Ваш MAX ID не найден в системе заявок');
  await ctx.reply('Введите название организации:');
}

export async function entryPoint(ctx) {
  const maxUserId = ctx.user.user_id;

  try {
    await cleanupDownloadedFiles(getSession(maxUserId)?.ticketDraft?.files || []);
    const blocked = await isMaxIdBlocked(maxUserId);

    if (blocked) {
      await setSession(maxUserId, {
        state: State.WAIT_UNLOCK_EMAIL,
        attempts: 0,
      });

      await ctx.reply('Ваш MAX ID заблокирован\nДля разблокировки нужно подтвердить email');
      await ctx.reply('Введите ваш корпоративный email:');
      return;
    }

    const user = await findGlpiUserByMaxId(maxUserId);

    if (user) {
      await showWelcomeAndMenu(ctx, user);
      return;
    }

    await setSession(maxUserId, {
      state: State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply(
      'Здравствуйте!\nЭто бот технической поддержки ОЦАИР ТО\nДля начала работы нужно авторизоваться',
      {
        attachments: [startKeyboard()],
      }
    );
  } catch (error) {
    console.error('entryPoint error:', error.message);
    await ctx.reply('Ошибка подключения к базе данных\nПовторите попытку позже');
  }
}

export async function handleEmailInput(ctx, email, flow) {
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    await ctx.reply('Некорректный формат email. Попробуйте снова');
    return;
  }

  if (env.EMAIL_VERIFICATION_ENABLED) {
    await startEmailVerification(ctx, normalizedEmail, flow);
    return;
  }

  await setSession(ctx.user.user_id, {
    state: State.IDLE,
  });

  await proceedAfterVerification(ctx, normalizedEmail);
}

export async function handleVerificationCode(ctx, session, text) {
  const maxUserId = ctx.user.user_id;

  if (Date.now() > session.verificationExpiresAt) {
    await setSession(maxUserId, {
      state:
        session.verificationFlow === State.WAIT_UNLOCK_EMAIL
          ? State.WAIT_UNLOCK_EMAIL
          : State.WAIT_NEW_USER_EMAIL,
    });

    await ctx.reply('Срок действия кода истек. Введите email еще раз');
    return;
  }

  const codeValid =
    typeof text === 'string' &&
    /^\d{6}$/.test(text) &&
    verifyCodeHash(text, session.verificationCodeHash);

  if (!codeValid) {
    const attempts = Number(session.verificationAttempts || 0) + 1;
    session.verificationAttempts = attempts;

    if (attempts >= env.EMAIL_CODE_MAX_ATTEMPTS) {
      await blockMaxId(maxUserId);
      await deleteSession(maxUserId);

      await ctx.reply('Код введен неверно несколько раз. Ваш MAX ID заблокирован');
      return;
    }

    await setSession(maxUserId, session);
    await ctx.reply('Код неверный. Попробуйте еще раз');
    return;
  }

  const verifiedEmail = session.verificationEmail;
  const wasUnlockFlow = session.verificationFlow === State.WAIT_UNLOCK_EMAIL;

  if (wasUnlockFlow) {
    await unblockMaxId(maxUserId);
    await ctx.reply('MAX ID разблокирован');
  }

  await setSession(maxUserId, {
    state: State.IDLE,
  });

  await proceedAfterVerification(ctx, verifiedEmail);
}

async function handleStart(ctx, source) {
  if (!ctx.user || !ctx.user.user_id) {
    console.warn(`[START] ${source}: user_id отсутствует`);
    return;
  }

  console.log(`[START] ${source}: max_id=${ctx.user.user_id}`);

  try {
    await entryPoint(ctx);
  } catch (error) {
    console.error(`[START] ${source} error:`, error);

    try {
      await ctx.reply(
        'Не удалось запустить бота. Попробуйте отправить /start ещё раз.'
      );
    } catch (replyError) {
      console.error(`[START] ${source} reply error:`, replyError);
    }
  }
}

export function registerUserHandlers(bot) {
  bot.on('bot_started', async ctx => {
    await handleStart(ctx, 'bot_started');
  });

  bot.command('start', async ctx => {
    await handleStart(ctx, '/start');
  });

  bot.command('menu', async ctx => {
    if (!ctx.user || !ctx.user.user_id) return;

    await showMenu(ctx);
  });
}
