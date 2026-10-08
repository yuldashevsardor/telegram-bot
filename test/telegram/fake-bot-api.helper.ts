import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { constants as httpStatus } from "node:http2";
import type { AddressInfo } from "node:net";
import { Api } from "grammy";
import type { ApiResponse } from "grammy/types";
import { TelegramApiFactory } from "app/telegram/telegram-api-factory";

// grammY sends a file as a part of multipart/form-data named by an id, and the field of the file as
// this prefix and the id (payloadToMultipartItr() in its core/payload.js).
const ATTACH_PREFIX = "attach://";
const HEADERS_END = "\r\n\r\n";

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
}

// grammY writes each field of multipart/form-data as a part named by the field, the file as a part
// named by its id with the file name in its headers, and the field of the file as attach://<id>.
function readPayload(contentType: string, body: string): Record<string, unknown> {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];

    if (boundary === undefined) {
        return JSON.parse(body) as Record<string, unknown>;
    }

    const fields = new Map<string, string>();
    const files = new Map<string, BotApiFile>();

    for (const part of body.split(`--${boundary}`)) {
        const headersEnd = part.indexOf(HEADERS_END);
        const headers = part.slice(0, headersEnd);
        const name = /name="([^"]+)"/.exec(headers)?.[1];

        if (headersEnd === -1 || name === undefined) {
            continue;
        }

        const value = part.slice(headersEnd + HEADERS_END.length).replace(/\r\n$/, "");
        const filename = /filename=([^\r\n;]+)/.exec(headers)?.[1];

        if (filename === undefined) {
            fields.set(name, value);
        } else {
            files.set(name, { filename: filename, content: value });
        }
    }

    // A file goes into the field that refers to it, not into a field of its own.
    const payload: Record<string, unknown> = {};

    for (const [name, value] of fields) {
        payload[name] = value.startsWith(ATTACH_PREFIX) ? files.get(value.slice(ATTACH_PREFIX.length)) : value;
    }

    return payload;
}

// A file of a call as grammY uploaded it.
export type BotApiFile = { filename: string; content: string };

// A call as the fake Bot API received it.
export type BotApiCall = {
    // Tells apart the Apis that call: each may call with a token of its own.
    token: string;
    method: string;
    // The fields of the call; the field of a file holds the file, its content read as text. A JSON
    // body keeps the types of its values, while every field of multipart/form-data is a string: the
    // chat_id of sendDocument is "5000000001" where that of sendMessage is 5000000001.
    payload: Record<string, unknown>;
    receivedAtMs: number;
};

// What the fake Bot API answers a call with: callIndex is its place among the calls received, from
// 0. The answer of a call left unanswered is a promise that never settles.
export type BotApiAnswerScript = (call: BotApiCall, callIndex: number) => ApiResponse<unknown> | Promise<ApiResponse<unknown>>;

// A Bot API on a local port of 127.0.0.1: it takes the calls grammY sends to the apiRoot it is
// given, <apiRoot>/bot<token>/<method> with a JSON body, or multipart/form-data for a call with a
// file, and answers each by the script of the spec, in the HTTP status as in the body, as Telegram
// does. Until a spec gives a script, it answers every call as Telegram answers an unknown method.
export class FakeBotApi {
    public readonly calls: BotApiCall[] = [];
    private answer: BotApiAnswerScript = () => ({
        ok: false,
        error_code: httpStatus.HTTP_STATUS_NOT_FOUND,
        description: "Not Found: method not found",
    });
    // A failure of the server itself, a bug of the spec. grammY takes the reset socket for a failed
    // call, which the outbox retries, so the failure surfaces only through throwIfFailed().
    private readonly failures: unknown[] = [];
    private readonly server: Server = createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
            this.failures.push(error);
            response.destroy();
        });
    });

    // Resolves with the apiRoot of the server.
    public async start(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        const { port } = this.server.address() as AddressInfo;

        return `http://127.0.0.1:${port}`;
    }

    // grammY keeps its connections alive, and close() alone would wait for them; a call left
    // unanswered is cut off with its connection.
    public async close(): Promise<void> {
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    public answerWith(script: BotApiAnswerScript): void {
        this.answer = script;
    }

    public callsTo(chatId: number): BotApiCall[] {
        return this.calls.filter((call) => Number(call.payload["chat_id"]) === chatId);
    }

    public throwIfFailed(): void {
        if (this.failures.length > 0) {
            throw this.failures[0];
        }
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const receivedAtMs = Date.now();
        const [, token = "", method = ""] = /^\/bot([^/]+)\/([^/]+)$/.exec(request.url ?? "") ?? [];
        const call: BotApiCall = { token: token, method: method, payload: {}, receivedAtMs: receivedAtMs };
        // The call takes its place when it arrives, before its body is read: a large upload read
        // alongside a small call would otherwise take a place after it.
        const callIndex = this.calls.push(call) - 1;
        call.payload = readPayload(request.headers["content-type"] ?? "", await readBody(request));
        const answer = await this.answer(call, callIndex);

        response.writeHead(answer.ok ? httpStatus.HTTP_STATUS_OK : answer.error_code, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
    }
}

// The Api of the outbox and of the polling source of the inbox, pointed at the fake Bot API. It
// repeats TelegramApiFactory.create() with the apiRoot added: an option the production factory
// gets has to be added here too, or the specs run an Api without it.
export class FakeBotApiFactory extends TelegramApiFactory {
    public constructor(private readonly token: string, private readonly apiRoot: string) {
        super(token);
    }

    public override create(timeoutSeconds: number): Api {
        return new Api(this.token, { apiRoot: this.apiRoot, timeoutSeconds: timeoutSeconds });
    }
}
