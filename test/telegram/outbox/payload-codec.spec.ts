import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { expect } from "chai";
import { InlineKeyboard, InlineQueryResultBuilder, InputFile, Keyboard } from "grammy";
import { deserialize, serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import {
    InvalidFileMarker,
    ReservedFileKey,
    UnstorableString,
    UnsupportedInputFile,
    UnsupportedValue,
} from "app/telegram/outbox/payload-codec/payload-codec.errors";
import { PathFile } from "app/telegram/path-file/path-file";

describe("Outbox payload codec", function () {
    it("keeps a plain JSON payload through the round trip", function () {
        const payload = {
            chat_id: -100123,
            text: "hello",
            disable_notification: false,
            reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "ok" }]] },
            entities: [],
            link_preview_options: null,
        };

        expect(roundTrip("sendMessage", payload)).to.deep.equal(payload);
    });

    it("stores a path file as a marker with its path and file name", function () {
        const payload = { chat_id: 1, document: new PathFile("/data/fonts/result.woff2") };

        // The marker is the stored format: rows already in the table are read back by it.
        expect(serialize("sendDocument", payload)).to.deep.equal({
            chat_id: 1,
            document: { $pathFile: { path: "/data/fonts/result.woff2", filename: "result.woff2" } },
        });
    });

    it("rebuilds a path file from its marker", function () {
        const payload = { chat_id: 1, document: new PathFile("/data/fonts/result.woff2", "Font.woff2"), caption: "done" };

        const restored = roundTrip("sendDocument", payload);

        expect(restored["document"]).to.be.instanceOf(PathFile);
        expect((restored["document"] as PathFile).path).to.equal("/data/fonts/result.woff2");
        expect((restored["document"] as PathFile).filename).to.equal("Font.woff2");
        expect(restored["caption"]).to.equal("done");
        expect(serialize("sendDocument", restored)).to.deep.equal(serialize("sendDocument", payload));
    });

    it("rebuilds path files inside media[]", function () {
        const payload = {
            chat_id: 1,
            media: [
                { type: "document", media: new PathFile("/data/fonts/a.ttf") },
                { type: "document", media: "AgACAgIAAxkBAAI", caption: "by file_id" },
                { type: "document", media: new PathFile("/data/fonts/b.otf"), thumbnail: new PathFile("/data/fonts/b.jpg") },
            ],
        };

        const restored = roundTrip("sendMediaGroup", payload);
        const media = restored["media"] as Array<Record<string, unknown>>;

        expect(media[0]?.["media"]).to.be.instanceOf(PathFile);
        expect(media[1]).to.deep.equal(payload.media[1]);
        expect(media[2]?.["thumbnail"]).to.be.instanceOf(PathFile);
        expect(serialize("sendMediaGroup", restored)).to.deep.equal(serialize("sendMediaGroup", payload));
    });

    it("keeps undefined as it is", function () {
        const serialized = serialize("sendMessage", { chat_id: 1, text: "hello", message_thread_id: undefined });

        expect(serialized).to.have.property("message_thread_id", undefined);
    });

    it("stores grammY's keyboards by their fields, as JSON does", function () {
        const inline = new InlineKeyboard().text("ok", "ok");
        const reply = new Keyboard().text("yes").resized().oneTime();

        const serialized = serialize("sendMessage", { chat_id: 1, reply_markup: inline, keyboard: reply });

        expect(serialized["reply_markup"]).to.deep.equal(JSON.parse(JSON.stringify(inline)));
        expect(serialized["keyboard"]).to.deep.equal(JSON.parse(JSON.stringify(reply)));
    });

    it("drops the builder methods an inline query result keeps, as JSON does", function () {
        const result = InlineQueryResultBuilder.photo("id0", "https://example.com/a.jpg");

        const stored = JSON.parse(JSON.stringify(serialize("answerInlineQuery", { inline_query_id: "q", results: [result] })));

        expect(stored).to.deep.equal({ inline_query_id: "q", results: [JSON.parse(JSON.stringify(result))] });
    });

    describe("rejects a value it does not take, naming the method and the place", function () {
        const values: Array<[string, () => unknown]> = [
            ["a Date", (): unknown => new Date(0)],
            ["a Map", (): unknown => new Map()],
            ["a class instance", (): unknown => new Holder(1)],
            ["a class instance hiding a file", (): unknown => new Holder(new InputFile(Buffer.from("font")))],
            ["an object without a prototype", (): unknown => Object.create(null) as object],
            ["a boxed string", (): unknown => new String("hi")],
            ["a bigint", (): unknown => 1n],
            ["a symbol", (): unknown => Symbol("s")],
        ];

        for (const [name, value] of values) {
            it(`such as ${name}`, function () {
                expect(() => serialize("sendMessage", { chat_id: 1, entities: [value()] }))
                    .to.throw(UnsupportedValue, "sendMessage got a value at entities.0 that the outbox does not store")
                    .with.deep.property("payload", { method: "sendMessage", path: "entities.0" });
            });
        }

        it("as the root", function () {
            expect(() => serialize("sendMessage", new Holder(1)))
                .to.throw(UnsupportedValue)
                .with.deep.property("payload", { method: "sendMessage", path: "the root" });
        });
    });

    describe("rejects an object that already carries the marker key, naming the method and the place", function () {
        const payloads: Array<[string, () => object, string]> = [
            [
                "in media[]",
                (): object => ({ chat_id: 1, media: [{ type: "document", media: { $pathFile: { path: "/etc/passwd" } } }] }),
                "media.0.media",
            ],
            ["at the root", (): object => ({ chat_id: 1, $pathFile: { path: "/etc/passwd" } }), "the root"],
        ];

        for (const [name, payload, path] of payloads) {
            it(name, function () {
                expect(() => serialize("sendMediaGroup", payload()))
                    .to.throw(ReservedFileKey, `sendMediaGroup got an object with the key $pathFile at ${path}`)
                    .with.deep.property("payload", { method: "sendMediaGroup", key: "$pathFile", path: path });
            });
        }
    });

    describe("rejects a string jsonb does not store", function () {
        const payloads: Array<[string, () => object, string]> = [
            ["U+0000 in a string", (): object => ({ chat_id: 1, caption: "Font\u0000Name" }), "caption"],
            ["U+0000 in a key", (): object => ({ chat_id: 1, reply_markup: { "a\u0000b": 1 } }), "reply_markup.a\u0000b"],
            [
                "U+0000 in the path of a path file",
                (): object => ({ chat_id: 1, document: new PathFile("/data/a\u0000.ttf", "a.ttf") }),
                "document.path",
            ],
            [
                "U+0000 in the file name of a path file",
                (): object => ({ chat_id: 1, document: new PathFile("/data/a.ttf", "Font\u0000.ttf") }),
                "document.filename",
            ],
            ["a lone surrogate in a string", (): object => ({ chat_id: 1, caption: "cut \ud83d" }), "caption"],
            ["a lone surrogate in a key", (): object => ({ chat_id: 1, reply_markup: { "\udc00": 1 } }), "reply_markup.\udc00"],
        ];

        for (const [name, payload, path] of payloads) {
            it(`with ${name}`, function () {
                expect(() => serialize("sendDocument", payload()))
                    .to.throw(UnstorableString, `sendDocument got a string or a key at ${path} that PostgreSQL does not store in jsonb`)
                    .with.deep.property("payload", { method: "sendDocument", path: path });
            });
        }

        it("but keeps a surrogate pair", function () {
            expect(serialize("sendMessage", { chat_id: 1, text: "ok 😀" })).to.deep.equal({ chat_id: 1, text: "ok 😀" });
        });
    });

    it("rebuilds a marker without a file name, letting grammY take it from the path", function () {
        const restored = deserialize({ document: { $pathFile: { path: "/data/fonts/result.woff2" } } });

        expect((restored["document"] as PathFile).filename).to.equal("result.woff2");
    });

    describe("rejects a malformed file marker", function () {
        const markers: Array<[string, unknown]> = [
            ["null", { $pathFile: null }],
            ["a string", { $pathFile: "/data/fonts/result.woff2" }],
            ["no path", { $pathFile: { filename: "result.woff2" } }],
            ["a path that is not a string", { $pathFile: { path: 42, filename: "result.woff2" } }],
            ["an empty path", { $pathFile: { path: "" } }],
            ["a relative path", { $pathFile: { path: "fonts/result.woff2" } }],
            ["a file name that is not a string", { $pathFile: { path: "/data/fonts/result.woff2", filename: 42 } }],
            ["a field other than path and file name", { $pathFile: { path: "/data/fonts/result.woff2", size: 1 } }],
            ["a key beside the marker key", { $pathFile: { path: "/data/fonts/result.woff2" }, caption: "c" }],
        ];

        for (const [name, marker] of markers) {
            it(`with ${name}`, function () {
                expect(() => deserialize({ chat_id: 1, media: [{ media: marker }] }))
                    .to.throw(InvalidFileMarker, "file marker")
                    .with.deep.property("payload", { marker: marker });
            });
        }
    });

    describe("rejects an InputFile that is not a PathFile, naming the method and the place", function () {
        const sources: Array<[string, () => ConstructorParameters<typeof InputFile>[0]]> = [
            ["a path", (): string => "/data/fonts/result.woff2"],
            ["a Buffer", (): Buffer => Buffer.from("font")],
            ["a Uint8Array", (): Uint8Array => new Uint8Array([1, 2])],
            ["a stream", (): Readable => Readable.from([new Uint8Array([1])])],
            ["an iterable", (): Uint8Array[] => [new Uint8Array([1])]],
            ["an async iterable", (): AsyncGenerator<Uint8Array> => (async function* (): AsyncGenerator<Uint8Array> {})()],
            ["a supplier function", (): (() => Buffer) => (): Buffer => Buffer.from("font")],
            ["a URL", (): URL => new URL("https://example.com/font.woff2")],
            ["a URL-like object", (): { url: string } => ({ url: "https://example.com/font.woff2" })],
        ];

        for (const [name, source] of sources) {
            it(`from ${name}`, function () {
                const payload = { chat_id: 1, document: new InputFile(source()) };

                expect(() => serialize("sendDocument", payload))
                    .to.throw(UnsupportedInputFile, "sendDocument got an InputFile that is not a PathFile at document")
                    .with.deep.property("payload", { method: "sendDocument", path: "document" });
            });
        }

        it("from a file stream", function () {
            const stream = createReadStream(__filename);
            const payload = { chat_id: 1, document: new InputFile(stream) };

            try {
                expect(() => serialize("sendDocument", payload)).to.throw(UnsupportedInputFile, "sendDocument");
            } finally {
                stream.destroy();
            }
        });

        it("inside media[]", function () {
            const payload = {
                chat_id: 1,
                media: [
                    { type: "document", media: new PathFile("/data/fonts/a.ttf") },
                    { type: "document", media: new PathFile("/data/fonts/b.ttf"), thumbnail: new InputFile(Buffer.from("jpg")) },
                ],
            };

            expect(() => serialize("sendMediaGroup", payload))
                .to.throw(UnsupportedInputFile, "sendMediaGroup")
                .with.deep.property("payload", { method: "sendMediaGroup", path: "media.1.thumbnail" });
        });

        it("as the root", function () {
            expect(() => serialize("sendDocument", new InputFile(Buffer.from("font"))))
                .to.throw(UnsupportedInputFile, "sendDocument got an InputFile that is not a PathFile at the root")
                .with.deep.property("payload", { method: "sendDocument", path: "the root" });
        });
    });
});

class Holder {
    public constructor(public readonly item: unknown) {}
}

// The row is written and read through JSON, so the round trip goes through it as well.
function roundTrip(method: string, payload: object): Record<string, unknown> {
    return deserialize(JSON.parse(JSON.stringify(serialize(method, payload))) as Record<string, unknown>);
}
