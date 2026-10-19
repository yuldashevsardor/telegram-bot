# Customer journey

What a person sees in the bot, step by step, and what the bot says at each step. The file
describes the journey the bot is meant to give. A step that is not built yet differs from the code,
and the code is the authority on what is built.

The texts are given in Russian, the default locale (`DEFAULT_LOCALE` in
`telegram/locale/locale.types.ts`). The `en` bundle carries the same keys with a translation,
written in the same PR as the Russian text. `{formats}` in a text is the list of supported formats
substituted from `ConvertorFactory.getSupportedExtensions()` by `SupportedFormats`
([`bot.md`](../architecture/bot.md), "Commands"). The rows of step 5 for a message that is not a
file and for an unsupported file list only the formats a file is taken in, those a pair starts from.
`{format}` is one format.

A format is written in upper case, in texts and on buttons alike: `TTF`, not `ttf`. Wherever the
bot lists formats, the list and the buttons go in one order: TTF, OTF, WOFF, WOFF2, EOT, SVG.

`{contact}` is how to reach the author of the bot. It is a configuration value, `BOT_AUTHOR_CONTACT`
(`.env.dist`), not a text of the `.ftl`: the contact changes without a change of the texts.
`{maxDownloadSizeMb}` is the size limit of a file the same way, `BOT_MAX_DOWNLOAD_SIZE`, 20 MB by
default (see "5. Errors"), and `{maxUploadSizeMb}` that of the files the bot sends in one message,
`BOT_MAX_UPLOAD_SIZE`, 50 MB by default.

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
> Вопросы и ошибки: {contact}.

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

The buttons are the supported formats without the source one, in the order above, three to a row,
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
message after it names the failed formats. A Telegram album holds at least two files: a single
result comes as a plain document, and when every conversion fails, the message naming the failed
formats is the whole answer.

A result over {maxUploadSizeMb} MB is not sent: the other results still go, and a message after
them names it (see "5. Errors"). A source under the download limit can give one: an SVG grows
several times over a compact source. Results that add up past {maxUploadSizeMb} MB come in several
albums, in the order of the buttons, a result left alone as a plain document.

## 4. Again

The buttons stay under the question, and after a conversion they show what it has done: `✓ TTF`
for a format sent, `✗ SVG` for one that failed, on our side or over {maxUploadSizeMb} MB. A repeat
of either gives the same outcome. "Все форматы" marks every format by its own outcome and itself
stays as it is: a press of it converts every format again.

A marked button converts nothing: its press is answered with a toast over the chat, a row of the
table of step 5. An unmarked one works later too. A quick double tap of the same button converts
twice, since the second tap comes before the first one has marked the button: an extra file is
accepted. A press of another button made while a conversion runs comes before the marks too: when
it is done, the marks of the conversion before it are gone, and their buttons convert again.

When the bot can no longer get the source file, it answers the button with a request to send the
file again.

## 5. Errors

| Situation | Text |
|---|---|
| A message that is not a file: text, a photo, a sticker, a voice | Пришлите шрифт файлом — {formats}. |
| An unknown command | The `/help` text. |
| A file with no extension or with an unsupported one | «{filename}» — не шрифт или формат, который я не знаю. Поддерживаю: {formats}. |
| A file over {maxDownloadSizeMb} MB | Файл больше {maxDownloadSizeMb} МБ — Telegram не даёт ботам скачивать такие файлы. |
| The extension names a format, and the file is not in it (`NotWoff` and its siblings) | Файл назван как {format}, но внутри не {format}. Возможно, у него не то расширение. |
| The file is in the format but breaks its rules (`BrokenWoff` and its siblings) | Файл похож на {format}, но повреждён. Попробуйте скачать шрифт заново из источника. |
| The conversion failed on our side | Не получилось сконвертировать в {format}. Это ошибка на нашей стороне — попробуйте другой формат. |
| "Все форматы", some conversions failed | Не получилось: {formats}. |
| A result over {maxUploadSizeMb} MB, for one format and for "Все форматы" alike | Не получилось отправить {formats}: больше {maxUploadSizeMb} МБ — Telegram не даёт ботам отправлять такие файлы. |
| A button whose source file the bot can no longer get | Этот файл больше недоступен — пришлите его ещё раз. |
| A press of a button marked `✓`, as a toast (step 4) | {format} уже отправлен — он выше в чате. |
| A press of a button marked `✗`, as a toast (step 4) | {format} из этого файла не получается — повтор даст то же самое. |
| Any other failure: Telegram did not give the file, an error in the code | Что-то пошло не так. Попробуйте ещё раз чуть позже. Если не пройдёт — напишите автору: {contact}. |

The last row goes out once, when the handling of the update has failed for good and blocked its
group ([`inbox.md`](../architecture/inbox.md), "The answer to the sender"), not on every attempt the
inbox retries. It needs the chat to be reachable: when the failure is that the bot cannot send to
Telegram, the answer cannot go out either. Nor does it follow a reply that timed out in the outbox:
that reply may still reach the person. Nor a request Telegram refused as too large, a 413: the
handling fails without blocking the group, and the person gets only what went out before it. When
Telegram refused a reply of the handler and the outbox blocked the chat for it, the answer waits
behind that reply until the chat is unblocked by hand.
The answer can also follow a reply that did go out, when the handling failed after it.

20 MB, the default of `{maxDownloadSizeMb}`, is the limit of the Bot API on files a bot downloads
(`getFile`). A file over it never reaches the bot, so the check goes by the size Telegram reports in
the message.

An album of photos gets the first row once, not once per photo.

A document the Bot API gives no name (the clients of Telegram always send one) gets the row of an
unsupported file with «Файл» in place of the quoted name: "Файл — не шрифт или формат, который я не
знаю. Поддерживаю: {formats}."

An SVG with no font in it, a drawing, gets the row of a file not in its format: the format is an
SVG font. So does a font collection (TTC) named `.ttf` or `.otf`: it is sound, and the advice to
download a damaged font again would not help it. A WOFF or a WOFF2 file of a collection gets the row
of a broken file: it is in its format, and no row fits it (the owner's decision in PR #1012).

When Telegram itself refuses to give a file for its size (the message reported no size, or a
smaller one than the limit), the limit that refused it is unknown, and the row of a file over
{maxDownloadSizeMb} MB goes without the number: "Файл слишком большой — Telegram не даёт ботам
скачивать такие файлы."

## 6. /help

> Как пользоваться:
> 1. Пришлите файл шрифта.
> 2. Выберите формат на кнопках.
> 3. Получите файл.
>
> Форматы: {formats}.
> Размер файла — до {maxDownloadSizeMb} МБ.
> Несколько файлов можно прислать сразу: отвечу на каждый.
>
> Вопросы и ошибки: {contact}.

The help promises nothing about storing files: the temporary conversion files are kept on the
server (issue #37), and a promise to delete them would be false.

## 7. The command menu

| Command | Description | Who sees it |
|---|---|---|
| `/start` | Начать | everyone |
| `/help` | Как пользоваться | everyone |

The service commands are not in the common menu. `/bulk_messages` stays for the load runs and is
shown only in the chats of its own `CHAT_IDS`, through a command scope of a chat
(`BotCommandScopeChat`).

## Outside the journey

Not part of this journey, each a decision of its own when it comes:

- an archive of all formats;
- a family of files answered as one group;
- telling the real format by content when the extension lies;
- a language switcher or other settings;
- a history of conversions.
