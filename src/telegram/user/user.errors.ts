import { RuntimeError } from "app/shared/errors";

export class UserNotFound extends RuntimeError {
    public static byId(id: number): UserNotFound {
        return new UserNotFound(`User wit id ${id} not found.`, {
            id: id,
        });
    }
}

export class UserCreateError extends RuntimeError {}

export class UserEditError extends RuntimeError {}
