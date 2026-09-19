import type { Dayjs } from "dayjs";

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
