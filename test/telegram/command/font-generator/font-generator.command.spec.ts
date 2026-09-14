import "reflect-metadata";
import { expect } from "chai";
import type { Context } from "app/telegram/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { FontConvertor } from "app/font-convertor/font-convertor";
import type { ConvertParams } from "app/font-convertor/font-convertor.types";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontGeneratorCommand } from "app/telegram/command/font-generator/font-generator.command";

type ErrorRecord = { message: string; payload: UnknownObject | undefined };

type Run = { events: string[]; originPaths: string[]; errors: ErrorRecord[] };

class ExposedFontGeneratorCommand extends FontGeneratorCommand {
    public run(ctx: Context): Promise<void> {
        return this.handle(ctx);
    }
}

async function run(failOn?: { extension: Extension; error: Error }): Promise<Run> {
    const result: Run = { events: [], originPaths: [], errors: [] };

    const convertor = {
        convert: async ({ originPath, extension }: ConvertParams): Promise<string> => {
            result.events.push(`convert ${extension}`);
            result.originPaths.push(originPath);

            if (failOn?.extension === extension) {
                throw failOn.error;
            }

            return `/result.${extension}`;
        },
    } as unknown as FontConvertor;

    const logger: Logger = {
        critical: () => undefined,
        error: (message: string, payload?: UnknownObject): void => {
            result.errors.push({ message: message, payload: payload });
        },
        warning: () => undefined,
        info: () => undefined,
        debug: () => undefined,
    };

    const ctx = {
        t: (key: string, args?: Record<string, unknown>): string => `${key} ${String(args?.["path"])}`,
        reply: async (text: string): Promise<void> => {
            result.events.push(`reply ${text}`);
        },
    } as unknown as Context;

    await new ExposedFontGeneratorCommand(convertor, logger, "/root").run(ctx);

    return result;
}

describe("FontGeneratorCommand", function () {
    it("converts the fixture to EOT, OTF, TTF and WOFF2, replying after each", async function () {
        const { events, errors } = await run();

        expect(events).to.deep.equal([
            "convert eot",
            "reply font-generator-result /result.eot",
            "convert otf",
            "reply font-generator-result /result.otf",
            "convert ttf",
            "reply font-generator-result /result.ttf",
            "convert woff2",
            "reply font-generator-result /result.woff2",
        ]);
        expect(errors).to.have.lengthOf(0);
    });

    it("takes the WOFF fixture under the root directory", async function () {
        const { originPaths } = await run();

        expect(new Set(originPaths)).to.deep.equal(new Set(["/root/test/fixtures/fonts/test-font.woff"]));
    });

    // Ошибка пользователю не видна: команда отладочная, след остаётся только в логе.
    it("stops at the first failure and only logs it", async function () {
        const error = new Error("fontforge failed");

        const { events, errors } = await run({ extension: Extension.OTF, error: error });

        expect(events).to.deep.equal(["convert eot", "reply font-generator-result /result.eot", "convert otf"]);
        expect(errors).to.deep.equal([{ message: "Font generation is failed.", payload: { cause: error } }]);
    });
});
