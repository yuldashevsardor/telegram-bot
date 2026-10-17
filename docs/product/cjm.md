# Customer journey

What a person sees in the bot, step by step, and what the bot says at each step. The file
describes the journey the bot is meant to give. A step that is not built yet differs from the code,
and the code is the authority on what is built: today `/start` greets and echoes the next message
(`StartConversation`), and no handler takes a file.

The texts are given in Russian, the default locale (`DEFAULT_LOCALE` in
`telegram/locale/locale.types.ts`). The `en` bundle carries the same keys with a translation,
written in the same PR as the Russian text. `{formats}` in a text is the list of supported formats
substituted from `ConvertorFactory.getSupportedExtensions()`, as the welcome does today
([`i18n.md`](../architecture/i18n.md)).

The journey covers private chats only: `IsPrivateChatFilter` drops updates of every other chat
([`bot.md`](../architecture/bot.md)).

## Decisions

- **File first, format second.** The person sends a font. The bot names its format and offers the
  other formats as buttons. Nothing is chosen in advance, and the source format is never offered.
- **"All formats" sends separate files**, not an archive: nothing to unpack on a phone.
- **Several files are answered one by one.** Each file gets its own question with its own
  buttons. A family is not grouped.
- **The language follows Telegram**: `ctx.from.language_code`, no switcher.

## 0. Before Start

An empty chat with the bot shows the bot description; the profile and a shared link show the short
description. Both are set from the code at startup, per locale, as the commands are
(`setMyDescription`, `setMyShortDescription`), so the list of formats in them comes from the pair
matrix instead of a text typed into BotFather.

Description:

> Конвертирую шрифты между форматами {formats}. Пришлите файл — верну его в нужном формате.

Short description:

> Конвертер шрифтов: {formats}.

## 1. /start

A plain reply, not a conversation: after it the bot waits for no particular answer, and the next
file goes to step 2. A repeated `/start` gives the same text.

> Пришлите файл шрифта — сконвертирую его в другой формат.
> Форматы: {formats}.
> Можно прислать несколько файлов сразу: отвечу на каждый.

## 2. A file arrives

The bot checks the file before it offers anything: the size, the extension, then the whole file by
the format the extension names (validation, `CONTEXT.md`). A file that fails gets an error from the
table below and no buttons.

A file that passes gets a reply to its message, here for a WOFF source:

> Это {format}. Во что сконвертировать?

```
[ TTF ] [ OTF ] [ WOFF2 ]
[ EOT ] [ SVG ]
[    Все форматы    ]
```

The buttons are the supported formats without the source one, in a fixed order, three to a row,
and "Все форматы" on a row of its own.

## 3. A format is chosen

- The button is answered at once, so the client stops its spinner.
- While the conversion runs, the chat header shows "отправляет файл…" (the `upload_document` chat
  action).
- The result comes as a document in reply to the source file. Its name is the name of the source
  with the extension of the target: `MyFont.woff` → `MyFont.ttf`. The domain names the conversion
  result at random (`FontConvertor`); the name the person sees is set by the bot at delivery.
- No caption: the name and the reply already say what it is.

"Все форматы" converts into every offered format and sends the results as one album of documents
in reply to the source file. When some conversions fail, the album carries the rest, and one
message after it names the failed formats.

## 4. Again

The buttons stay under the question. Any of them works later too, the same format again included.
When the bot can no longer get the source file, it answers the button with a request to send the
file again.

## 5. Errors

| Situation | Text |
|---|---|
| A message that is not a file: text, a photo, a sticker, a voice | Пришлите шрифт файлом — {formats}. |
| An unknown command | The `/help` text. |
| A file with no extension or with an unsupported one | «{filename}» — не шрифт или формат, который я не знаю. Поддерживаю: {formats}. |
| A file over 20 MB | Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы. |
| The extension names a format, and the file is not in it (`NotWoff` and its siblings) | Файл назван как {format}, но внутри не {format}. Возможно, у него не то расширение. |
| The file is in the format but breaks its rules (`BrokenWoff` and its siblings) | Файл похож на {format}, но повреждён. Попробуйте скачать шрифт заново из источника. |
| The conversion failed on our side | Не получилось сконвертировать в {format}. Это ошибка на нашей стороне — попробуйте другой формат. |
| "Все форматы", some conversions failed | Не получилось: {formats}. |
| A button whose source file the bot can no longer get | Этот файл больше недоступен — пришлите его ещё раз. |

20 MB is the limit of the Bot API on files a bot downloads (`getFile`). A file over it never
reaches the bot, so the check goes by the size Telegram reports in the message.

## 6. /help

> Как пользоваться:
> 1. Пришлите файл шрифта.
> 2. Выберите формат на кнопках.
> 3. Получите файл.
>
> Форматы: {formats}.
> Размер файла — до 20 МБ.
> Несколько файлов можно прислать сразу: отвечу на каждый.

The help promises nothing about storing files: the temporary conversion files are kept on the
server (issue #37), and a promise to delete them would be false.

## 7. The command menu

| Command | Description | Who sees it |
|---|---|---|
| `/start` | Начать | everyone |
| `/help` | Как пользоваться | everyone |

The service commands leave the common menu. `/font_generator` converts a test fixture and replies
with server paths: the journey above replaces it, and it goes away. `/bulk_messages` stays for the
load runs and is shown only in the chats of its own `CHAT_IDS`, through a command scope of a chat
(`BotCommandScopeChat`).

## Outside the journey

Not part of this journey, each a decision of its own when it comes:

- an archive of all formats;
- a family of files answered as one group;
- telling the real format by content when the extension lies;
- a language switcher or other settings;
- a history of conversions.
