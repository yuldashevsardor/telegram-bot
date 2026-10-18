import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Extension } from "app/font-convertor/font-convertor.types";

@injectable()
export class SupportedFormats {
    // The order the bot lists the formats in, wherever it lists them (docs/product/cjm.md). A rank
    // per extension rather than an array: the compiler refuses an Extension left without a place.
    private static readonly RANK: Record<Extension, number> = {
        [Extension.TTF]: 0,
        [Extension.OTF]: 1,
        [Extension.WOFF]: 2,
        [Extension.WOFF2]: 3,
        [Extension.EOT]: 4,
        [Extension.SVG]: 5,
    };

    public constructor(@inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory) {}

    // From the pair matrix rather than spelled out in a text: otherwise what is promised to a person
    // drifts from what the domain can actually do.
    public toList(): Extension[] {
        const extensions = [...this.convertorFactory.getSupportedExtensions()];

        extensions.sort((left, right) => SupportedFormats.RANK[left] - SupportedFormats.RANK[right]);

        return extensions;
    }

    public toText(): string {
        return this.toList()
            .map((extension) => extension.toUpperCase())
            .join(", ");
    }
}
