import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIsolated, noop } from './helpers/isolated.mjs';
import { serializeUserUpdates } from '../utils/userUpdates.js';
import { State } from '../utils/constants.js';
import * as db from '../services/dbService.js';
import * as glpi from '../services/glpiService.js';
const stub = module => Object.fromEntries(Object.keys(module).map(name => [name, noop]));
const ctx = () => ({ user: { user_id: 1 }, reply: noop });
async function fixture({ authorized = true, status = 5 } = {}) {
  let session = { state: State.WAIT_TICKET_CONFIRM, ticketDraft: { title: 'fixture title', description: 'fixture description', files: [] } };
  const calls = { create: 0, accept: 0, reject: 0, comment: 0, read: 0, auth: 0 };
  const controller = await loadIsolated('controllers/ticketController.js', {
    './state/sessionStore.js': { getSession: () => structuredClone(session), setSession: async (_id, value) => { session = value; }, deleteSession: noop },
    './services/dbService.js': { ...stub(db), findGlpiUserByMaxId: async () => ({ id: 42 }),
      getAuthorizedTicketUser: async () => { calls.auth++; return authorized ? { id: 42 } : null; },
      getBotUserTicket: async () => ({ max_id: 1, glpi_ticket_id: 7 }), getBotTicketRating: async () => null },
    './services/glpiService.js': { ...stub(glpi),
      getGlpiTicket: async () => { calls.read++; return { status, name: 'fixture', content: 'restricted fixture' }; },
      getGlpiTicketFollowups: async () => [],
      createGlpiUserTicket: async () => ({ ticketId: ++calls.create, title: 'fixture' }),
      addGlpiTicketFollowup: async () => { calls.comment++; return 1; },
      acceptGlpiTicketSolution: async () => { calls.accept++; return { followupId: 1, content: 'fixture' }; },
      rejectGlpiTicketSolution: async () => { calls.reject++; return { followupId: 1, content: 'fixture' }; } },
    './services/maxFileService.js': { cleanupDownloadedFiles: noop, collectDownloadedMaxAttachments: async () => [] },
  });
  return { controller, calls };
}

test('локальная связь не разрешает чтение или изменение после отзыва доступа', async () => {
  const { controller, calls } = await fixture({ authorized: false });
  await controller.showTicketDetails(ctx(), 7);
  await controller.acceptTicketSolution(ctx(), 7);
  await controller.rejectTicketSolution(ctx(), 7, 'fixture reason');
  await controller.addUserCommentToTicket(ctx(), 7, 'fixture comment');
  assert.equal(calls.auth, 4);
  assert.equal(calls.read + calls.accept + calls.reject + calls.comment, 0);
});
test('устаревшие кнопки не меняют статус; закрытая заявка не принимает комментарий', async () => {
  for (const status of [2, 6]) {
    const { controller, calls } = await fixture({ status });
    await controller.acceptTicketSolution(ctx(), 7);
    await controller.rejectTicketSolution(ctx(), 7, 'fixture reason');
    if (status === 6) await controller.addUserCommentToTicket(ctx(), 7, 'fixture comment');
    assert.equal(calls.accept + calls.reject + calls.comment, 0);
  }
});
test('актуальное решение разрешено принять и отклонить', async () => {
  const { controller, calls } = await fixture();
  await controller.acceptTicketSolution(ctx(), 7);
  await controller.rejectTicketSolution(ctx(), 7, 'fixture reason');
  assert.equal(calls.accept, 1); assert.equal(calls.reject, 1);
});
test('два подтверждения через middleware создают ровно одну заявку', async () => {
  const { controller, calls } = await fixture();
  const actions = new Map();
  controller.registerTicketActions({ action: (key, handler) => actions.set(key, handler) });
  await Promise.all([1, 2].map(() => serializeUserUpdates(ctx(), () => actions.get('ticket:confirm_create')(ctx()))));
  assert.equal(calls.create, 1);
});
test('ошибка сохранения сессии возвращается вызывающему обработчику', async () => {
  const module = await loadIsolated('controllers/userController.js', {
    './state/sessionStore.js': { getSession: () => null, deleteSession: noop, setSession: async () => { throw Error('DB unavailable'); } },
  });
  await assert.rejects(module.showWelcomeAndMenu(ctx(), { id: 42 }), /DB unavailable/);
});
test('/start не сбрасывает независимое ограничение отправки кода', async () => {
  let used = false; let emails = 0;
  const controller = await loadIsolated('controllers/userController.js', {
    './config/env.js': { env: { EMAIL_VERIFICATION_ENABLED: true, EMAIL_CODE_RESEND_COOLDOWN_MS: 60000, EMAIL_CODE_TTL_MS: 600000 } },
    './services/dbService.js': { ...stub(db), reserveVerificationSend: async () => { if (used) return 60000; used = true; return 0; },
      findGlpiUserByMaxId: async () => null, isMaxIdBlocked: async () => false },
    './state/sessionStore.js': { getSession: () => null, setSession: noop, deleteSession: noop },
    './services/emailService.js': { generateEmailVerificationCode: () => '123456', hashVerificationCode: () => 'synthetic', verifyCodeHash: () => true,
      sendEmailVerificationCode: async () => { emails++; } },
  });
  await controller.startEmailVerification(ctx(), 'fixture@example.test', 'new');
  await controller.entryPoint(ctx());
  await controller.startEmailVerification(ctx(), 'fixture@example.test', 'new');
  assert.equal(emails, 1);
});

test('сбой БД после создания заявки не оставляет подтверждение доступным для повтора', async () => {
  let session = { state: State.WAIT_TICKET_CONFIRM, ticketDraft: { title: 'fixture title', description: 'fixture description', files: [] } };
  let created = 0;
  const controller = await loadIsolated('controllers/ticketController.js', {
    './state/sessionStore.js': { getSession: () => structuredClone(session), deleteSession: noop,
      setSession: async (_id, value) => { if (created) throw Error('DB unavailable after create'); session = value; } },
    './services/dbService.js': { ...stub(db), findGlpiUserByMaxId: async () => ({ id: 42 }),
      saveBotUserTicket: async () => { throw Error('DB unavailable after create'); } },
    './services/glpiService.js': { ...stub(glpi), createGlpiUserTicket: async () => ({ ticketId: ++created, title: 'fixture' }) },
    './services/maxFileService.js': { cleanupDownloadedFiles: noop, collectDownloadedMaxAttachments: async () => [] },
  });
  const actions = new Map();
  controller.registerTicketActions({ action: (key, handler) => actions.set(key, handler) });
  await assert.rejects(actions.get('ticket:confirm_create')(ctx()), /DB unavailable/);
  await actions.get('ticket:confirm_create')(ctx());
  assert.equal(created, 1);
});
