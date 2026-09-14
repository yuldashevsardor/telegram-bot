// Отрицательный chat ID — соглашение Telegram для групп и супергрупп. Признак живёт отдельным
// файлом, потому что нужен и резолверу лимита, и белому списку методов в TelegramCallApiMiddleware,
// а между собой эти два места не связаны.
export function isGroupChat(chatId: number): boolean {
    // Stryker disable next-line EqualityOperator: `<=` — эквивалентен: расходится только на chat ID 0, а такого чата в Telegram нет, и вызов к нему отвергнут при любом лимите и пути
    return chatId < 0;
}
