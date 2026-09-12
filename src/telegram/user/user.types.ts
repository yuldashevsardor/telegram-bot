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

export type UserRow = {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    is_bot: boolean;
    last_active_time: Date;
    created_time: Date;
    updated_time: Date;
};

export type CreateUserDto = Pick<UserDto, "id" | "firstname" | "lastname" | "username" | "isBot">;

export type EditUserDto = Partial<Pick<UserDto, "firstname" | "lastname" | "username" | "isBot" | "lastActiveTime">>;
