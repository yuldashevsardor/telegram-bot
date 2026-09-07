import { RuntimeError } from "app/common/errors";
import { CreateUserDto } from "app/domain/user/user.types";

export class UserNotFound extends RuntimeError {
    public static byId(id: number): UserNotFound {
        return new UserNotFound(`User wit id ${id} not found.`, {
            id: id,
        });
    }
}

export class UserAlreadyExists extends RuntimeError {
    public static byCreateDto(dto: CreateUserDto): UserAlreadyExists {
        return new UserAlreadyExists("User already exists", {
            dto: dto,
        });
    }
}

export class UserCreateError extends RuntimeError {}

export class UserEditError extends RuntimeError {}
