import { inject, injectable } from "inversify";
import { UserRepository } from "App/Services/User/UserRepository";
import { Services } from "App/Config/Dependency/Symbols/Services";
import { CreateUserDto, EditUserDto } from "App/Services/User/Types";
import { User } from "App/Services/User/User";
import dayjs from "dayjs";
import { UserCreateError } from "App/Services/User/Errors";

@injectable()
export class UserService {
    public constructor(@inject<UserRepository>(Services.User.UserRepository) private readonly repository: UserRepository) {}

    public async create(dto: CreateUserDto): Promise<User> {
        const user = new User({
            id: dto.id,
            firstname: dto.firstname,
            lastname: dto.lastname,
            username: dto.username,
            isBot: dto.isBot,
            lastActiveTime: dayjs(),
            createdTime: dayjs(),
            updatedTime: dayjs(),
        });

        try {
            await this.repository.create(user);
        } catch (error) {
            throw new UserCreateError({
                message: "Error in create use",
                payload: {
                    dto: dto,
                    error: error,
                },
            });
        }

        return user;
    }

    public async edit(id: number, dto: EditUserDto): Promise<User> {
        const user = await this.repository.getById(id);

        if (dto.firstname !== undefined) {
            user.firstname = dto.firstname;
        }

        if (dto.lastname !== undefined) {
            user.lastname = dto.lastname;
        }

        if (dto.username !== undefined) {
            user.username = dto.username;
        }

        if (dto.isBot !== undefined) {
            user.isBot = dto.isBot;
        }

        if (dto.lastActiveTime !== undefined) {
            user.lastActiveTime = dto.lastActiveTime;
        }

        await this.repository.update(user);

        return user;
    }
}
