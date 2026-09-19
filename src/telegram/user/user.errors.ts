import { RuntimeError } from "app/shared/errors";

export class UserNotFound extends RuntimeError {
    public static byId(id: number): UserNotFound {
        return new UserNotFound(`User with id ${id} not found.`, {
            id: id,
        });
    }
}
