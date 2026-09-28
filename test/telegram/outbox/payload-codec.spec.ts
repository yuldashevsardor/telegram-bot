import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { expect } from "chai";
import { InlineKeyboard, InputFile } from "grammy";
import { deserialize, serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import {
    CyclicPayload,
    InvalidFileMarker,
    ReservedFileKey,
    UnstorableString,
    UnsupportedBigInt,
    UnsupportedInputFile,
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

    it("keeps undefined as it is and takes a value with toJSON() by its JSON form", function () {
        const payload = { chat_id: 1, text: "hello", message_thread_id: undefined, date: new Date(0) };

        const serialized = serialize("sendMessage", payload);

        expect(serialized).to.have.property("message_thread_id", undefined);
        expect(serialized["date"]).to.equal("1970-01-01T00:00:00.000Z");
    });

    it("walks what toJSON() returns", function () {
        const payload = { chat_id: 1, media: { toJSON: (): object => ({ document: new InputFile(Buffer.from("font")) }) } };

        expect(() => serialize("sendDocument", payload))
            .to.throw(UnsupportedInputFile)
            .with.deep.property("payload", { method: "sendDocument", path: "media.document" });
    });

    it("unwraps a boxed primitive, as JSON does", function () {
        const payload = {
            chat_id: 1,
            text: new String("hi"),
            offset: new Number(1),
            protect_content: new Boolean(false),
        };

        expect(serialize("sendMessage", payload)).to.deep.equal({ chat_id: 1, text: "hi", offset: 1, protect_content: false });
    });

    for (const [name, big] of [
        ["a bigint", 1n],
        ["a boxed bigint", Object(1n) as object],
    ] as Array<[string, unknown]>) {
        it(`rejects ${name}, which JSON cannot write`, function () {
            expect(() => serialize("sendMessage", { chat_id: 1, offset: big }))
                .to.throw(UnsupportedBigInt, "sendMessage got a bigint at offset")
                .with.deep.property("payload", { method: "sendMessage", path: "offset" });
        });
    }

    it("takes a file toJSON() returns as a file", function () {
        const stored = serialize("sendDocument", { chat_id: 1, document: { toJSON: (): InputFile => new PathFile("/data/a.ttf") } });

        expect(stored["document"]).to.deep.equal({ $pathFile: { path: "/data/a.ttf", filename: "a.ttf" } });
        expect(() => serialize("sendDocument", { chat_id: 1, document: { toJSON: (): InputFile => new InputFile(Buffer.from("font")) } }))
            .to.throw(UnsupportedInputFile)
            .with.deep.property("payload", { method: "sendDocument", path: "document" });
    });

    it("stores a class instance by its own keys, as JSON does", function () {
        const keyboard = new InlineKeyboard().text("ok", "ok");

        const serialized = serialize("sendMessage", { chat_id: 1, reply_markup: keyboard });

        expect(serialized["reply_markup"]).to.deep.equal(JSON.parse(JSON.stringify(keyboard)));
    });

    it("stores an object shared by two places of the payload in both", function () {
        const entity = { type: "bold", offset: 0, length: 5 };

        const serialized = serialize("sendMessage", { chat_id: 1, entities: [entity, entity] });

        expect(serialized["entities"]).to.deep.equal([entity, entity]);
    });

    describe("rejects an object that already carries the marker key, naming the method and the place", function () {
        const payloads: Array<[string, () => object, string]> = [
            [
                "in media[]",
                (): object => ({ chat_id: 1, media: [{ type: "document", media: { $pathFile: { path: "/etc/passwd" } } }] }),
                "media.0.media",
            ],
            ["at the root", (): object => ({ chat_id: 1, $pathFile: { path: "/etc/passwd" } }), "the root"],
            [
                "in a class instance",
                (): object => ({ chat_id: 1, media: new Holder({ $pathFile: { path: "/etc/passwd" } }) }),
                "media.item",
            ],
            [
                "in an object without a prototype",
                (): object => Object.assign(Object.create(null) as object, { $pathFile: { path: "/etc/passwd" } }),
                "the root",
            ],
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
            ["U+0000 in what toJSON() returns", (): object => ({ chat_id: 1, caption: { toJSON: (): string => "\u0000" } }), "caption"],
            ["U+0000 in a boxed string", (): object => ({ chat_id: 1, caption: new String("\u0000") }), "caption"],
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

    describe("rejects a payload that refers back to itself", function () {
        it("through an object", function () {
            const payload: Record<string, unknown> = { chat_id: 1 };
            payload["reply_markup"] = { self: payload };

            expect(() => serialize("sendMessage", payload))
                .to.throw(CyclicPayload, "sendMessage got a payload that refers back to itself at reply_markup.self")
                .with.deep.property("payload", { method: "sendMessage", path: "reply_markup.self" });
        });

        it("through an array", function () {
            const media: unknown[] = [];
            media.push(media);

            expect(() => serialize("sendMediaGroup", { chat_id: 1, media: media }))
                .to.throw(CyclicPayload)
                .with.deep.property("payload", { method: "sendMediaGroup", path: "media.0" });
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

        it("inside a class instance", function () {
            const payload = { chat_id: 1, document: new Holder(new InputFile(Buffer.from("font"))) };

            expect(() => serialize("sendDocument", payload))
                .to.throw(UnsupportedInputFile)
                .with.deep.property("payload", { method: "sendDocument", path: "document.item" });
        });

        it("inside an object without a prototype", function () {
            const payload = Object.assign(Object.create(null) as object, { chat_id: 1, document: new InputFile(Buffer.from("font")) });

            expect(() => serialize("sendDocument", payload))
                .to.throw(UnsupportedInputFile)
                .with.deep.property("payload", { method: "sendDocument", path: "document" });
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
