import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

/**
 * Пара с EOT, в которой участвуют оба: кодек снимает или надевает конверт, движок
 * переносит обводки. Между ними на диске остаётся промежуточный sfnt.
 */
export abstract class TwoStepEotConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontSignatureMatcher: FontSignatureMatcher,
        protected readonly eotPacker: EotPacker,
    ) {
        super(fontSignatureMatcher);
    }

    /**
     * Путь промежуточного sfnt: имя результата уникально в каталоге, значит уникально и
     * производное от него.
     */
    protected intermediatePath(newPath: string): string {
        return `${newPath}.${Extension.TTF}`;
    }

    /**
     * Прогоняет оба шага и убирает промежуточный файл — и после успеха, и после ошибки.
     * Уборка не идёт через `finally`: там её собственная ошибка вытеснила бы исходную, и
     * настоящей причины отказа не осталось бы даже в `cause`.
     */
    protected async throughIntermediate(sfntPath: string, steps: () => Promise<void>): Promise<void> {
        let failure: unknown;

        try {
            await steps();
        } catch (error) {
            failure = error;
        }

        try {
            await FileHelper.remove(sfntPath);
        } catch (error) {
            failure ??= error;
        }

        if (failure !== undefined) {
            throw failure;
        }
    }
}
