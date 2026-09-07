// Отрицательный chat ID — соглашение Telegram для групп и супергрупп. Признак живёт отдельным
// файлом, потому что нужен и резолверу лимита, и белому списку методов в TelegramCallApiMiddleware,
// а между собой эти два места не связаны.
export function isGroupChat(chatId: number): boolean {
    return chatId < 0;
}
