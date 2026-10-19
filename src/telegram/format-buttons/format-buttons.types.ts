// The command of a format button, the first part of its callback data `${command}:${format}`.
export enum FormatButtonCommand {
    Convert = "convert",
    Sent = "sent",
    Failed = "failed",
}

// The commands of a marked button: what a press has done to its format (docs/product/cjm.md,
// step 4). A press of a marked button converts nothing.
export type FormatMark = FormatButtonCommand.Sent | FormatButtonCommand.Failed;

// The callback data of a format button, split into its parts. The format is a target extension or
// FormatButtons.ALL_FORMATS, as the bot writes it, and whatever a client sent of its own.
export type FormatButtonData = { command: FormatButtonCommand; format: string };
