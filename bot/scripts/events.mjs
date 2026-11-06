// Только внедрённые переменные; .env не загружается, payload не выводится.
import { readQueueConfig } from '../queue/config.js';
import { createQueueResources } from '../queue/resources.js';

let resources;
try {
  const config = readQueueConfig();
  resources = createQueueResources(process.env, config);
  const args = process.argv.slice(2);
  const action = args[0] || 'status';
  if (action === 'init' && args.length === 1) {
    await resources.store.ensureSchema();
    await resources.broadcasts.ensureSchema();
    console.log('Таблицы событий MAX и рассылок подготовлены.');
  } else if (['status', 'assert-drained'].includes(action) && args.length <= 1) {
    const status = await resources.store.stats();
    console.log(JSON.stringify({ ...status, problems: await resources.store.problems(), recent: await resources.store.recent(),
      broadcasts: await resources.broadcasts.stats() }, null, 2));
    if (action === 'assert-drained'
        && (!await resources.store.assertDrained() || !await resources.broadcasts.assertDrained())) process.exitCode = 2;
  } else if (action === 'resolve') {
    const values = new Map();
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--confirm') values.set('confirm', true);
      else if (['--id', '--action'].includes(args[i]) && args[i + 1]) values.set(args[i].slice(2), args[++i]);
      else throw new Error('Недопустимые аргументы');
    }
    if (!values.get('confirm') || !/^[1-9][0-9]{0,19}$/.test(values.get('id') || '')
        || !['skip', 'retry'].includes(values.get('action'))) {
      throw new Error('resolve требует --id N --action skip|retry --confirm; сначала проверьте результат операции GLPI');
    }
    const changed = await resources.store.resolveProblem(values.get('id'), values.get('action'));
    if (!changed) throw new Error('Событие не находится в FAILED/UNCERTAIN');
    console.log(`Состояние события ${values.get('id')} изменено: ${values.get('action')}`);
  } else {
    throw new Error('Команды: init, status, assert-drained, resolve --id N --action skip|retry --confirm');
  }
} catch (error) {
  // MySQL/AMQP могут включать данные запроса/URL в message: наружу только код.
  console.error('Команда очереди не выполнена:', /^[A-Z0-9_.-]{1,64}$/.test(error.code || '') ? error.code : 'EVENT_COMMAND_FAILED');
  process.exitCode = 1;
} finally { await resources?.pool.end(); }
