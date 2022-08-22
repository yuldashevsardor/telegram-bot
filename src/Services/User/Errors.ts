import { RuntimeError } from "App/Common/Errors";
import { CreateUserDto } from "App/Services/User/Types";

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
