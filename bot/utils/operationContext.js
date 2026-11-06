import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function createOperationScope(report, reportReply = () => {}) {
  const state = { phase: 'handler', failures: new Map(), terminal: null, report, reportReply, ambiguousEffects: new Set() };
  return {
    run: action => storage.run(state, async () => {
      try { return await withOperation('handler', action); }
      catch (error) { state.terminal = { error }; throw error; }
    }),
    get failedPhase() { return state.terminal ? state.failures.get(state.terminal.error) ?? null : null; },
    get ambiguousEffects() { return [...state.ambiguousEffects]; },
  };
}

// Неизвестный результат POST нельзя превращать в безопасный повтор через catch.
export function recordAmbiguousEffect(kind) {
  storage.getStore()?.ambiguousEffects.add(kind);
}

// Только исход отправки; текст, адресат и ответ MAX в диагностику не передаются.
export function recordMaxReply(result) {
  storage.getStore()?.reportReply(result);
}

export async function withOperation(phase, action) {
  const state = storage.getStore();
  if (!state) return action();
  const previous = state.phase;
  state.phase = phase;
  state.report(phase);
  try { return await action(); }
  catch (error) {
    if (!state.failures.has(error)) state.failures.set(error, phase);
    throw error;
  }
  finally { state.phase = previous; state.report(previous); }
}
