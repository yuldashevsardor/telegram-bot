// A negative chat ID is the Telegram convention for groups and supergroups. The check has a file of
// its own because two unconnected places need it: the limit resolver and the methods a group calls
// past OutboxTransformer. OutboxStore.pull() repeats the rule in SQL (chat_id < 0): a change here
// goes there too.
export function isGroupChat(chatId: number): boolean {
    // Stryker disable next-line EqualityOperator: `<=` is equivalent: it diverges only on chat ID 0, and Telegram has no such chat — a call to it is rejected under any limit and on any path
    return chatId < 0;
}
