import { Dayjs } from "dayjs";

export type UserDto = {
    id: number;
    firstname: string;
    lastname: string;
    username: string;
    isBot: boolean;
    lastActiveTime: Dayjs;
    createdTime: Dayjs;
    updatedTime: Dayjs;
};

export type CreateUserDto = Pick<UserDto, "id" | "firstname" | "lastname" | "username" | "isBot">;

export type EditUserDto = Partial<Pick<UserDto, "firstname" | "lastname" | "username" | "isBot" | "lastActiveTime">>;
