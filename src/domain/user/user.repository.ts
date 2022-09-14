import { User } from "app/domain/user/user";

export interface UserRepository {
    getById(id: number): Promise<User>;

    existsById(id: number): Promise<boolean>;

    save(user: User): Promise<void>;

    delete(id: number): Promise<void>;
}
