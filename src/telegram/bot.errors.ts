import { RuntimeError } from "app/shared/errors";
import type { Update } from "@grammyjs/types";

export class UpdateWithoutFrom extends RuntimeError {
    public static byUpdate(update: Update): UpdateWithoutFrom {
        return new UpdateWithoutFrom("Update without `from` reached the middleware chain.", {
            updateId: update.update_id,
        });
    }
}
