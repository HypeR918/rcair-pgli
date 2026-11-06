import amqp from 'amqplib';

function unavailable() {
  const error = new Error('RabbitMQ недоступен'); error.code = 'RABBITMQ_UNAVAILABLE'; return error;
}

export async function connectRabbit({ url, queue = 'max.webhook.events.v1', prefetch = 4 }, { onClose = () => {} } = {}) {
  let connection;
  let closing = false;
  let closed = false;
  let notified = false;
  const lost = () => {
    closed = true;
    if (!closing && !notified) {
      notified = true;
      onClose();
      connection?.close().catch(() => {});
    }
  };
  try {
    connection = await amqp.connect(url, { timeout: 5000 });
    connection.on('error', lost); // В исходном Error может находиться URL с паролем.
    connection.on('close', lost);
    const publish = await connection.createConfirmChannel();
    const consume = await connection.createChannel();
    for (const channel of [publish, consume]) {
      channel.on('error', lost);
      channel.on('close', lost);
    }
    const dead = `${queue}.dead`;
    await publish.assertQueue(dead, { durable: true });
    await publish.assertQueue(queue, { durable: true, arguments: {
      'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': dead,
    } });
    await consume.prefetch(prefetch);
    let tag;
    async function send(id, isDead = false) {
      if (closed || closing) throw unavailable();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(unavailable());
          connection.close().catch(() => {});
        }, 5000);
        const done = error => { clearTimeout(timer); error ? reject(unavailable()) : resolve(); };
        try {
          publish.sendToQueue(isDead ? dead : queue, Buffer.from(JSON.stringify({ id: String(id) })),
            { persistent: true, contentType: 'application/json', messageId: String(id) }, done);
        } catch { done(true); }
      });
    }
    return {
      get connected() { return !closed && !closing; },
      publish: send,
      async consume(handler) {
        const result = await consume.consume(queue, message => {
          if (!message) { if (!closing) onClose(); return; }
          let id;
          try {
            if (message.content.length > 100) throw new Error();
            id = JSON.parse(message.content.toString()).id;
            if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) throw new Error();
          } catch { consume.reject(message, false); return; }
          Promise.resolve().then(() => handler(id)).then(async result => {
            if (result?.dead) await send(id, true);
          }).catch(() => {
            // Строка БД остаётся источником истины и будет восстановлена/переиздана.
          }).finally(() => {
            if (!closed && !closing) { try { consume.ack(message); } catch {} }
          });
        }, { noAck: false, exclusive: true });
        tag = result.consumerTag;
      },
      async cancel() {
        if (tag && !closed) { const current = tag; tag = null; await consume.cancel(current); }
      },
      async close() {
        closing = true;
        try { if (tag && !closed) await consume.cancel(tag); } catch {}
        try { await connection.close(); } catch {}
      },
    };
  } catch {
    closing = true;
    try { await connection?.close(); } catch {}
    throw unavailable();
  }
}
