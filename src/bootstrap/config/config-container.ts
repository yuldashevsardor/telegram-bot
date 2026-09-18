import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError } from "app/shared/errors";
import type {
    ConfigChangeListener,
    ConfigErrorListener,
    Paths,
    Unsubscribe,
    ValueByPath,
} from "app/bootstrap/config/config-container.types";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { isWatchableConfigStorage } from "app/bootstrap/config/storage/config-storage.helper";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/config-container.errors";

// Идущая пересборка одна на контейнер: параллельные гонялись бы за одно поле values, и порядок
// событий решала бы гонка. again — сигнал источника, пришедший за время этой пересборки: файл мог
// измениться уже после того, как снимок прочитан, поэтому за ней идёт ещё один проход. Все
// сигналы, пришедшие за время прохода, сливаются в один: снимок читается целиком, и следующий
// проход всё равно увидит последнее состояние источника. Промиса здесь нет: ждать пересборку
// некому — её единственный вход, сигнал источника, ничего не возвращает.
type Reloading = {
    again: boolean;
};

// Хранит значения и отдаёт их по пути; откуда они берутся и как проверяются, решают storage и
// builder. Сборка вынесена из конструктора в init(): источник может отдавать значения только
// асинхронно (vault), а конструктор ждать не умеет. Наблюдаемый источник сообщает об изменениях,
// и по его сигналу контейнер пересобирает значения тем же путём, что на старте, — так приоритет
// источников и разбор остаются в одном месте.
export class ConfigContainer<Values> {
    private values: Values | null = null;

    // Слушатели лежат по строке пути: сравнение отдаёт изменившиеся пути, а не ссылки на подписки.
    private readonly changeListeners = new Map<string, Set<ConfigChangeListener>>();
    private readonly errorListeners = new Set<ConfigErrorListener>();

    private reloading: Reloading | null = null;
    private stopped = false;

    public constructor(private readonly storage: ConfigStorage, private readonly builder: ConfigBuilder<Values>) {}

    public async init(): Promise<void> {
        this.values = this.builder.build(await this.storage.load());

        // Наблюдение включается здесь же, а не отдельным вызовом: отдельный можно забыть, и
        // конфигурация молча осталась бы на значениях старта. Источник, который об изменениях не
        // сообщает (env, фейки спек), просто не наблюдается.
        if (isWatchableConfigStorage(this.storage)) {
            this.storage.watch((): void => {
                void this.reload();
            });
        }
    }

    // Останавливает источник: опрос файла держал бы событийный цикл, а пересборка на
    // закрывающемся приложении никому не нужна. Идущая пересборка тоже отменяется: снимок она
    // уже читает, и без флага успела бы подменить значения под тем, кто их читает следом
    // (`Application.terminate()` берёт срок остановки строкой ниже).
    public stop(): void {
        this.stopped = true;

        this.storage.stop();
    }

    public get<Path extends Paths<Values> & string>(dottedPath: Path): ValueByPath<Values, Path> {
        const value = this.valueAt(this.currentValues(), dottedPath);

        // Путь проверен компилятором, поэтому сюда приводит не опечатка в нём, а расхождение
        // объявленной формы конфигурации с настоящей — необязательное поле, ставшее undefined.
        if (value === undefined) {
            throw new InvalidConfigError(`Invalid config "${dottedPath}"`, {
                path: dottedPath,
            });
        }

        // Приведение результата: обход по точкам компилятору не проследить, но путь он уже сверил
        // с Values, и ValueByPath выводит тип из того же места, откуда пришло значение.
        return value as ValueByPath<Values, Path>;
    }

    // Слушателя зовёт и изменение вложенного значения: подписка на "limits" срабатывает на правку
    // "limits.common.number", потому что изменившийся лист уведомляет ещё и все свои префиксы.
    // Сколько бы значений внутри поддерева ни изменилось, слушатель его пути получает один вызов.
    public onChange<Path extends Paths<Values> & string>(
        dottedPath: Path,
        listener: (newValue: ValueByPath<Values, Path>, oldValue: ValueByPath<Values, Path>) => void,
    ): Unsubscribe {
        // Хранится стёртым до строки и unknown, поэтому пара значений приводится здесь — по той же
        // причине, что и результат get(): путь компилятор сверил, а обход по нему не проследил.
        // Результат слушателя возвращается, а не отбрасывается: по объявлению он void, но в
        // рантайме это может быть промис асинхронного слушателя, и ловить его отказ нужно
        // вызывающему (call()).
        const stored: ConfigChangeListener = (newValue, oldValue): void =>
            listener(newValue as ValueByPath<Values, Path>, oldValue as ValueByPath<Values, Path>);

        const listeners = this.changeListeners.get(dottedPath) ?? new Set<ConfigChangeListener>();

        listeners.add(stored);
        this.changeListeners.set(dottedPath, listeners);

        return (): void => {
            listeners.delete(stored);
        };
    }

    public onError(listener: ConfigErrorListener): Unsubscribe {
        this.errorListeners.add(listener);

        return (): void => {
            this.errorListeners.delete(listener);
        };
    }

    private reload(): void {
        if (this.stopped) {
            return;
        }

        const reloading = this.reloading;

        if (reloading !== null) {
            reloading.again = true;

            return;
        }

        // Stryker disable next-line ObjectLiteral: `{}` — эквивалентен: отсутствующее поле так же
        // ложно, как false, а проход цикла его и так перезаписывает перед следующей проверкой
        const started: Reloading = { again: false };

        this.reloading = started;

        // Отказа у прохода нет: rebuild() отправляет свои ошибки в канал ошибок, потому что
        // наверху колбэк наблюдателя — отказ оттуда стал бы unhandledRejection.
        void this.reloadUntilSettled(started);
    }

    // Состояние приходит параметром, а не читается из поля: поле обнуляет finally этой же
    // функции, то есть до её конца там лежит ровно этот объект, и проверка на null была бы
    // недостижимой ветвью.
    private async reloadUntilSettled(reloading: Reloading): Promise<void> {
        try {
            for (;;) {
                await this.rebuild();

                if (!reloading.again) {
                    return;
                }

                reloading.again = false;
            }
        } finally {
            this.reloading = null;
        }
    }

    // Значения подменяются целиком и только после сборки: отказ билдера оставляет рабочими
    // прежние, а не половину новых. Подменяются до рассылки — get() внутри слушателя обязан
    // отдавать уже новое значение. Отказ уходит в канал ошибок, а не наружу: наверху колбэк
    // наблюдателя, бросать там некуда.
    private async rebuild(): Promise<void> {
        try {
            const previous = this.currentValues();
            const raw = await this.storage.load();

            // Остановка могла прийти, пока читался снимок: подменять значения под тем, кто уже
            // закрывает приложение, нельзя.
            if (this.stopped) {
                return;
            }

            const current = this.builder.build(raw);

            this.values = current;

            this.notifyChanges(previous, current);
        } catch (error) {
            this.notifyError(error);
        }
    }

    private notifyChanges(previous: Values, current: Values): void {
        const changed = new Set<string>();

        this.collectChanges(previous, current, "", changed);

        for (const dottedPath of changed) {
            const listeners = this.changeListeners.get(dottedPath);

            if (listeners === undefined) {
                continue;
            }

            const newValue = this.valueAt(current, dottedPath);
            const oldValue = this.valueAt(previous, dottedPath);

            // Копия набора: слушатель вправе подписаться или отцепиться прямо в вызове, а обход
            // живого Set увидел бы добавленное и позвал бы его на том же изменении.
            for (const listener of [...listeners]) {
                this.call(listener, newValue, oldValue);
            }
        }
    }

    private call(listener: ConfigChangeListener, newValue: unknown, oldValue: unknown): void {
        try {
            // Слушатель объявлен возвращающим void, но асинхронную функцию компилятор в такой тип
            // пропускает: без catch её отказ дошёл бы до unhandledRejection и погасил процесс.
            const result: unknown = listener(newValue, oldValue);

            if (result instanceof Promise) {
                result.catch((error: unknown): void => {
                    this.notifyError(error);
                });
            }
        } catch (error) {
            // Упавший слушатель не отменяет рассылку остальным: они друг о друге не знают.
            this.notifyError(error);
        }
    }

    private notifyError(error: unknown): void {
        for (const listener of [...this.errorListeners]) {
            try {
                listener(error);
            } catch {
                // Отказ самого канала ошибок глушится: отправить его туда же значит уйти в
                // рекурсию, а бросить наружу — оборвать рассылку остальным и всплыть в колбэке
                // наблюдателя, откуда его никто не ждёт.
            }
        }
    }

    private currentValues(): Values {
        if (this.values === null) {
            throw new ConfigContainerIsNotInitialized("ConfigContainer is not initialized, call init() first.");
        }

        return this.values;
    }

    // Сравниваются листья: builder собирает новые объекты на каждой сборке, поэтому сравнение
    // поддеревьев по ссылке сообщало бы об изменении всего и на каждой пересборке. Конфигурация
    // вложенная (limits.common.number), поэтому обход рекурсивный; плоский только сырой снимок
    // источника.
    private collectChanges(previous: unknown, current: unknown, prefix: string, changed: Set<string>): void {
        if (this.isObject(previous) && this.isObject(current)) {
            for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
                this.collectChanges(previous[key], current[key], prefix === "" ? key : `${prefix}.${key}`, changed);
            }

            return;
        }

        if (previous === current) {
            return;
        }

        // Путь и все его префиксы: подписка на поддерево должна срабатывать на изменение внутри.
        // Набор, а не список: два изменившихся листа одного поддерева дают его путь один раз,
        // поэтому и слушатель поддерева зовётся один раз.
        let dottedPath = prefix;

        changed.add(dottedPath);

        while (dottedPath.includes(".")) {
            dottedPath = dottedPath.slice(0, dottedPath.lastIndexOf("."));

            changed.add(dottedPath);
        }
    }

    private valueAt(values: unknown, dottedPath: string): unknown {
        return dottedPath.split(".").reduce<unknown>((current, key) => {
            if (current === null || typeof current !== "object") {
                return undefined;
            }

            return (current as UnknownObject)[key];
        }, values);
    }

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    private isObject(value: unknown): value is UnknownObject {
        return value !== null && typeof value === "object";
    }
}
