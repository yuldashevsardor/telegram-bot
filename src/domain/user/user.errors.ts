import { RuntimeError } from "app/common/errors";
import { CreateUserDto } from "app/domain/user/user.types";

export class UserNotFound extends RuntimeError {
    public static byId(id: number): UserNotFound {
        return new UserNotFound({
            message: `User wit id ${id} not found.`,
            payload: {
                id: id,
            },
        });
    }
}

export class UserAlreadyExists extends RuntimeError {
    public static byCreateDto(dto: CreateUserDto): UserAlreadyExists {
        return new UserAlreadyExists({
            message: "User already exists",
            payload: {
                dto: dto,
            },
        });
    }
}

export class UserCreateError extends RuntimeError {}

export class UserEditError extends RuntimeError {}
