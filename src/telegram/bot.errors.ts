import { RuntimeError } from "app/common/errors";
import { Update } from "@grammyjs/types";

export class UpdateWithoutFrom extends RuntimeError {
    public static byUpdate(update: Update): UpdateWithoutFrom {
        return new UpdateWithoutFrom("Update without `from` reached the middleware chain.", {
            updateId: update.update_id,
        });
    }
}
