import { Context } from '@maxhub/max-bot-api';

export class WebhookContext extends Context {
  async reply(text, extra) {
    // MAX допускает callback без исходного сообщения. У личного бота остаётся
    // user_id: отвечаем в личный диалог, не подставляем user_id вместо chat_id.
    if (this.updateType === 'message_callback' && this.chatId == null && this.user?.user_id) {
      return this.api.sendMessageToUser(this.user.user_id, text, extra);
    }
    return super.reply(text, extra);
  }
}
