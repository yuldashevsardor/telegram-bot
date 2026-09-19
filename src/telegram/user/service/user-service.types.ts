import type { UserDto } from "app/telegram/user/user.types";

export type CreateUserDto = Pick<UserDto, "id" | "firstname" | "lastname" | "username" | "isBot">;

export type EditUserDto = Partial<Pick<UserDto, "firstname" | "lastname" | "username" | "isBot" | "lastActiveTime">>;
