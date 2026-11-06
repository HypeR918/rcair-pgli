// Только внедрённые настройки; текст и адресаты не выводятся.
import { readQueueConfig } from '../queue/config.js';
import { createQueueResources } from '../queue/resources.js';

let resources;
try {
  resources = createQueueResources(process.env, readQueueConfig());
  const [action, ...args] = process.argv.slice(2);
  if (action === 'status' && args.length <= 1) {
    const result = args.length ? await resources.broadcasts.status(args[0]) : await resources.broadcasts.stats();
    if (!result) throw new Error('Задание не найдено');
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'resolve') {
    const values = new Map();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--confirm') values.set('confirm', true);
      else if (['--id', '--action'].includes(args[i]) && args[i + 1]) values.set(args[i].slice(2), args[++i]);
      else throw new Error('Недопустимые аргументы');
    }
    if (!values.get('confirm') || !/^[1-9][0-9]{0,19}$/.test(values.get('id') || '')
        || !['retry', 'skip'].includes(values.get('action'))) throw new Error('Нужны id, action и confirm');
    if (!await resources.broadcasts.resolveProblem(values.get('id'), values.get('action'))) throw new Error('Отправка не в FAILED/UNCERTAIN');
    console.log('Состояние отправки изменено.');
  } else throw new Error('Команды: status [job_id], resolve --id delivery_id --action skip|retry --confirm');
} catch (error) {
  console.error('Команда рассылки не выполнена:', /^[A-Z0-9_.-]{1,64}$/.test(error.code || '') ? error.code : 'BROADCAST_COMMAND_FAILED');
  process.exitCode = 1;
} finally { await resources?.pool.end(); }
