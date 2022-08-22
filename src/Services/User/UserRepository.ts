import { User } from "App/Services/User/User";

export interface UserRepository {
    getById(id: number): Promise<User>;

    existsById(id: number): Promise<boolean>;

    create(user: User): Promise<void>;

    update(user: User): Promise<void>;

    delete(id: number): Promise<void>;
}
