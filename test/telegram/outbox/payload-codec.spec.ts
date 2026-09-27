import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { expect } from "chai";
import { InputFile } from "grammy";
import { deserialize, serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import { InvalidFileMarker, ReservedFileKey, UnsupportedInputFile } from "app/telegram/outbox/payload-codec/payload-codec.errors";
import { PathFile } from "app/telegram/path-file";

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

    it("keeps undefined and values with a JSON form of their own as they are", function () {
        const date = new Date(0);
        const payload = { chat_id: 1, text: "hello", message_thread_id: undefined, date: date };

        const serialized = serialize("sendMessage", payload);

        expect(serialized).to.have.property("message_thread_id", undefined);
        expect(serialized["date"]).to.equal(date);
    });

    it("rejects an object that already carries the marker key, naming the method", function () {
        const payload = { chat_id: 1, media: [{ type: "document", media: { $pathFile: { path: "/etc/passwd" } } }] };

        expect(() => serialize("sendMediaGroup", payload))
            .to.throw(ReservedFileKey, "sendMediaGroup got an object with the key $pathFile")
            .with.deep.property("payload", { method: "sendMediaGroup", key: "$pathFile" });
    });

    it("rebuilds a marker without a file name, letting grammY take it from the path", function () {
        const restored = deserialize({ document: { $pathFile: { path: "/data/fonts/result.woff2" } } });

        expect((restored["document"] as PathFile).filename).to.equal("result.woff2");
    });

    describe("rejects a malformed file marker", function () {
        const markers: Array<[string, unknown]> = [
            ["null", null],
            ["a string", "/data/fonts/result.woff2"],
            ["no path", { filename: "result.woff2" }],
            ["a path that is not a string", { path: 42, filename: "result.woff2" }],
            ["a file name that is not a string", { path: "/data/fonts/result.woff2", filename: 42 }],
        ];

        for (const [name, marker] of markers) {
            it(`with ${name}`, function () {
                expect(() => deserialize({ chat_id: 1, media: [{ media: { $pathFile: marker } }] }))
                    .to.throw(InvalidFileMarker, "file marker")
                    .with.deep.property("payload", { marker: marker });
            });
        }
    });

    describe("rejects an InputFile that is not a PathFile, naming the method", function () {
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
                    .to.throw(UnsupportedInputFile, "sendDocument")
                    .with.deep.property("payload", { method: "sendDocument" });
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
                    { type: "document", media: new InputFile(Buffer.from("font")) },
                ],
            };

            expect(() => serialize("sendMediaGroup", payload)).to.throw(UnsupportedInputFile, "sendMediaGroup");
        });
    });
});

// The row is written and read through JSON, so the round trip goes through it as well.
function roundTrip(method: string, payload: object): Record<string, unknown> {
    return deserialize(JSON.parse(JSON.stringify(serialize(method, payload))) as Record<string, unknown>);
}
