import fs from "fs";
import fsPromises from "fs/promises";
import * as dotenv from "dotenv";
import type { RawConfig } from "app/bootstrap/config/config-container.types";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/config-file-storage.errors";

// Файл поверх другого источника: значения файла перекрывают базовые, поэтому поменять на ходу
// можно и то, что пришло переменной окружения. Базовый источник приходит параметром, а не
// собирается внутри, иначе файловый источник повторял бы работу с process.env, а порядок
// наложения знал бы ещё и тот, кто их связывает.
export class ConfigFileStorage implements WatchableConfigStorage {
    private watching = false;

    // Интервал опроса в миллисекундах; ноль выключает наблюдение целиком.
    public constructor(private readonly base: ConfigStorage, private readonly filePath: string, private readonly watchInterval: number) {}

    public async load(): Promise<RawConfig> {
        return { ...(await this.base.load()), ...(await this.read()) };
    }

    public watch(onChanged: () => void): void {
        if (this.watchInterval === 0 || this.watching) {
            return;
        }

        this.watching = true;

        // Опрос по stat, а не fs.watch: приложение работает в контейнере с bind-mount, где
        // inotify-события с хоста не гарантированы, а сохранение редактора через временный файл
        // с переименованием уводит inode — с ним fs.watch теряет и сам файл, а опрос продолжает
        // видеть путь.
        fs.watchFile(this.filePath, { interval: this.watchInterval }, (current, previous) => {
            // На отсутствующем файле watchFile зовёт слушателя сразу после подписки, с нулями в
            // обоих снимках; сравнение отсекает этот вызов и смену одних прав, оставляя правку
            // содержимого, появление файла (mtime из нуля) и его удаление (mtime в ноль).
            if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
                return;
            }

            onChanged();
        });
    }

    // Без проверки флага: на пути, за которым никто не следит, unwatchFile ничего не делает, а
    // сброшенный флаг возвращает право завести опрос заново.
    public stop(): void {
        fs.unwatchFile(this.filePath);
        this.watching = false;
        this.base.stop();
    }

    // Отсутствие файла — не отказ: наблюдение начинается до его появления, а удаление возвращает
    // значения базовому источнику. Всё остальное (нет прав, путь оказался каталогом) — отказ:
    // молча подставленный пустой набор снял бы разом все значения файла.
    private async read(): Promise<RawConfig> {
        try {
            // dotenv.parse, а не dotenv.config(): тот пишет в process.env, то есть снимок правил
            // бы окружение процесса, а перечитывание видело бы собственные прошлые значения.
            return dotenv.parse(await fsPromises.readFile(this.filePath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return {};
            }

            throw ConfigFileUnreadable.byPath(this.filePath, error);
        }
    }
}
