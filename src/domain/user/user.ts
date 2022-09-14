import dayjs, { Dayjs } from "dayjs";
import { UserDto } from "app/domain/user/user.types";

export class User {
    readonly #id: number;

    #firstname: string;
    #lastname: string;
    #username: string;
    #isBot: boolean;
    #lastActiveTime: Dayjs;
    readonly #createdTime: Dayjs;
    #updatedTime: Dayjs;

    public constructor(dto: UserDto) {
        this.#id = dto.id;
        this.#firstname = dto.firstname;
        this.#lastname = dto.lastname;
        this.#username = dto.username;
        this.#isBot = dto.isBot;
        this.#lastActiveTime = dto.lastActiveTime;
        this.#createdTime = dto.createdTime;
        this.#updatedTime = dto.updatedTime;
    }

    get id(): number {
        return this.#id;
    }

    get firstname(): string {
        return this.#firstname;
    }

    set firstname(value: string) {
        this.#firstname = value;
        this.toggleUpdatedTime();
    }

    get lastname(): string {
        return this.#lastname;
    }

    set lastname(value: string) {
        this.#lastname = value;
        this.toggleUpdatedTime();
    }

    get username(): string {
        return this.#username;
    }

    set username(value: string) {
        this.#username = value;
        this.toggleUpdatedTime();
    }

    get isBot(): boolean {
        return this.#isBot;
    }

    set isBot(value: boolean) {
        this.#isBot = value;
        this.toggleUpdatedTime();
    }

    get createdTime(): dayjs.Dayjs {
        return this.#createdTime;
    }

    get updatedTime(): Dayjs {
        return this.#updatedTime;
    }

    get lastActiveTime(): Dayjs {
        return this.#lastActiveTime;
    }

    set lastActiveTime(value: Dayjs) {
        this.#lastActiveTime = value;
        this.toggleUpdatedTime();
    }

    private toggleUpdatedTime(): void {
        this.#updatedTime = dayjs();
    }
}
