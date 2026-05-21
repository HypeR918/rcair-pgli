import telebot
from telebot import types
bot = telebot.TeleBot("8978556644:AAHAIM60gPqv4usJ1usvvcjcUiwGyqSJ0eE")
@bot.message_handler(commands = ['start'])
def start_message(message):
    bot.send_message(message.chat.id, "Здравствуйте, это бот для инженеров, для авторизации введите свою почту из профиля glpi")
bot.infinity_polling()