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
import { isWatchableConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/config-container.errors";

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

    // Идущая пересборка и отметка, что источник просил ещё одну: параллельных пересборок быть не
    // должно — они гонялись бы за одно поле values, и порядок событий решала бы гонка.
    private reloading: Promise<void> | null = null;
    // Stryker disable next-line BooleanLiteral: `true` — эквивалентен: проход цикла гасит отметку у себя на входе, поэтому начальное значение поля до первой пересборки не доживает
    private reloadAgain = false;

    public constructor(private readonly storage: ConfigStorage, private readonly builder: ConfigBuilder<Values>) {}

    public async init(): Promise<void> {
        this.values = this.builder.build(await this.storage.load());
    }

    public get<Path extends Paths<Values> & string>(dottedPath: Path): ValueByPath<Values, Path> {
        const value = ConfigContainer.valueAt(this.currentValues(), dottedPath);

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

    // Включается явным вызовом, а не концом init(): пока логгер не подписан на onError, отказ
    // первой же пересборки было бы некуда написать. Источник без наблюдения (env, фейки спек) —
    // не ошибка: за process.env следить нечем.
    public watch(): void {
        if (!isWatchableConfigStorage(this.storage)) {
            return;
        }

        this.storage.watch((): void => {
            void this.reload();
        });
    }

    public unwatch(): void {
        if (!isWatchableConfigStorage(this.storage)) {
            return;
        }

        this.storage.unwatch();
    }

    // Промис накрывает все проходы, включая те, что добавились по дороге, и никогда не
    // отказывает: зовут её из колбэка наблюдателя, где отказ стал бы unhandledRejection.
    public reload(): Promise<void> {
        if (this.reloading !== null) {
            this.reloadAgain = true;

            return this.reloading;
        }

        this.reloading = this.reloadUntilSettled();

        return this.reloading;
    }

    private async reloadUntilSettled(): Promise<void> {
        try {
            // Сигналы, пришедшие во время пересборки, сливаются в один проход: снимок читается
            // целиком, поэтому следующий проход всё равно увидит последнее состояние источника.
            do {
                this.reloadAgain = false;

                await this.rebuild();
            } while (this.reloadAgain);
        } finally {
            this.reloading = null;
        }
    }

    // Значения подменяются целиком и только после сборки: отказ билдера оставляет рабочими
    // прежние, а не половину новых. Подменяются до рассылки — get() внутри слушателя обязан
    // отдавать уже новое значение.
    private async rebuild(): Promise<void> {
        try {
            const previous = this.currentValues();
            const current = this.builder.build(await this.storage.load());

            this.values = current;

            this.notifyChanges(previous, current);
        } catch (error) {
            this.notifyError(error);
        }
    }

    private notifyChanges(previous: Values, current: Values): void {
        const changed = new Set<string>();

        ConfigContainer.collectChanges(previous, current, "", changed);

        for (const dottedPath of changed) {
            const listeners = this.changeListeners.get(dottedPath);

            if (listeners === undefined) {
                continue;
            }

            const newValue = ConfigContainer.valueAt(current, dottedPath);
            const oldValue = ConfigContainer.valueAt(previous, dottedPath);

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
    // поддеревьев по ссылке сообщало бы об изменении всего и на каждой пересборке.
    private static collectChanges(previous: unknown, current: unknown, prefix: string, changed: Set<string>): void {
        if (ConfigContainer.isTree(previous) && ConfigContainer.isTree(current)) {
            for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
                ConfigContainer.collectChanges(previous[key], current[key], prefix === "" ? key : `${prefix}.${key}`, changed);
            }

            return;
        }

        if (previous === current) {
            return;
        }

        // Путь и все его префиксы: подписка на поддерево должна срабатывать на изменение внутри.
        let dottedPath = prefix;

        changed.add(dottedPath);

        while (dottedPath.includes(".")) {
            dottedPath = dottedPath.slice(0, dottedPath.lastIndexOf("."));

            changed.add(dottedPath);
        }
    }

    private static valueAt(values: unknown, dottedPath: string): unknown {
        return dottedPath.split(".").reduce<unknown>((current, key) => {
            if (current === null || typeof current !== "object") {
                return undefined;
            }

            return (current as UnknownObject)[key];
        }, values);
    }

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    private static isTree(value: unknown): value is UnknownObject {
        return value !== null && typeof value === "object";
    }
}
