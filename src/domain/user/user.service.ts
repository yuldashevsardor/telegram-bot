import { inject, injectable } from "inversify";
import { UserRepository } from "app/domain/user/user.repository";
import { Services } from "app/infrastructure/container/symbols/services";
import { CreateUserDto, EditUserDto } from "app/domain/user/user.types";
import { User } from "app/domain/user/user";
import dayjs from "dayjs";
import { UserCreateError, UserEditError } from "app/domain/user/user.errors";

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
            await this.repository.save(user);
        } catch (error) {
            throw new UserCreateError({
                message: "Error in create user",
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

        try {
            await this.repository.save(user);
        } catch (error) {
            throw new UserEditError({
                message: "Error in edit user",
                payload: {
                    dto: dto,
                    error: error,
                },
            });
        }

        return user;
    }
}
