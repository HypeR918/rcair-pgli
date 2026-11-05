import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function createOperationScope(report) {
  const state = { phase: 'handler', failures: new Map(), terminal: null, report };
  return {
    run: action => storage.run(state, async () => {
      try { return await withOperation('handler', action); }
      catch (error) { state.terminal = { error }; throw error; }
    }),
    get failedPhase() { return state.terminal ? state.failures.get(state.terminal.error) ?? null : null; },
  };
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
