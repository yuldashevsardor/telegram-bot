import fs from "fs";
import fsPromises from "fs/promises";
import * as dotenv from "dotenv";
import type { RawConfig } from "app/bootstrap/config/config-container.types";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/config-file-storage.errors";

// Файл под другим источником: заданное в базовом источнике перекрывает файл, поэтому поменять на
// ходу можно то, чего в нём нет (пустая переменная — это «нет»). Базовый источник приходит
// параметром, а не собирается внутри, иначе файловый источник повторял бы работу с process.env, а
// порядок наложения знал бы ещё и тот, кто их связывает.
export class ConfigFileStorage implements WatchableConfigStorage {
    private listener: ((current: fs.Stats, previous: fs.Stats) => void) | null = null;

    // Интервал опроса в миллисекундах.
    public constructor(private readonly base: ConfigStorage, private readonly filePath: string, private readonly watchInterval: number) {}

    public async load(): Promise<RawConfig> {
        // Базовый источник спрашивается первым: его снимок должен быть взят на входе в load(), а
        // не после чтения файла, иначе сборка увидела бы окружение, поменявшееся за время чтения.
        const base = await this.base.load();

        // Пустые значения базового источника не в счёт: ConfigParser всё равно считает их
        // отсутствием, а перекрывай они файл — переменная, объявленная в .env пустой (там так
        // объявлена половина), запрещала бы менять своё значение на ходу.
        return { ...(await this.read()), ...ConfigFileStorage.withoutBlanks(base) };
    }

    public watch(onChanged: () => void): void {
        if (this.listener !== null) {
            return;
        }

        this.listener = (current: fs.Stats, previous: fs.Stats): void => {
            // На отсутствующем файле watchFile зовёт слушателя сразу после подписки, с нулями в
            // обоих снимках; сравнение отсекает этот вызов и смену одних прав, оставляя правку
            // содержимого, появление файла (mtime из нуля) и его удаление (mtime в ноль).
            if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
                return;
            }

            onChanged();
        };

        // Опрос по stat, а не fs.watch: приложение работает в контейнере с bind-mount, где
        // inotify-события с хоста не гарантированы, а сохранение редактора через временный файл
        // с переименованием уводит inode — с ним fs.watch теряет и сам файл, а опрос продолжает
        // видеть путь.
        fs.watchFile(this.filePath, { interval: this.watchInterval }, this.listener);
    }

    // Снимается ровно свой слушатель: unwatchFile без него убрал бы с этого пути всех, включая
    // чужой экземпляр, который следит за тем же файлом. Сброшенная ссылка возвращает право
    // завести опрос заново.
    public unwatch(): void {
        if (this.listener === null) {
            return;
        }

        fs.unwatchFile(this.filePath, this.listener);
        this.listener = null;
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

    // Пустое значение значит «здесь ничего не задано», а не «задано пустым»: задать пустоту им
    // всё равно нельзя — ConfigParser считает её отсутствием и берёт умолчание. Поэтому пустая
    // строка не перекрывает ничего, с какой бы стороны наложения она ни пришла.
    private static withoutBlanks(parsed: RawConfig): RawConfig {
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined && value.trim() !== ""));
    }
}
