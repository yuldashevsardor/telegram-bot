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
    public toText(): string {
        return this.toSortedText(this.convertorFactory.getSupportedExtensions());
    }

    // The formats a file is taken in, for the hint to a message that is not a file and the refusal
    // of an unsupported file: a refusal listing a format that is only a target would name the very
    // format it refuses. /start, /help and the description name every format, by toText().
    public toSourceText(): string {
        return this.toSortedText(this.convertorFactory.getSourceExtensions());
    }

    // The formats a file is taken in: a format that is only a target has no pair to start.
    public toSourceList(): Extension[] {
        return this.sort(this.convertorFactory.getSourceExtensions());
    }

    // The formats a file of `sourceExtension` is offered to convert into: its pairs alone.
    public toTargetList(sourceExtension: Extension): Extension[] {
        return this.sort(this.convertorFactory.getTargetExtensions(sourceExtension));
    }

    private toSortedText(extensions: Extension[]): string {
        return this.sort(extensions)
            .map((extension) => extension.toUpperCase())
            .join(", ");
    }

    private sort(extensions: Extension[]): Extension[] {
        const sortedExtensions = [...extensions];

        sortedExtensions.sort((left, right) => SupportedFormats.RANK[left] - SupportedFormats.RANK[right]);

        return sortedExtensions;
    }
}
